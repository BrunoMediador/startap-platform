/**
 * billing_charges — ledger das cobrancas PIX geradas no gateway (ADR 0013, F1; ADR 0014).
 *
 * Modelo legado (flag BILLING_DUE_DATE_MODEL OFF): 1 cobranca por (slot, ciclo='YYYY-MM'),
 * idempotencia via advisory lock + recheck transacional. A migration 043 removeu o UNIQUE
 * (slot, cycle), portanto o caminho legado tambem usa withBillingSlotLock e updates por id.
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

/** Outro processo ja gera uma cobranca para o slot; o caller deve tentar novamente. */
export class BillingSlotBusyError extends Error {
  constructor(readonly slot: string) {
    super('billing slot busy');
    this.name = 'BillingSlotBusyError';
  }
}

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
  /**
   * abacate_charge_id ANTIGOS abandonados por reemissao ANTECIPADA (SCRUM-141). Cada
   * reissue* sobrescreve abacate_charge_id (QR novo) e faz APPEND do id anterior aqui —
   * o QR velho segue pagavel no gateway. A reconciliacao do cron F4 polla estes ids
   * (getChargeStatus) pra fechar o caso "QR velho pago + webhook PERDIDO". '{}' por padrao.
   */
  superseded_charge_ids: string[];
  /**
   * Estado da chamada ao gateway (SCRUM-173, migration 081): 'idle' (nenhuma chamada em
   * curso ou nunca iniciada), 'calling' (POST em voo — commitado ANTES do efeito externo,
   * sobrevive a um rollback se o processo morrer/perder a resposta), 'done' (attach
   * concluido). Ve outboxState() no service pra decisao de reuso/bloqueio.
   */
  gateway_call_state: 'idle' | 'calling' | 'done';
  /** Quando a chamada 'calling' comecou. null se 'idle'/'done'. Base do timeout de ambiguidade. */
  gateway_call_started_at: Date | null;
}

const COLUMNS = `id::text AS id, slot, cycle, external_id, abacate_charge_id,
  amount_cents, paid_amount_cents, status, br_code, br_code_base64,
  expires_at, paid_at, created_at, updated_at,
  COALESCE(superseded_charge_ids, '{}') AS superseded_charge_ids,
  gateway_call_state, gateway_call_started_at`;

/** Le deterministicamente a cobranca mais recente de um (slot, ciclo). */
export async function getCharge(
  slot: string,
  cycle: string,
  client?: PoolClient,
): Promise<BillingChargeRow | null> {
  const exec = client ? client.query.bind(client) : query;
  const r = await exec<BillingChargeRow>(
    `SELECT ${COLUMNS} FROM billing_charges
      WHERE slot = $1 AND cycle = $2
      ORDER BY id DESC
      LIMIT 1`,
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
 * Compatibilidade para callers legados: serializa e faz recheck sem depender do UNIQUE
 * removido pela migration 043. O fluxo completo de gateway deve preferir manter o mesmo
 * withBillingSlotLock aberto ate a persistencia final (ensurePixChargeForCycle).
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
  return withBillingSlotLock(input.slot, async (client) => {
    const existing = await getCharge(input.slot, input.cycle, client);
    if (existing) return { row: existing, created: false };
    const row = await insertPendingCharge(client, input);
    return { row, created: true };
  });
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
 *
 * SCRUM-141: preserva o abacate_charge_id ANTIGO em superseded_charge_ids (append idempotente)
 * — o QR velho segue pagavel e a reconciliacao do cron F4 precisa saber pollar por ele. Na
 * clausula SET, a referencia a abacate_charge_id no RHS usa o valor ANTIGO da linha (semantica
 * do UPDATE do Postgres); $3 e o NOVO id.
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
     SET superseded_charge_ids = CASE
           WHEN abacate_charge_id IS NOT NULL
            AND abacate_charge_id <> $3
            AND NOT (abacate_charge_id = ANY (COALESCE(superseded_charge_ids, '{}')))
           THEN array_append(COALESCE(superseded_charge_ids, '{}'), abacate_charge_id)
           ELSE COALESCE(superseded_charge_ids, '{}')
         END,
         abacate_charge_id = $3,
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
// As funcoes abaixo chaveiam por `id` (nao por (slot, cycle)) e sao compartilhadas
// pelos dois modelos para nunca atualizar ambiguamente duplicatas historicas.

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
  let discardClient = false;
  try {
    await client.query('BEGIN');
    // Try-lock fail-fast: outra instancia nao pode ocupar uma conexao do pool aguardando
    // o gateway da primeira. A single-flight local absorve concorrencia do mesmo processo.
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('billing:' || $1)::bigint) AS locked",
      [slot],
    );
    if (!lock.rows[0]?.locked) throw new BillingSlotBusyError(slot);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Transacao/conexao de estado desconhecido nunca volta ao pool.
      discardClient = true;
    }
    throw e;
  } finally {
    client.release(discardClient);
  }
}

/**
 * Cobranca ATIVA do slot (ADR 0014): a `pending` NAO-EXPIRADA mais recente **e efetivamente
 * PAGAVEL** (`br_code IS NOT NULL`). ORDER BY id DESC LIMIT 1. null se nao houver.
 *
 * LEITURA DE PRODUTO (ADR 0039, SCRUM-173 F1): esta e a funcao que o PORTAL usa pra decidir
 * o que mostrar ao cliente (GET /mensalidade). Antes do fix, uma linha presa em
 * gateway_call_state='calling' (outbox em voo/orfao — sem br_code, sem QR) casava aqui e
 * era devolvida como "cobranca pendente" sem QR: o cliente via um estado sem saida, sem
 * conseguir pagar, e com BILLING_OVERDUE_SILENCE + GRACE_DAYS=3 o bot dele calava no 4o
 * dia — regressao liquida pior que a duplicacao rara que o outbox resolve. `br_code IS NOT
 * NULL` restringe a leitura de produto a cobranca REALMENTE pagavel. A leitura usada pela
 * GERACAO (que precisa enxergar a linha orfa pra reaproveitar em vez de duplicar) e outra
 * funcao: `getResumableChargeForSlot`.
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
        AND br_code IS NOT NULL
        AND (expires_at IS NULL OR expires_at > $2)
      ORDER BY id DESC
      LIMIT 1`,
    [slot, now],
  );
  return r.rows[0] ?? null;
}

/**
 * Cobranca RESUMIVEL do slot (ADR 0039, SCRUM-173 F1): a `pending` NAO-EXPIRADA mais
 * recente, SEM exigir `br_code` (predicado ANTIGO de getActivePendingCharge, antes do
 * F1). LEITURA DE GERACAO — usada pela fase 1 de ensurePixChargeForSlot (sob o lock) pra
 * decidir se reaproveita uma linha existente (inclusive uma orfa presa em
 * gateway_call_state='calling', sem br_code) em vez de inserir uma linha NOVA. E
 * exatamente essa reutilizacao que evita a segunda cobranca real no gateway — a mesma
 * linha e completada/reemitida, nunca duplicada.
 *
 * NUNCA usar esta funcao pra decidir o que mostrar ao cliente (isso e getActivePendingCharge).
 */
export async function getResumableChargeForSlot(
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
  // Slot do subselect é parâmetro SEPARADO ($5) — não reusa $1 (evita
  // "inconsistent types deduced for parameter $1" entre os varchars de slot).
  const r = await client.query<BillingChargeRow>(
    `INSERT INTO billing_charges (slot, cycle, external_id, amount_cents, status, tenant_id)
     VALUES ($1, $2, $3, $4, 'pending', (SELECT tenant_id FROM flow_clones WHERE slot = $5))
     RETURNING ${COLUMNS}`,
    [input.slot, input.cycle, input.externalId, input.amountCents, input.slot],
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
 * Recebe o client da transacao do lock. Fecha o outbox (SCRUM-173): volta
 * gateway_call_state para 'done' — a chamada em curso terminou com sucesso.
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
        SET abacate_charge_id  = $2,
            br_code            = $3,
            br_code_base64     = $4,
            expires_at         = $5,
            gateway_call_state = 'done',
            updated_at         = NOW()
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [input.id, input.abacateChargeId, input.brCode, input.brCodeBase64, input.expiresAt],
  );
  return r.rows[0] ?? null;
}

/**
 * Outra chamada ao gateway ja esta em curso (timeout ambiguo) e ainda nao passou do
 * timeout de seguranca — o caller deve tratar como ocupado (mesmo contrato de
 * BillingSlotBusyError: 503 + Retry-After no portal, log+skip no cron).
 */
export class PixChargeGatewayInFlightError extends Error {
  constructor(
    readonly slot: string,
    readonly chargeId: string,
  ) {
    super('pix charge gateway call in flight');
    this.name = 'PixChargeGatewayInFlightError';
  }
}

/**
 * Timeout de ambiguidade (SCRUM-173): acima do timeout HTTP do client AbacatePay (15s,
 * REQUEST_TIMEOUT_MS em client.ts) com margem de seguranca — se passou disso desde
 * gateway_call_started_at, a chamada anterior esta DEFINITIVAMENTE morta (nunca mais
 * vai responder nesse processo) e uma nova tentativa e liberada. Constante compilada
 * (nao env), no padrao de GRACE_DAYS em client-billing.ts — mudar exige deploy. Passada
 * como PARAMETRO pro SQL de claimGatewayCall (fonte unica do numero), nunca hardcoded
 * no statement.
 */
export const GATEWAY_CALL_AMBIGUOUS_TIMEOUT_MS = 30_000;

/**
 * CLAIM ATOMICO da chamada ao gateway (ADR 0039, SCRUM-173 F2 — corrige TOCTOU real do
 * design anterior). O advisory lock (`withBillingSlotLock`) e `xact`-scoped: libera no
 * COMMIT da fase 1, ANTES do POST ao gateway. Entre um caller avaliar "posso chamar?" e
 * de fato marcar 'calling', o slot NAO esta protegido por lock nenhum — portal-api e
 * worker sao PROCESSOS SEPARADOS (o single-flight local e um Map in-process, nao os
 * coordena). Duas tentativas concorrentes (ex.: cron na hora cheia + clique do cliente)
 * podiam as duas passar um check "outboxCallAllowed" e as duas chamar o gateway —
 * reintroduzindo a duplicacao que o outbox existe pra evitar.
 *
 * O fix e um UPDATE condicional de UMA UNICA STATEMENT: o WHERE decide atomicamente se
 * a linha esta livre pra reivindicar, e o SET so aplica se a condicao bateu — Postgres
 * nao intercala duas UPDATE na MESMA linha (row-level lock implicito do proprio UPDATE).
 * 0 linhas afetadas = outro processo ja reivindicou (ou a linha esta 'paid') -> o CALLER
 * lanca PixChargeGatewayInFlightError.
 *
 * RELOGIO DO BANCO, nao do processo (P2 do QA): a comparacao de "passou do timeout de
 * ambiguidade" roda dentro do SQL com NOW() do Postgres — o UNICO relogio compartilhado
 * entre portal-api e worker (processos/instancias distintas podem ter clock skew entre
 * si). `GATEWAY_CALL_AMBIGUOUS_TIMEOUT_MS` continua sendo a fonte unica do numero, so que
 * passado como parametro pro SQL em vez de comparado em JS.
 *
 * Duas clausulas OBRIGATORIAS no WHERE (nao sao apenas otimizacao):
 *   - `gateway_call_started_at IS NULL` -> sem isso, uma linha que virou 'calling' sem
 *     timestamp gravado (nunca deveria acontecer, mas e estado alcancavel por bug futuro)
 *     trava PARA SEMPRE — a comparacao com NOW() nunca "vence" contra NULL.
 *   - `status <> 'paid'` -> nunca reivindica uma chamada ao gateway pra uma cobranca JA
 *     PAGA (nao ha por que rechamar o gateway pra uma linha que ja foi creditada).
 *
 * Retorna a linha atualizada (claim conseguido) ou null (perdeu a corrida).
 */
export async function claimGatewayCall(
  client: PoolClient,
  id: string,
  ambiguousTimeoutMs: number = GATEWAY_CALL_AMBIGUOUS_TIMEOUT_MS,
): Promise<BillingChargeRow | null> {
  const r = await client.query<BillingChargeRow>(
    `UPDATE billing_charges
        SET gateway_call_state      = 'calling',
            gateway_call_started_at = NOW(),
            updated_at              = NOW()
      WHERE id = $1
        AND status <> 'paid'
        AND (gateway_call_state <> 'calling'
             OR gateway_call_started_at IS NULL
             OR gateway_call_started_at < NOW() - ($2::int * INTERVAL '1 millisecond'))
      RETURNING ${COLUMNS}`,
    [id, ambiguousTimeoutMs],
  );
  return r.rows[0] ?? null;
}

/**
 * REEMITE reusando a MESMA linha (modelo novo), chaveando por `id`: novo abacate_charge_id/
 * br_code/validade, status volta 'pending'. WHERE exige status <> 'paid' (nunca reescreve
 * cobranca paga — invariante C2). Recebe o client da transacao do lock.
 *
 * SCRUM-141: preserva o abacate_charge_id ANTIGO em superseded_charge_ids (append idempotente)
 * — este e o caminho da REEMISSAO ANTECIPADA (reissue-ahead), onde o QR velho segue pagavel
 * enquanto o cliente ja recebe o novo. A referencia a abacate_charge_id no RHS do SET usa o
 * valor ANTIGO da linha (semantica do UPDATE do Postgres); $2 e o NOVO id.
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
        SET superseded_charge_ids = CASE
              WHEN abacate_charge_id IS NOT NULL
               AND abacate_charge_id <> $2
               AND NOT (abacate_charge_id = ANY (COALESCE(superseded_charge_ids, '{}')))
              THEN array_append(COALESCE(superseded_charge_ids, '{}'), abacate_charge_id)
              ELSE COALESCE(superseded_charge_ids, '{}')
            END,
            abacate_charge_id  = $2,
            br_code            = $3,
            br_code_base64     = $4,
            expires_at         = $5,
            status             = 'pending',
            gateway_call_state = 'done',
            updated_at         = NOW()
      WHERE id = $1 AND status <> 'paid'
      RETURNING ${COLUMNS}`,
    [input.id, input.abacateChargeId, input.brCode, input.brCodeBase64, input.expiresAt],
  );
  return r.rows[0] ?? null;
}
