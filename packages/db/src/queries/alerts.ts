/**
 * alerts — queries do Sistema de Alertas Interno (Fase 1, Missão 021).
 *
 * Spec: docs/missoes/021-sistema-alertas-interno.md.
 *
 * Três responsabilidades, todas GLOBAIS (config do time, não por-tenant):
 *  1. alert_recipients — CRUD dos destinatários (até 5; enforce no app).
 *  2. alert_config     — 1 linha (id=1): kill-switch + remetente + cooldown + toggles.
 *  3. alert_states     — máquina UP/DOWN anti-spam, 1 linha por check.
 *
 * O job monitor (apps/worker) lê/escreve SÓ por este módulo. Migration 046.
 */
import { pool, query } from '../client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

export interface AlertRecipientRow {
  id: number;
  phone: string; // E.164 só dígitos
  label: string | null;
  enabled: boolean;
  created_at: Date;
}

export interface AlertConfigRow {
  id: number; // sempre 1
  enabled: boolean;
  sender_slot: string;
  cooldown_min: number;
  check_waha: boolean;
  check_health: boolean;
  check_host: boolean;
  updated_at: Date;
}

export type AlertState = 'up' | 'down';

export interface AlertStateRow {
  check_key: string;
  state: AlertState;
  down_since: Date | null;
  last_alert_at: Date | null;
  alert_count: number;
  pending_down_count: number;
  updated_at: Date;
}

/** Limite duro de destinatários (enforce no app — spec §5). */
export const MAX_RECIPIENTS = 5;

/** check_key sintético que agrega o hard cap global de mensagens por janela. */
export const GLOBAL_STATE_KEY = '__global__';

// ─────────────────────────────────────────────────────────────────────────────
// Recipients — CRUD
// ─────────────────────────────────────────────────────────────────────────────

const RECIPIENT_COLS = 'id, phone, label, enabled, created_at';

function normalizeRecipient(row: AlertRecipientRow & { id: string | number }): AlertRecipientRow {
  return { ...row, id: Number(row.id) };
}

export async function listRecipients(): Promise<AlertRecipientRow[]> {
  const r = await query<AlertRecipientRow & { id: string }>(
    `SELECT ${RECIPIENT_COLS} FROM alert_recipients ORDER BY created_at ASC`,
  );
  return r.rows.map(normalizeRecipient);
}

/** Só os destinatários habilitados — o que o job de fato notifica. */
export async function listEnabledRecipients(): Promise<AlertRecipientRow[]> {
  const r = await query<AlertRecipientRow & { id: string }>(
    `SELECT ${RECIPIENT_COLS} FROM alert_recipients
     WHERE enabled = TRUE ORDER BY created_at ASC`,
  );
  return r.rows.map(normalizeRecipient);
}

export async function countRecipients(): Promise<number> {
  const r = await query<{ count: string }>('SELECT COUNT(*)::text AS count FROM alert_recipients');
  return Number(r.rows[0]?.count ?? 0);
}

/**
 * Insere destinatário. Erro tipado se já existir o telefone ou se exceder o teto.
 * A contagem + insert correm na MESMA transação (FOR UPDATE no count via lock de
 * tabela leve não é necessário aqui — concorrência é só o painel, 1 operador;
 * o UNIQUE(phone) cobre duplicata e o teto é checado dentro da transação).
 */
export class TooManyRecipientsError extends Error {
  constructor() {
    super(`Limite de ${MAX_RECIPIENTS} destinatários atingido`);
    this.name = 'TooManyRecipientsError';
  }
}

export class DuplicateRecipientError extends Error {
  constructor(phone: string) {
    super(`Telefone já cadastrado: ${phone}`);
    this.name = 'DuplicateRecipientError';
  }
}

export async function addRecipient(input: {
  phone: string;
  label?: string | null;
}): Promise<AlertRecipientRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cnt = await client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM alert_recipients',
    );
    if (Number(cnt.rows[0]?.count ?? 0) >= MAX_RECIPIENTS) {
      await client.query('ROLLBACK');
      throw new TooManyRecipientsError();
    }
    const dup = await client.query('SELECT 1 FROM alert_recipients WHERE phone = $1 LIMIT 1', [
      input.phone,
    ]);
    if ((dup.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      throw new DuplicateRecipientError(input.phone);
    }
    const ins = await client.query<AlertRecipientRow & { id: string }>(
      `INSERT INTO alert_recipients (phone, label)
       VALUES ($1, $2)
       RETURNING ${RECIPIENT_COLS}`,
      [input.phone, input.label ?? null],
    );
    await client.query('COMMIT');
    return normalizeRecipient(ins.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Atualiza label e/ou enabled de um destinatário. Retorna null se não existir. */
export async function updateRecipient(
  id: number,
  patch: { label?: string | null; enabled?: boolean },
): Promise<AlertRecipientRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.label !== undefined) {
    vals.push(patch.label);
    sets.push(`label = $${vals.length}`);
  }
  if (patch.enabled !== undefined) {
    vals.push(patch.enabled);
    sets.push(`enabled = $${vals.length}`);
  }
  if (sets.length === 0) {
    const r = await query<AlertRecipientRow & { id: string }>(
      `SELECT ${RECIPIENT_COLS} FROM alert_recipients WHERE id = $1`,
      [id],
    );
    return r.rows[0] ? normalizeRecipient(r.rows[0]) : null;
  }
  vals.push(id);
  const r = await query<AlertRecipientRow & { id: string }>(
    `UPDATE alert_recipients SET ${sets.join(', ')}
     WHERE id = $${vals.length}
     RETURNING ${RECIPIENT_COLS}`,
    vals,
  );
  return r.rows[0] ? normalizeRecipient(r.rows[0]) : null;
}

/** Remove destinatário. Retorna true se removeu. */
export async function deleteRecipient(id: number): Promise<boolean> {
  const r = await query('DELETE FROM alert_recipients WHERE id = $1', [id]);
  return (r.rowCount ?? 0) > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config — get/set (sempre 1 linha, id=1)
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG_COLS =
  'id, enabled, sender_slot, cooldown_min, check_waha, check_health, check_host, updated_at';

function normalizeConfig(row: AlertConfigRow & { id: string | number }): AlertConfigRow {
  return {
    ...row,
    id: Number(row.id),
    cooldown_min: Number(row.cooldown_min),
  };
}

/**
 * Lê a config. A migration 046 já garante a linha id=1; o INSERT idempotente aqui
 * é cinto extra (banco recém-migrado num teste, ou migration parcial).
 */
export async function getConfig(): Promise<AlertConfigRow> {
  await query('INSERT INTO alert_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  const r = await query<AlertConfigRow & { id: string }>(
    `SELECT ${CONFIG_COLS} FROM alert_config WHERE id = 1`,
  );
  return normalizeConfig(r.rows[0]);
}

/** Patch parcial da config global. Campos ausentes não mudam. */
export async function updateConfig(patch: {
  enabled?: boolean;
  sender_slot?: string;
  cooldown_min?: number;
  check_waha?: boolean;
  check_health?: boolean;
  check_host?: boolean;
}): Promise<AlertConfigRow> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const add = (col: string, val: unknown) => {
    vals.push(val);
    sets.push(`${col} = $${vals.length}`);
  };
  if (patch.enabled !== undefined) add('enabled', patch.enabled);
  if (patch.sender_slot !== undefined) add('sender_slot', patch.sender_slot);
  if (patch.cooldown_min !== undefined) add('cooldown_min', patch.cooldown_min);
  if (patch.check_waha !== undefined) add('check_waha', patch.check_waha);
  if (patch.check_health !== undefined) add('check_health', patch.check_health);
  if (patch.check_host !== undefined) add('check_host', patch.check_host);

  // Garante a linha antes do UPDATE (idempotência defensiva).
  await query('INSERT INTO alert_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  if (sets.length === 0) return getConfig();

  sets.push('updated_at = NOW()');
  const r = await query<AlertConfigRow & { id: string }>(
    `UPDATE alert_config SET ${sets.join(', ')} WHERE id = 1
     RETURNING ${CONFIG_COLS}`,
    vals,
  );
  return normalizeConfig(r.rows[0]);
}

/**
 * Resolve a sessão WAHA remetente a partir do sender_slot (bot_config.waha_sessao).
 * Default Lola: slot 'startap' → 'STARTAP_AI_PROD'. Retorna null se o slot não
 * tiver waha_sessao mapeado — o job degrada graciosamente (loga, não envia).
 */
export async function getSenderSession(senderSlot: string): Promise<string | null> {
  const r = await query<{ waha_sessao: string | null }>(
    'SELECT waha_sessao FROM bot_config WHERE slot = $1',
    [senderSlot],
  );
  return r.rows[0]?.waha_sessao ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sessões a monitorar — clientes reais com sessão dedicada + Lola (spec §1)
// ─────────────────────────────────────────────────────────────────────────────

export interface MonitoredSession {
  /** Nome da sessão WAHA (ex.: 'cirilo_barbaershop', 'STARTAP_AI_PROD'). */
  sessao: string;
  /** Rótulo amigável p/ a mensagem (display_name do clone, ou o próprio nome). */
  label: string;
}

/**
 * Sessões WAHA a monitorar:
 *  - clones com sessão dedicada E status 'conectado' (já pareados — Cirilo/Samuel);
 *    NÃO monitora pré-setup (rascunho/aguardando_qr — FAILED esperado) nem trials
 *    'awaiting' (ver memória project_fluxos_pre_setup);
 *  - + a própria sessão remetente (Lola — bot_config do sender_slot), pra detectar
 *    se a Lola caiu (ainda que, caída, o alerta não saia — limitação conhecida §3).
 *
 * Exclui sessões de teste por nunca casarem com clone 'conectado' (WHATSAPP_ROUTER_TESTE
 * não é flow_clone de cliente). Dedup por nome de sessão.
 */
export async function listMonitoredSessions(senderSlot: string): Promise<MonitoredSession[]> {
  const r = await query<{ waha_sessao: string; display_name: string | null }>(
    `SELECT fc.waha_sessao, fc.display_name
       FROM flow_clones fc
      WHERE fc.waha_sessao IS NOT NULL
        AND fc.waha_sessao <> ''
        AND fc.status = 'conectado'
        AND fc.trial_status <> 'awaiting'`,
  );
  const out = new Map<string, MonitoredSession>();
  for (const row of r.rows) {
    out.set(row.waha_sessao, {
      sessao: row.waha_sessao,
      label: row.display_name ?? row.waha_sessao,
    });
  }
  // A sessão da Lola (remetente) — monitorada também.
  const lola = await getSenderSession(senderSlot);
  if (lola && !out.has(lola)) {
    out.set(lola, { sessao: lola, label: 'Lola (remetente de alertas)' });
  }
  return [...out.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// States — máquina anti-spam (get/upsert)
// ─────────────────────────────────────────────────────────────────────────────

const STATE_COLS =
  'check_key, state, down_since, last_alert_at, alert_count, pending_down_count, updated_at';

function normalizeState(row: AlertStateRow & { alert_count: string | number }): AlertStateRow {
  return {
    ...row,
    alert_count: Number(row.alert_count),
    pending_down_count: Number(row.pending_down_count),
  };
}

/** Lê o estado de um check. null se nunca observado (caller assume 'up'). */
export async function getState(checkKey: string): Promise<AlertStateRow | null> {
  const r = await query<AlertStateRow & { alert_count: string }>(
    `SELECT ${STATE_COLS} FROM alert_states WHERE check_key = $1`,
    [checkKey],
  );
  return r.rows[0] ? normalizeState(r.rows[0]) : null;
}

/** Lê TODOS os estados de uma vez (1 query por ciclo do job). */
export async function listStates(): Promise<AlertStateRow[]> {
  const r = await query<AlertStateRow & { alert_count: string }>(
    `SELECT ${STATE_COLS} FROM alert_states`,
  );
  return r.rows.map(normalizeState);
}

/**
 * Upsert do estado de um check. NULL explícito limpa down_since/last_alert_at
 * (transição down→up). Idempotente: re-gravar o mesmo estado não tem efeito
 * colateral além de updated_at.
 */
export async function upsertState(input: {
  checkKey: string;
  state: AlertState;
  downSince?: Date | null;
  lastAlertAt?: Date | null;
  alertCount?: number;
  pendingDownCount?: number;
}): Promise<void> {
  await query(
    `INSERT INTO alert_states
       (check_key, state, down_since, last_alert_at, alert_count, pending_down_count, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (check_key) DO UPDATE SET
       state              = EXCLUDED.state,
       down_since         = EXCLUDED.down_since,
       last_alert_at      = EXCLUDED.last_alert_at,
       alert_count        = EXCLUDED.alert_count,
       pending_down_count = EXCLUDED.pending_down_count,
       updated_at         = NOW()`,
    [
      input.checkKey,
      input.state,
      input.downSince ?? null,
      input.lastAlertAt ?? null,
      input.alertCount ?? 0,
      input.pendingDownCount ?? 0,
    ],
  );
}

/**
 * Hard cap global: conta quantas mensagens foram enviadas na janela atual e
 * incrementa de forma atômica. A linha sintética '__global__' guarda o contador
 * (alert_count) e o início da janela (down_since reaproveitado como window_start).
 *
 * Semântica: se now - window_start >= windowMin, a janela reseta (count=1).
 * Caso contrário, incrementa. Retorna { allowed } indicando se o envio cabe sob
 * o teto `maxPerWindow`. Tudo numa transação com FOR UPDATE pra serializar.
 */
export async function reserveGlobalSend(input: {
  maxPerWindow: number;
  windowMin: number;
}): Promise<{ allowed: boolean; sentInWindow: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Garante a linha e trava.
    await client.query(
      `INSERT INTO alert_states (check_key, state) VALUES ($1, 'up')
       ON CONFLICT (check_key) DO NOTHING`,
      [GLOBAL_STATE_KEY],
    );
    const cur = await client.query<{
      alert_count: string;
      down_since: Date | null;
    }>(
      `SELECT alert_count, down_since FROM alert_states
       WHERE check_key = $1 FOR UPDATE`,
      [GLOBAL_STATE_KEY],
    );
    const windowStart = cur.rows[0]?.down_since ?? null;
    const count = Number(cur.rows[0]?.alert_count ?? 0);
    const now = Date.now();
    const windowMs = input.windowMin * 60_000;
    const windowExpired = !windowStart || now - windowStart.getTime() >= windowMs;

    let sentInWindow: number;
    let allowed: boolean;
    if (windowExpired) {
      // Nova janela — este envio é o 1º.
      sentInWindow = 1;
      allowed = true;
      await client.query(
        `UPDATE alert_states
           SET alert_count = 1, down_since = NOW(), updated_at = NOW()
         WHERE check_key = $1`,
        [GLOBAL_STATE_KEY],
      );
    } else if (count < input.maxPerWindow) {
      sentInWindow = count + 1;
      allowed = true;
      await client.query(
        `UPDATE alert_states
           SET alert_count = alert_count + 1, updated_at = NOW()
         WHERE check_key = $1`,
        [GLOBAL_STATE_KEY],
      );
    } else {
      // Teto estourado — suprime, NÃO incrementa (não falsear o contador).
      sentInWindow = count;
      allowed = false;
    }

    await client.query('COMMIT');
    return { allowed, sentInWindow };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
