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

/**
 * check_key sintético DEDICADO ao heartbeat de liveness do monitor (SCRUM-54, ADR do arquiteto):
 * separado do __global__ (hard cap) POR CONSTRUÇÃO — desacopla liveness do anti-flood e deixa o
 * SELECT de liveness inequívoco. NUNCA é um check observado (o monitor nunca o processa em
 * applyTransition; é inerte na máquina de estado, igual ao __global__).
 */
export const HEARTBEAT_STATE_KEY = '__heartbeat__';

/**
 * check_key do disco do HOST (SCRUM-134, migration 078). Fato bruto escrito pelo script
 * `/opt/automacoes/disco-alerta.sh` (cron 6/6h no HOST — NUNCA pelo worker, que enxerga
 * cgroup/overlay do container, não o disco físico; ver monitor.ts `observeHostDisk`).
 * `host_reported_pct`/`host_reported_at` são inertes quanto a state/alert_count até o
 * worker os LER e alimentar applyTransition — mesmo padrão do heartbeat (produtor externo
 * carimba um fato numa linha dedicada; o consumidor decide o que fazer com ele).
 */
export const HOST_DISK_STATE_KEY = 'host:disk';

/** Fato bruto reportado pelo script de disco do host (migration 078). */
export interface HostDiskReport {
  /** % de uso do disco '/' na última coleta. null se o script nunca rodou. */
  pct: number | null;
  /** timestamp da última coleta. null se o script nunca rodou. */
  reportedAt: Date | null;
}

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

/**
 * Sessões CRÍTICAS que NÃO são clones de cliente (não vivem em flow_clones) e NÃO são
 * a remetente — mas precisam ser vigiadas. Default no código (padrão do bot-blocklist #329:
 * o comportamento em prod NÃO depende de setar env; o deploy já ativa a vigia).
 *
 * Hoje: `STARTAP_AI_PROD` = Lola, nosso bot de prospecção (slot 'startap'). Ficava FORA
 * do monitor porque não é flow_clone nem a remetente ALERTAS — bug provado em prod: caiu
 * por device_removed em 02/07 22:22 UTC e o monitor nem tentou alertar (SCRUM-56).
 */
export const DEFAULT_MONITOR_EXTRA_SESSIONS: readonly string[] = ['STARTAP_AI_PROD'];

/**
 * Resolve a lista de sessões extra (não-clone) a vigiar, a partir da env CSV opcional
 * `MONITOR_EXTRA_SESSIONS`. Semântica de UNIÃO (mesmo padrão do bot-blocklist #329):
 *  - o default (DEFAULT_MONITOR_EXTRA_SESSIONS) está SEMPRE presente;
 *  - a env ADICIONA sessões extras por cima (não substitui).
 * Escolha deliberada p/ uma lista de VIGIA: o modo de falha do "override" seria silencioso
 * e perigoso (setar a env pra adicionar UMA sessão e esquecer de reincluir STARTAP_AI_PROD
 * tiraria a Lola da vigia sem ninguém ver — exatamente o ponto cego que o SCRUM-56 mata).
 * Remover uma sessão do default passa a EXIGIR mudança de código — o certo p/ infra crítica.
 * Trim + dedupe; itens vazios são ignorados. `env` injetável só p/ teste (padrão de
 * model-usage.summaryByPeriod).
 */
export function resolveMonitorExtraSessions(env: NodeJS.ProcessEnv = process.env): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (value: string): void => {
    const name = value.trim();
    if (name.length === 0 || seen.has(name)) return;
    seen.add(name);
    out.push(name);
  };

  // Default de segurança — SEMPRE presente (a env não tira, só soma).
  for (const name of DEFAULT_MONITOR_EXTRA_SESSIONS) add(name);

  // Sessões extras da env (CSV). Ausente/vazia = só o default.
  const raw = env.MONITOR_EXTRA_SESSIONS;
  if (raw && raw.trim().length > 0) {
    for (const part of raw.split(',')) add(part);
  }

  return out;
}

export interface MonitoredSession {
  /** Nome da sessão WAHA (ex.: 'cirilo_barbaershop', 'STARTAP_AI_PROD'). */
  sessao: string;
  /** Rótulo amigável p/ a mensagem (display_name do clone, ou o próprio nome). */
  label: string;
  /**
   * slot do clone dono desta sessão. null pra a sessão remetente sintética (ALERTAS) —
   * que NÃO é um clone de cliente. Usado pelo monitor pra resolver o DONO e avisá-lo
   * quando a sessão dele cai (auto-aviso de desconexão — CLIENT_DISCONNECT_ALERT_ENABLED).
   */
  slot: string | null;
}

/**
 * Sessões WAHA a monitorar:
 *  - clones com sessão dedicada que JÁ parearam alguma vez (first_connected_at IS NOT NULL,
 *    migration 062), em status 'conectado' OU 'desconectado'. Inclui o caso CRÍTICO da sessão
 *    que ACABOU de cair: o sync do painel (WAHA FAILED -> 'desconectado') tira o
 *    'conectado' em ~60s; com o filtro antigo `status = 'conectado'` a sessão SAÍA da lista no
 *    instante em que caía e o monitor NUNCA via a transição up->down (bug provado em prod: Seven 7
 *    ficou FAILED ~20 min sem 1 alerta; alert_states seguiu 'up'). Agora ela CONTINUA vigiada: o
 *    observeWaha do monitor a vê como down (status != WORKING na WAHA) e dispara o alerta —
 *    interno (Bruno) E, com a flag nova, ao próprio dono do clone.
 *    NOTA (SCRUM-64): STOPPED (parada de PROPÓSITO via POST /stop) NÃO cai em 'desconectado' e
 *    sim em 'parado' (webhook session.status + sync do painel) — FORA deste filtro de propósito,
 *    pra não gerar alerta de queda falso pra uma sessão intencionalmente parada.
 *  - ANTI-PRÉ-SETUP: clones que NUNCA conectaram (first_connected_at NULL — rascunho/
 *    aguardando_qr/falhou nunca-pareados) ficam FORA. FAILED/SCAN_QR_CODE de pré-setup é estado
 *    ESPERADO, não incidente. Trials 'awaiting' também ficam fora (ver memória project_fluxos_
 *    pre_setup). Sem o carimbo, a sessão jamais entra na lista -> jamais gera falso CAIU.
 *  - + a própria sessão remetente (bot_config do sender_slot — hoje a sessão dedicada `ALERTAS`),
 *    pra detectar se o remetente caiu (ainda que, caído, o alerta não saia — limitação §3).
 *    slot=null nessa entrada (não é clone de cliente; nunca avisa "dono").
 *  - + sessões CRÍTICAS não-clone (resolveMonitorExtraSessions — hoje a Lola/STARTAP_AI_PROD),
 *    que não vivem em flow_clones nem são a remetente. slot=null (não é clone; nunca avisa
 *    "dono", só o alerta interno ao Bruno). Corrige o SCRUM-56: a Lola ficava cega ao monitor.
 *
 * Exclui sessões de teste por nunca terem first_connected_at de um clone de cliente real.
 * Dedup por nome de sessão (clone com slot real tem precedência sobre entrada extra slot=null).
 */
export async function listMonitoredSessions(
  senderSlot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MonitoredSession[]> {
  const r = await query<{ slot: string; waha_sessao: string; display_name: string | null }>(
    `SELECT fc.slot, fc.waha_sessao, fc.display_name
       FROM flow_clones fc
      WHERE fc.waha_sessao IS NOT NULL
        AND fc.waha_sessao <> ''
        AND fc.first_connected_at IS NOT NULL
        AND fc.status IN ('conectado', 'desconectado')
        AND fc.trial_status <> 'awaiting'`,
  );
  const out = new Map<string, MonitoredSession>();
  for (const row of r.rows) {
    out.set(row.waha_sessao, {
      sessao: row.waha_sessao,
      label: row.display_name ?? row.waha_sessao,
      slot: row.slot,
    });
  }
  // A sessão remetente (resolvida pelo sender_slot) — monitorada também. slot=null:
  // é infra de transporte, não um clone de cliente (nunca dispara aviso ao "dono").
  const sender = await getSenderSession(senderSlot);
  if (sender && !out.has(sender)) {
    out.set(sender, { sessao: sender, label: 'Sessão de alertas (remetente)', slot: null });
  }
  // Sessões CRÍTICAS não-clone (default Lola/STARTAP_AI_PROD + o que a env somar). slot=null:
  // não é clone de cliente — dispara só o alerta interno (Bruno), nunca o aviso ao "dono".
  // Dedup: se a sessão já entrou como clone (com slot real), NÃO a rebaixa pra slot=null.
  for (const sessao of resolveMonitorExtraSessions(env)) {
    if (!out.has(sessao)) {
      out.set(sessao, { sessao, label: `${sessao} (sessão crítica)`, slot: null });
    }
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
 * Heartbeat de liveness do job monitor (SCRUM-54). Carimba last_cycle_at = NOW() na linha
 * sintética DEDICADA '__heartbeat__' a cada tick — pra que "saudável e quieto" deixe de ser
 * indistinguível de "travado" (a prova de vida vira verificável por SELECT). UPSERT idempotente:
 * SEED a linha na 1ª vez (ela não existe na migration) e, nas seguintes, só avança o timestamp.
 * Linha separada do __global__ (hard cap) por construção — zero contenção com o anti-flood.
 */
export async function recordCycleHeartbeat(): Promise<void> {
  await query(
    `INSERT INTO alert_states (check_key, state, last_cycle_at, updated_at)
     VALUES ($1, 'up', NOW(), NOW())
     ON CONFLICT (check_key) DO UPDATE SET
       last_cycle_at = NOW(),
       updated_at    = NOW()`,
    [HEARTBEAT_STATE_KEY],
  );
}

/** Lê o último heartbeat do monitor (last_cycle_at da __heartbeat__). null se nunca ticou. */
export async function getMonitorHeartbeat(): Promise<Date | null> {
  const r = await query<{ last_cycle_at: Date | null }>(
    'SELECT last_cycle_at FROM alert_states WHERE check_key = $1',
    [HEARTBEAT_STATE_KEY],
  );
  return r.rows[0]?.last_cycle_at ?? null;
}

/**
 * Contador VIGIADO de sendErrors do monitor (SCRUM-135, item 7). Reaproveita a coluna
 * `alert_count` da linha sintética __heartbeat__ (nunca usada por essa linha pra outro fim —
 * só checks reais up/down consomem alert_count com sentido de "quantas vezes alertou"). Zero
 * migration nova: soma ACUMULADA desde sempre, resetável manualmente via UPDATE se precisar
 * zerar a série. Antes disso, sendErrors só existia como log.error (grep-only, sem contador
 * consultável) — este UPSERT dá um SELECT direto pra decidir alarme futuro sem parsear log.
 */
export async function bumpMonitorSendErrors(delta: number): Promise<void> {
  if (delta <= 0) return;
  await query(
    `INSERT INTO alert_states (check_key, state, alert_count, updated_at)
     VALUES ($1, 'up', $2, NOW())
     ON CONFLICT (check_key) DO UPDATE SET
       alert_count = alert_states.alert_count + EXCLUDED.alert_count,
       updated_at  = NOW()`,
    [HEARTBEAT_STATE_KEY, delta],
  );
}

/** Lê o total acumulado de sendErrors do monitor (alert_count da __heartbeat__). 0 se nunca houve. */
export async function getMonitorSendErrorsTotal(): Promise<number> {
  const r = await query<{ alert_count: number }>(
    'SELECT alert_count FROM alert_states WHERE check_key = $1',
    [HEARTBEAT_STATE_KEY],
  );
  return r.rows[0]?.alert_count ?? 0;
}

/**
 * Lê o último fato de disco reportado pelo script do HOST (SCRUM-134, migration 078). SÓ leitura
 * — quem grava é o script bash via `startap_app` (INSERT ... ON CONFLICT DO UPDATE), nunca o
 * worker. Retorna { pct: null, reportedAt: null } se a linha ainda não existe (banco recém
 * migrado antes do 1º ciclo do script) ou nunca recebeu uma coleta.
 */
export async function getHostDiskReport(): Promise<HostDiskReport> {
  const r = await query<{
    host_reported_pct: number | string | null;
    host_reported_at: Date | null;
  }>('SELECT host_reported_pct, host_reported_at FROM alert_states WHERE check_key = $1', [
    HOST_DISK_STATE_KEY,
  ]);
  const row = r.rows[0];
  if (!row) return { pct: null, reportedAt: null };
  return {
    pct: row.host_reported_pct === null ? null : Number(row.host_reported_pct),
    reportedAt: row.host_reported_at ?? null,
  };
}

/**
 * Compensação (rollback) do estado de um check, CONDICIONAL ao valor que o próprio
 * chamador acabou de gravar. Restaura `restore` SOMENTE SE a linha atual ainda contém
 * exatamente os valores de `expect` (state + alert_count + last_alert_at). Retorna true
 * se restaurou, false se a linha já mudou (outro ciclo regravou) ou sumiu.
 *
 * Por quê: o job de alertas RESERVA o estado (carimba last_alert_at/alert_count) ANTES do
 * envio, pra que dois ciclos concorrentes não mandem a mesma mensagem (lock otimista). Se o
 * envio FALHA, precisamos desfazer a reserva pra o próximo ciclo re-tentar — mas SEM pisar
 * numa reserva mais nova feita por outro ciclo. O predicado `expect` é o valor que ESTE ciclo
 * gravou: só o dono da reserva a desfaz. Preserva a semântica anti-duplicata.
 *
 * `IS NOT DISTINCT FROM` compara last_alert_at tratando NULL corretamente.
 */
export async function restoreStateIfUnchanged(input: {
  checkKey: string;
  expect: { state: AlertState; lastAlertAt: Date | null; alertCount: number };
  restore: {
    state: AlertState;
    downSince: Date | null;
    lastAlertAt: Date | null;
    alertCount: number;
    pendingDownCount: number;
  };
}): Promise<boolean> {
  const r = await query(
    `UPDATE alert_states SET
       state              = $1,
       down_since         = $2,
       last_alert_at      = $3,
       alert_count        = $4,
       pending_down_count = $5,
       updated_at         = NOW()
     WHERE check_key = $6
       AND state       = $7
       AND alert_count = $8
       AND last_alert_at IS NOT DISTINCT FROM $9`,
    [
      input.restore.state,
      input.restore.downSince ?? null,
      input.restore.lastAlertAt ?? null,
      input.restore.alertCount,
      input.restore.pendingDownCount,
      input.checkKey,
      input.expect.state,
      input.expect.alertCount,
      input.expect.lastAlertAt ?? null,
    ],
  );
  return (r.rowCount ?? 0) > 0;
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
