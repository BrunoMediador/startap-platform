/**
 * billing_charges — ledger das cobrancas PIX geradas no gateway (ADR 0013, F1; ADR 0014).
 *
 * Modelo legado (flag BILLING_DUE_DATE_MODEL OFF): 1 cobranca por (slot, ciclo='YYYY-MM'),
 * idempotencia via UNIQUE (slot, cycle) no banco. Funcoes: getCharge,
 * insertPendingChargeIfAbsent, attachGatewayData, reissueGatewayData (por (slot,cycle)).
 *
 * Modelo por DATA DE VENCIMENTO (flag ON, ADR 0014): `cycle` guarda o due_period
 * 'YYYY-MM-DD'; o UNIQUE foi removido (migration 043); a "cobranca ativa do slot" e a
 * `pending` nao-expirada mais recente; a invariante "1 pending/slot" e transacional
 * (withBillingSlotLock + recheck). Funcoes: getActivePendingCharge, insertPendingCharge,
 * attachGatewayDataById, reissueGatewayDataById (por `id`).
 *
 * amount_cents e SNAPSHOT congelado no momento da geracao (vale nos dois modelos).
 *
 * Este modulo so persiste/le. A orquestracao (chamar AbacatePay + gravar) vive no
 * servico em @startap/integrations/abacatepay (que ja depende deste package).
 *
 * `slot` e a tenant key — entra no escopo da futura RLS (divida P0, ver migration 041).
 */
import type { PoolClient } from 'pg';
import { pool, query } from '../client.js';

export type ChargeStatus = 'pending' | 'paid' | 'expired' | 'cancelled';

export interface BillingChargeRow {
  id: string; // BIGSERIAL — pg retorna BIGINT como string
  slot: string;
  cycle: string; // legado 'YYYY-MM'; modelo novo (ADR 0014) due_period 'YYYY-MM-DD'
  external_id: string;
  abacate_charge_id: string | null;
  amount_cents: number; // snapshot congelado
  paid_amount_cents: number | null;
  status: ChargeStatus;
  br_code: string | null;
  br_code_base64: string | null;
  expires_at: Date | null;
  paid_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id::text AS id, slot, cycle, external_id, abacate_charge_id,
  amount_cents, paid_amount_cents, status, br_code, br_code_base64,
  expires_at, paid_at, created_at, updated_at`;

/** Le a cobranca de um (slot, ciclo). null se nao existe. */
export async function getCharge(slot: string, cycle: string): Promise<BillingChargeRow | null> {
  const r = await query<BillingChargeRow>(
    `SELECT ${COLUMNS} FROM billing_charges WHERE slot = $1 AND cycle = $2`,
    [slot, cycle],
  );
  return r.rows[0] ?? null;
}

/** Lista cobrancas de um slot (mais recentes primeiro). Painel/portal nas fases seguintes. */
export async function listChargesBySlot(slot: string): Promise<BillingChargeRow[]> {
  const r = await query<BillingChargeRow>(
    `SELECT ${COLUMNS} FROM billing_charges WHERE slot = $1
     ORDER BY cycle DESC, id DESC`,
    [slot],
  );
  return r.rows;
}

/**
 * Insere a linha da cobranca em estado 'pending' SE ainda nao existir (slot, cycle).
 * Retorna { row, created }: created=false quando o UNIQUE ja barrou (idempotencia).
 *
 * amount_cents e o snapshot do ciclo (vem de client_billing.amount_cents no momento
 * da geracao). external_id = "{slot}-{cycle}".
 */
export async function insertPendingChargeIfAbsent(input: {
  slot: string;
  cycle: string;
  externalId: string;
  amountCents: number;
}): Promise<{ row: BillingChargeRow; created: boolean }> {
  // Dual-write tenant_id (ADR 0018, Fase 2): subselect inline em flow_clones —
  // resolve NULL sozinho p/ slot sem clone, nunca derruba o INSERT. Não-quente.
  const ins = await query<BillingChargeRow>(
    `INSERT INTO billing_charges (slot, cycle, external_id, amount_cents, status, tenant_id)
     VALUES ($1, $2, $3, $4, 'pending', (SELECT tenant_id FROM flow_clones WHERE slot = $1))
     ON CONFLICT (slot, cycle) DO NOTHING
     RETURNING ${COLUMNS}`,
    [input.slot, input.cycle, input.externalId, input.amountCents],
  );
  if (ins.rows[0]) {
    return { row: ins.rows[0], created: true };
  }
  // Conflito: ja existe. Le e retorna a existente (idempotencia).
  const existing = await getCharge(input.slot, input.cycle);
  if (!existing) {
    // Corrida rara: foi deletada entre o INSERT e o SELECT. Trata como falha clara.
    throw new Error(
      `billing_charges: ON CONFLICT mas linha ausente para ${input.slot}/${input.cycle}`,
    );
  }
  return { row: existing, created: false };
}

/**
 * Preenche os dados retornados pelo gateway na linha ja criada (apos createPixCharge).
 * Idempotente por (slot, cycle). Nao avanca vencimento — isso e F2 (webhook PAID).
 */
export async function attachGatewayData(input: {
  slot: string;
  cycle: string;
  abacateChargeId: string;
  brCode: string;
  brCodeBase64: string;
  expiresAt: Date | null;
}): Promise<BillingChargeRow | null> {
  const r = await query<BillingChargeRow>(
    `UPDATE billing_charges
     SET abacate_charge_id = $3,
         br_code           = $4,
         br_code_base64    = $5,
         expires_at        = $6,
         updated_at        = NOW()
     WHERE slot = $1 AND cycle = $2
     RETURNING ${COLUMNS}`,
    [
      input.slot,
      input.cycle,
      input.abacateChargeId,
      input.brCode,
      input.brCodeBase64,
      input.expiresAt,
    ],
  );
  return r.rows[0] ?? null;
}

/**
 * REEMITE a cobranca PIX REUSANDO a MESMA linha (slot, cycle): sobrescreve os dados do
 * gateway (novo abacate_charge_id, br_code, validade) e volta status='pending'. Usado
 * quando o PIX anterior EXPIROU (ADR 0013, edge case "PIX expirado").
 *
 * Diferenca pra attachGatewayData: aqui FORCAMOS status='pending' (a linha pode estar
 * 'expired'/'pending' vencido) e o WHERE exige status != 'paid' — uma cobranca ja paga
 * NUNCA e reescrita por reemissao (invariante de seguranca C2). Nao avanca vencimento.
 *
 * Retorna null se a linha nao existe OU ja esta paga (nenhuma reescrita aconteceu).
 */
export async function reissueGatewayData(input: {
  slot: string;
  cycle: string;
  abacateChargeId: string;
  brCode: string;
  brCodeBase64: string;
  expiresAt: Date | null;
}): Promise<BillingChargeRow | null> {
  const r = await query<BillingChargeRow>(
    `UPDATE billing_charges
     SET abacate_charge_id = $3,
         br_code           = $4,
         br_code_base64    = $5,
         expires_at        = $6,
         status            = 'pending',
         updated_at        = NOW()
     WHERE slot = $1 AND cycle = $2 AND status <> 'paid'
     RETURNING ${COLUMNS}`,
    [
      input.slot,
      input.cycle,
      input.abacateChargeId,
      input.brCode,
      input.brCodeBase64,
      input.expiresAt,
    ],
  );
  return r.rows[0] ?? null;
}

// ─── Modelo por DATA DE VENCIMENTO (ADR 0014) ──────────────────────────────────
// A identidade da cobranca deixa de ser (slot, cycle='YYYY-MM') com UNIQUE. A
// "cobranca ativa do slot" passa a ser a `pending` NAO-EXPIRADA mais recente (id DESC).
// A invariante "no maximo 1 pending valida por slot" e garantida por ADVISORY LOCK +
// recheck na transacao de geracao (withBillingSlotLock), nao por indice de banco.
// As funcoes abaixo chaveiam por `id` (nao por (slot, cycle)). As legadas acima
// (getCharge/insertPendingChargeIfAbsent/attach/reissue por (slot,cycle)) ficam
// INTACTAS para o caminho com a flag BILLING_DUE_DATE_MODEL OFF.

/**
 * Roda `fn` numa transacao segurando pg_advisory_xact_lock por slot. Serializa a
 * geracao de cobranca do mesmo slot (duas abas/dois cliques) — o lock e liberado no
 * COMMIT/ROLLBACK (xact). O `hashtext('billing:'||slot)` da uma chave estavel por slot.
 *
 * `fn` recebe o PoolClient da transacao — todas as queries de geracao DEVEM usa-lo
 * (e nao o `query` global) pra rodar sob o lock.
 */
export async function withBillingSlotLock<T>(
  slot: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock por slot (escopo da transacao). hashtext -> int4; bigint p/ caber sem warning.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('billing:' || $1)::bigint)", [slot]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Cobranca ATIVA do slot (ADR 0014): a `pending` NAO-EXPIRADA mais recente. "Nao
 * expirada" = expires_at NULL (validade desconhecida — pode precisar reemitir) OU no
 * futuro relativo a `now`. ORDER BY id DESC LIMIT 1. null se nao houver.
 *
 * Aceita um PoolClient opcional pra rodar DENTRO da transacao do advisory lock (recheck
 * sob o lock). Sem client, usa o pool global (leitura fora de lock, ex.: GET /mensalidade).
 */
export async function getActivePendingCharge(
  slot: string,
  now: Date = new Date(),
  client?: PoolClient,
): Promise<BillingChargeRow | null> {
  const exec = client ? client.query.bind(client) : query;
  const r = await exec<BillingChargeRow>(
    `SELECT ${COLUMNS} FROM billing_charges
      WHERE slot = $1
        AND status = 'pending'
        AND (expires_at IS NULL OR expires_at > $2)
      ORDER BY id DESC
      LIMIT 1`,
    [slot, now],
  );
  return r.rows[0] ?? null;
}

/**
 * Insere uma linha NOVA de cobranca 'pending' (sem ON CONFLICT — a unicidade nao e mais
 * de banco). DEVE ser chamada sob withBillingSlotLock apos recheck de "nao ha pending
 * valida". `cycle` aqui guarda o due_period 'YYYY-MM-DD' (a next_due_date vigente).
 *
 * Recebe o PoolClient da transacao do lock — roda sob o advisory lock.
 */
export async function insertPendingCharge(
  client: PoolClient,
  input: {
    slot: string;
    cycle: string; // due_period 'YYYY-MM-DD'
    externalId: string;
    amountCents: number;
  },
): Promise<BillingChargeRow> {
  // Dual-write tenant_id (ADR 0018, Fase 2): subselect inline em flow_clones —
  // resolve NULL sozinho p/ slot sem clone, nunca derruba o INSERT. Não-quente.
  const r = await client.query<BillingChargeRow>(
    `INSERT INTO billing_charges (slot, cycle, external_id, amount_cents, status, tenant_id)
     VALUES ($1, $2, $3, $4, 'pending', (SELECT tenant_id FROM flow_clones WHERE slot = $1))
     RETURNING ${COLUMNS}`,
    [input.slot, input.cycle, input.externalId, input.amountCents],
  );
  return r.rows[0];
}

/**
 * Lista TODAS as cobrancas `pending` que ja tem abacate_charge_id (modelo novo, ADR 0014).
 * Usada pela RECONCILIACAO do cron F4 (rede de seguranca p/ webhook perdido): para cada
 * uma, o cron consulta o status no gateway e, se PAID, aplica o efeito do webhook.
 *
 * So `pending` com gateway (abacate_charge_id NOT NULL) — sem gateway nao ha o que
 * reconciliar. ORDER BY id pra ordem deterministica. `slot` continua a tenant key (RLS).
 */
export async function listPendingChargesWithGateway(): Promise<BillingChargeRow[]> {
  const r = await query<BillingChargeRow>(
    `SELECT ${COLUMNS} FROM billing_charges
      WHERE status = 'pending'
        AND abacate_charge_id IS NOT NULL
      ORDER BY id`,
  );
  return r.rows;
}

/**
 * Marca como 'expired' a cobranca `pending` cujo `expires_at` ja passou (higiene do
 * ledger — ADR 0014, F4 passo 3). Chaveia por `id` e exige status='pending' (NUNCA
 * mexe em 'paid'/'cancelled'). NAO deleta — a proxima geracao reusa/reemite a linha.
 * Retorna a linha atualizada, ou null se nada casou (ja nao era pending vencida).
 */
export async function markChargeExpired(
  id: string,
  now: Date = new Date(),
): Promise<BillingChargeRow | null> {
  const r = await query<BillingChargeRow>(
    `UPDATE billing_charges
        SET status     = 'expired',
            updated_at = NOW()
      WHERE id = $1
        AND status = 'pending'
        AND expires_at IS NOT NULL
        AND expires_at < $2
      RETURNING ${COLUMNS}`,
    [id, now],
  );
  return r.rows[0] ?? null;
}

/**
 * Preenche os dados do gateway numa linha ja criada, chaveando por `id` (modelo novo).
 * Espelha attachGatewayData mas por id (a identidade nao e mais (slot,cycle)).
 * Recebe o client da transacao do lock.
 */
export async function attachGatewayDataById(
  client: PoolClient,
  input: {
    id: string;
    abacateChargeId: string;
    brCode: string;
    brCodeBase64: string;
    expiresAt: Date | null;
  },
): Promise<BillingChargeRow | null> {
  const r = await client.query<BillingChargeRow>(
    `UPDATE billing_charges
        SET abacate_charge_id = $2,
            br_code           = $3,
            br_code_base64    = $4,
            expires_at        = $5,
            updated_at        = NOW()
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [input.id, input.abacateChargeId, input.brCode, input.brCodeBase64, input.expiresAt],
  );
  return r.rows[0] ?? null;
}

/**
 * REEMITE reusando a MESMA linha (modelo novo), chaveando por `id`: novo abacate_charge_id/
 * br_code/validade, status volta 'pending'. WHERE exige status <> 'paid' (nunca reescreve
 * cobranca paga — invariante C2). Recebe o client da transacao do lock.
 */
export async function reissueGatewayDataById(
  client: PoolClient,
  input: {
    id: string;
    abacateChargeId: string;
    brCode: string;
    brCodeBase64: string;
    expiresAt: Date | null;
  },
): Promise<BillingChargeRow | null> {
  const r = await client.query<BillingChargeRow>(
    `UPDATE billing_charges
        SET abacate_charge_id = $2,
            br_code           = $3,
            br_code_base64    = $4,
            expires_at        = $5,
            status            = 'pending',
            updated_at        = NOW()
      WHERE id = $1 AND status <> 'paid'
      RETURNING ${COLUMNS}`,
    [input.id, input.abacateChargeId, input.brCode, input.brCodeBase64, input.expiresAt],
  );
  return r.rows[0] ?? null;
}
