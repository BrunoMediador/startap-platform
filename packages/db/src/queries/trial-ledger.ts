/**
 * trial-ledger — trava anti trial-farming por número de WhatsApp (Missão 020 F1).
 *
 * Desenho: docs/missoes/020-onboarding-self-service.md.
 *  - O ledger guarda HMAC do E.164 canônico (NUNCA o número cru — LGPD).
 *  - Registro PERMANENTE e independente do clone (sem FK/cascade): deletar o
 *    clone NÃO apaga a linha — deletar+recriar não reseta trial.
 *  - O consumo acontece no 1º WORKING da sessão (prova de posse), nunca no
 *    cadastro. Soft check no signup é só cortesia de UX.
 *
 * Estado do trial do CLONE vive em flow_clones.trial_status
 * ('none'|'awaiting'|'active'|'blocked'|'exempt' — migration 044).
 */
import { pool, query } from '../client.js';
import { invalidateCloneCache } from './flow-clones.js';

export type TrialLedgerStatus = 'consumed' | 'exempt';
export type TrialStatus = 'none' | 'awaiting' | 'active' | 'blocked' | 'exempt';

export interface TrialLedgerRow {
  id: number;
  phone_hmac: string;
  phone_hint: string | null;
  status: TrialLedgerStatus;
  slot: string | null;
  consumed_at: Date | null;
  created_at: Date;
  notes: string | null;
}

/** Dias de teste grátis (decisão Bruno, Missão 020). */
export const TRIAL_DAYS = 10;

const LEDGER_COLS = 'id, phone_hmac, phone_hint, status, slot, consumed_at, created_at, notes';

function normalize(row: TrialLedgerRow & { id: string | number }): TrialLedgerRow {
  return { ...row, id: Number(row.id) };
}

/** Lookup exato pelo HMAC (soft check do signup + hard check do pareamento). */
export async function findByPhoneHmac(phoneHmac: string): Promise<TrialLedgerRow | null> {
  const r = await query<TrialLedgerRow & { id: string }>(
    `SELECT ${LEDGER_COLS} FROM trial_ledger WHERE phone_hmac = $1`,
    [phoneHmac],
  );
  return r.rows[0] ? normalize(r.rows[0]) : null;
}

/** Quantos números este slot já consumiu (troca de número: máx 2 por trial — doc 020). */
export async function countConsumedBySlot(slot: string): Promise<number> {
  const r = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM trial_ledger WHERE slot = $1 AND status = 'consumed'`,
    [slot],
  );
  return Number(r.rows[0]?.count ?? 0);
}

/**
 * Quantos trials estão SIMULTANEAMENTE vivos — teto anti-DoS de recurso do
 * signup (security review PR #268, item P0 #2): cada trial vivo = 1 sessão WAHA
 * (instância Baileys) consumindo RAM na VPS sem swap.
 *
 * Conta como "vivo" (modelo da migration 044):
 *  - awaiting => clone provisionado aguardando QR (sessão pendurada — pior caso);
 *  - blocked  => sessão pareada e viva, bot mudo (até PIX ou cleanup — card próprio);
 *  - active NÃO expirado => trial corrente (next_due_date NULL ou >= hoje UTC).
 * NÃO conta: none/exempt (não são trials) e active vencido (já convertido em
 * pagante ou silenciado pelo gate ADR-0016 — deixou de ser "trial pendente").
 */
export async function countActiveTrials(): Promise<number> {
  const r = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM flow_clones fc
     LEFT JOIN client_billing cb ON cb.slot = fc.slot
     WHERE fc.trial_status IN ('awaiting', 'blocked')
        OR (fc.trial_status = 'active'
            AND (cb.next_due_date IS NULL
                 OR cb.next_due_date >= (NOW() AT TIME ZONE 'utc')::date))`,
  );
  return Number(r.rows[0]?.count ?? 0);
}

/**
 * Serializa o processamento de trial por slot via advisory lock transacional
 * (security review PR #268: dois session.status WORKING concorrentes do mesmo
 * clone liam consumed=1 e ambos inseriam — estourava o "máx 2 números").
 *
 * Por que advisory e NÃO SELECT ... FOR UPDATE na row de flow_clones: os
 * helpers de escrita (startTrial/blockTrial/consumeAdditionalNumber) abrem as
 * PRÓPRIAS transações em conexões separadas e fazem UPDATE na mesma row — um
 * FOR UPDATE segurado aqui bloquearia essas escritas internas (self-deadlock
 * entre conexões do mesmo fluxo). O advisory xact lock serializa chamadas
 * CONCORRENTES sem conflitar com row locks internos.
 *
 * try-lock (não bloqueante): se outro evento do MESMO slot está em curso,
 * retorna { acquired: false } — o caller ignora o evento (WAHA reenvia
 * session.status e o hook é idempotente; retry-friendly por design).
 */
export async function withTrialSlotLock<T>(
  slot: string,
  fn: () => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; result: T }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext('trial:' || $1)) AS locked`,
      [slot],
    );
    if (!r.rows[0]?.locked) {
      await client.query('ROLLBACK');
      return { acquired: false };
    }
    const result = await fn();
    await client.query('COMMIT');
    return { acquired: true, result };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export interface TrialCloneInfo {
  slot: string;
  trial_status: TrialStatus;
  cliente_telefone: string | null;
  waha_sessao: string | null;
  next_due_date: string | null; // 'YYYY-MM-DD'
  amount_cents: number | null;
}

/**
 * Estado de trial do clone pela SESSÃO WAHA — leitura FRESH (sem o cache TTL do
 * flow-clones; o hook de pareamento é evento raro, não hot path).
 */
export async function getTrialInfoBySession(sessao: string): Promise<TrialCloneInfo | null> {
  const r = await query<TrialCloneInfo>(
    `SELECT fc.slot, fc.trial_status, fc.cliente_telefone, fc.waha_sessao,
            to_char(cb.next_due_date, 'YYYY-MM-DD') AS next_due_date,
            cb.amount_cents
     FROM flow_clones fc
     LEFT JOIN client_billing cb ON cb.slot = fc.slot
     WHERE fc.waha_sessao = $1
     LIMIT 1`,
    [sessao],
  );
  return r.rows[0] ?? null;
}

/** Marca o clone recém-provisionado como aguardando pareamento (signup F1). */
export async function setTrialAwaiting(slot: string): Promise<void> {
  await query(
    `UPDATE flow_clones SET trial_status = 'awaiting', updated_at = NOW() WHERE slot = $1`,
    [slot],
  );
  invalidateCloneCache({ slot });
}

/**
 * Inicia o trial no 1º WORKING (prova de posse) — transação única:
 *  1. INSERT no ledger (consumed). ON CONFLICT DO NOTHING => retry idempotente.
 *  2. client_billing.next_due_date = hoje (UTC) + TRIAL_DAYS, SÓ se ainda NULL
 *     (nunca reseta um trial já iniciado). amount_cents NÃO é tocado aqui — já
 *     nasce no signup (decisão Bruno: R$99,99 default).
 *  3. flow_clones: trial_status='active', status='conectado' e re-vínculo do
 *     cliente_telefone ao número REALMENTE pareado (fonte de verdade é quem
 *     pareou — doc 020; mantém o pairing-code da 019 consistente).
 */
export async function startTrial(input: {
  slot: string;
  phoneHmac: string;
  phoneHint: string;
  pairedPhone: string;
  trialDays?: number;
  notes?: string | null;
}): Promise<{ nextDueDate: string | null }> {
  const days = input.trialDays ?? TRIAL_DAYS;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO trial_ledger (phone_hmac, phone_hint, status, slot, consumed_at, notes)
       VALUES ($1, $2, 'consumed', $3, NOW(), $4)
       ON CONFLICT (phone_hmac) DO NOTHING`,
      [input.phoneHmac, input.phoneHint, input.slot, input.notes ?? null],
    );

    // Dual-write tenant_id (ADR 0018, Fase 2): subselect inline em flow_clones —
    // resolve NULL sozinho p/ slot sem clone, nunca derruba o upsert.
    const billing = await client.query<{ next_due_date: string }>(
      `INSERT INTO client_billing (slot, next_due_date, status, created_at, updated_at, tenant_id)
       VALUES ($1, (NOW() AT TIME ZONE 'utc')::date + $2::int, 'active', NOW(), NOW(),
               (SELECT tenant_id FROM flow_clones WHERE slot = $1))
       ON CONFLICT (slot) DO UPDATE SET
         next_due_date = COALESCE(client_billing.next_due_date,
                                  (NOW() AT TIME ZONE 'utc')::date + $2::int),
         updated_at    = NOW(),
         tenant_id     = COALESCE(client_billing.tenant_id, EXCLUDED.tenant_id)
       RETURNING to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date`,
      [input.slot, days],
    );

    await client.query(
      `UPDATE flow_clones
         SET trial_status = 'active',
             status = 'conectado',
             cliente_telefone = $2,
             updated_at = NOW()
       WHERE slot = $1`,
      [input.slot, input.pairedPhone],
    );

    await client.query('COMMIT');
    invalidateCloneCache({ slot: input.slot });
    return { nextDueDate: billing.rows[0]?.next_due_date ?? null };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Consome um número ADICIONAL no mesmo trial (troca de número durante o trial —
 * doc 020: permitido 1x; os dois números ficam queimados; os dias NÃO resetam).
 * Não toca next_due_date.
 */
export async function consumeAdditionalNumber(input: {
  slot: string;
  phoneHmac: string;
  phoneHint: string;
  pairedPhone: string;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO trial_ledger (phone_hmac, phone_hint, status, slot, consumed_at, notes)
       VALUES ($1, $2, 'consumed', $3, NOW(), 'troca de numero durante trial')
       ON CONFLICT (phone_hmac) DO NOTHING`,
      [input.phoneHmac, input.phoneHint, input.slot],
    );
    await client.query(
      `UPDATE flow_clones
         SET cliente_telefone = $2, status = 'conectado', updated_at = NOW()
       WHERE slot = $1`,
      [input.slot, input.pairedPhone],
    );
    await client.query('COMMIT');
    invalidateCloneCache({ slot: input.slot });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Bloqueia o trial: número pareado JÁ consumiu teste grátis em outro clone.
 * O bot NÃO ativa — silêncio via eixo manual (flow_enabled=false) com
 * suspended_kind='billing': pagar o PIX (AbacatePay) auto-reativa pelo caminho
 * que JÁ existe (billing-webhook-events C1) — CTA "Ativar meu plano" fecha o loop.
 * Também garante next_due_date (hoje, se NULL) para a janela de PIX abrir
 * (computeBillingState: vencido => podeGerarPix).
 */
export async function blockTrial(input: { slot: string; reason?: string }): Promise<void> {
  const reason = input.reason ?? 'trial: numero ja consumiu teste gratis';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE flow_clones
         SET trial_status = 'blocked',
             status = 'conectado',
             flow_enabled = false,
             suspended_reason = $2,
             suspended_at = NOW(),
             suspended_kind = 'billing',
             updated_at = NOW()
       WHERE slot = $1`,
      [input.slot, reason],
    );

    await client.query(
      `INSERT INTO flow_suspension_log (slot, action, reason, actor)
       VALUES ($1, 'suspend', $2, 'trial-hook')`,
      [input.slot, reason],
    );

    // Abre a janela de PIX: vencido hoje => podeGerarPix (ADR 0014).
    // Dual-write tenant_id (ADR 0018, Fase 2): subselect inline em flow_clones —
    // resolve NULL sozinho p/ slot sem clone, nunca derruba o upsert.
    await client.query(
      `INSERT INTO client_billing (slot, next_due_date, status, created_at, updated_at, tenant_id)
       VALUES ($1, (NOW() AT TIME ZONE 'utc')::date, 'active', NOW(), NOW(),
               (SELECT tenant_id FROM flow_clones WHERE slot = $1))
       ON CONFLICT (slot) DO UPDATE SET
         next_due_date = COALESCE(client_billing.next_due_date, (NOW() AT TIME ZONE 'utc')::date),
         updated_at    = NOW(),
         tenant_id     = COALESCE(client_billing.tenant_id, EXCLUDED.tenant_id)`,
      [input.slot],
    );

    await client.query('COMMIT');
    invalidateCloneCache({ slot: input.slot });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Número da whitelist interna pareou: segue normal SEM consumir trial. */
export async function markExempt(slot: string, pairedPhone: string): Promise<void> {
  await query(
    `UPDATE flow_clones
       SET trial_status = 'exempt', status = 'conectado', cliente_telefone = $2, updated_at = NOW()
     WHERE slot = $1`,
    [slot, pairedPhone],
  );
  invalidateCloneCache({ slot });
}

// ─────────────────────────────────────────────────────────────────────────────
// Trials ÓRFÃOS — cron de limpeza do worker (Missão 020 F1, condição 2 do
// PORTAL_SIGNUP). Órfão = signup que provisionou clone + sessão WAHA mas NUNCA
// pareou (trial nunca iniciou) e passou da idade limite. Sem limpeza, cada
// órfão é 1 sessão WAHA (instância Baileys) comendo RAM na VPS sem swap.
// ─────────────────────────────────────────────────────────────────────────────

export interface OrphanTrialCandidate {
  slot: string;
  waha_sessao: string | null;
  status: string;
  trial_status: TrialStatus;
  /** Idade do clone em horas (NOW() - created_at). */
  age_hours: number;
}

/**
 * WHERE compartilhada da seleção de órfãos — TODAS as condições são guardas:
 *  - trial_status = 'awaiting'  => SÓ clone nascido do signup self-service que
 *    nunca pareou. 'none' (Cirilo/matrizes/clones manuais do gestão) e 'exempt'
 *    (whitelist interna) JAMAIS entram; 'active'/'blocked' são trials que já
 *    consumiram ledger — fora do escopo deste cron.
 *  - slot LIKE 'clone\_%'       => defesa em profundidade (prefixo obrigatório
 *    do signup; mesma guarda do teardownProvisionedClone).
 *  - status IN (rascunho, aguardando_qr) => nunca progrediu (mesma guarda
 *    interna do teardown — clone conectado jamais é candidato).
 *  - cb.next_due_date IS NULL   => cinto extra: trial nunca iniciou (startTrial
 *    sempre seta a data; LEFT JOIN cobre clone sem linha de billing).
 *  - created_at < NOW() - idade => só órfão "frio" (idade configurável no worker).
 */
const ORPHAN_WHERE = `
  FROM flow_clones fc
  LEFT JOIN client_billing cb ON cb.slot = fc.slot
  WHERE fc.trial_status = 'awaiting'
    AND fc.slot LIKE 'clone\\_%'
    AND fc.status IN ('rascunho', 'aguardando_qr')
    AND cb.next_due_date IS NULL
    AND fc.created_at < NOW() - make_interval(hours => $1)`;

const ORPHAN_COLS = `fc.slot, fc.waha_sessao, fc.status, fc.trial_status,
         EXTRACT(EPOCH FROM (NOW() - fc.created_at)) / 3600.0 AS age_hours`;

function normalizeOrphan(
  row: Omit<OrphanTrialCandidate, 'age_hours'> & { age_hours: string | number },
): OrphanTrialCandidate {
  return { ...row, age_hours: Number(row.age_hours) };
}

/**
 * Candidatos a teardown, mais antigos primeiro. `limit` é o teto por rodada do
 * cron (o resto fica pra próxima — órfão não estraga esperando 1h). NÃO
 * seleciona cliente_telefone (LGPD: o cron nunca vê/loga número).
 */
export async function listOrphanTrialCandidates(
  maxAgeHours: number,
  limit: number,
): Promise<OrphanTrialCandidate[]> {
  const r = await query<Omit<OrphanTrialCandidate, 'age_hours'> & { age_hours: string }>(
    `SELECT ${ORPHAN_COLS}
     ${ORPHAN_WHERE}
     ORDER BY fc.created_at ASC
     LIMIT $2`,
    [maxAgeHours, limit],
  );
  return r.rows.map(normalizeOrphan);
}

/**
 * Releitura FRESH de UM candidato — chamada DENTRO do withTrialSlotLock (mesmo
 * advisory lock do trial-pairing) antes do teardown: se o cliente pareou entre
 * o SELECT e o lock (trial_status virou active/blocked, ou status progrediu),
 * retorna null e o cron pula o slot sem tocar em nada.
 */
export async function findOrphanTrialClone(
  slot: string,
  maxAgeHours: number,
): Promise<OrphanTrialCandidate | null> {
  const r = await query<Omit<OrphanTrialCandidate, 'age_hours'> & { age_hours: string }>(
    `SELECT ${ORPHAN_COLS}
     ${ORPHAN_WHERE}
       AND fc.slot = $2
     LIMIT 1`,
    [maxAgeHours, slot],
  );
  return r.rows[0] ? normalizeOrphan(r.rows[0]) : null;
}
