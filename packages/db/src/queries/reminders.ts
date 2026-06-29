/**
 * reminders — data layer do lembrete de agendamento (one-way, configurável por clone).
 * Migration 060.
 *
 * FONTE = tabela `atendimentos` (origem='agenda', migration 058/059). NÃO lê do GCal. O
 * worker varre os atendimentos cujo `inicio_at` cai numa janela configurada e dispara 1
 * WhatsApp pela sessão WAHA do PRÓPRIO clone (flow_clones.waha_sessao).
 *
 * ISOLAMENTO (regra de ouro 5, ADR 0018): toda leitura/escrita carrega slot + tenant_id. O
 * config por clone (getReminderConfig/setReminderConfig) recebe `slot` SEMPRE da camada de
 * cima (request.tenant.slot no portal — nunca de input do cliente). O tenant_id do
 * reminder_log vem resolvido do atendimento/clone, nunca de campo livre. Queries 100%
 * parametrizadas ($1,$2,...). CUIDADO com o bug do $1 (ADR 0018): nenhum placeholder é
 * reusado entre contextos de tipo distintos.
 *
 * IDEMPOTÊNCIA: claimReminder faz INSERT no reminder_log com UNIQUE
 * (atendimento_id, window_min, inicio_at). Conflito = já reservado/enviado -> retorna null
 * (o worker pula). Retry/cron sobreposto não reenvia. Remarcação muda inicio_at -> chave
 * nova legítima.
 */
import { query } from '../client.js';
import { invalidateCloneCache } from './flow-clones.js';

// ─────────────────────────────────────────────────────────────────────────────────────
// Config POR CLONE (flow_clones.reminders_enabled / reminder_windows_min / reminder_template)
// ─────────────────────────────────────────────────────────────────────────────────────

/** Config de lembrete de um clone, como vive no banco (windows/template NULL = default global). */
export interface ReminderConfigRow {
  /** Lembrete ligado pelo dono. */
  enabled: boolean;
  /** Janelas (min antes do horário). NULL = usa o default global do worker. */
  windows_min: number[] | null;
  /** Template do texto. NULL = usa o template default do worker. */
  template: string | null;
}

/**
 * Lê a config de lembrete de um clone. `null` se o slot não existe (clone ausente). O caller
 * (portal) resolve windows_min/template NULL para o default GLOBAL antes de devolver ao front.
 */
export async function getReminderConfig(slot: string): Promise<ReminderConfigRow | null> {
  const r = await query<{
    reminders_enabled: boolean;
    reminder_windows_min: number[] | null;
    reminder_template: string | null;
  }>(
    `SELECT reminders_enabled, reminder_windows_min, reminder_template
       FROM flow_clones WHERE slot = $1 LIMIT 1`,
    [slot],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    enabled: row.reminders_enabled === true,
    // pg devolve INT[] como number[]; defensivo para string crua de drivers exóticos.
    windows_min: normalizeWindows(row.reminder_windows_min),
    template: row.reminder_template ?? null,
  };
}

/** Campos editáveis do config (PATCH parcial). undefined = não toca a coluna. */
export interface SetReminderConfigInput {
  enabled?: boolean;
  /** Lista de janelas já VALIDADA pelo caller (subconjunto do conjunto permitido). */
  windowsMin?: number[];
}

/**
 * Grava a config de lembrete do clone (PATCH parcial). Só atualiza as colunas presentes no
 * input (undefined = preserva). Escopado por slot. Retorna a config NOVA (já normalizada) ou
 * null se o slot não existe. Invalida o cache de clone (TTL 60s) para o webhook pegar a versão
 * nova rápido.
 *
 * windowsMin = [] significa "limpar para o default global" (grava NULL). O caller valida o
 * conjunto permitido ANTES — aqui só persistimos como INT[] parametrizado.
 */
export async function setReminderConfig(
  slot: string,
  input: SetReminderConfigInput,
): Promise<ReminderConfigRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [slot];

  if (input.enabled !== undefined) {
    params.push(input.enabled);
    sets.push(`reminders_enabled = $${params.length}`);
  }
  if (input.windowsMin !== undefined) {
    // [] -> NULL (volta pro default global). Senão grava o array de inteiros (INT[]).
    if (input.windowsMin.length === 0) {
      sets.push('reminder_windows_min = NULL');
    } else {
      params.push(input.windowsMin.map((w) => Math.trunc(w)));
      sets.push(`reminder_windows_min = $${params.length}::int[]`);
    }
  }

  if (sets.length === 0) {
    // Nada a alterar — devolve a config atual.
    return getReminderConfig(slot);
  }

  const r = await query(
    `UPDATE flow_clones SET ${sets.join(', ')}, updated_at = NOW() WHERE slot = $1`,
    params,
  );
  if ((r.rowCount ?? 0) === 0) return null;
  invalidateCloneCache({ slot });
  return getReminderConfig(slot);
}

/** Normaliza INT[] vindo do pg (number[] | string crua) -> number[] de inteiros, ou null. */
function normalizeWindows(value: unknown): number[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const out = value.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0);
    return out.length > 0 ? out : null;
  }
  // Driver exótico pode entregar '{1440,120}' como string — parse defensivo.
  if (typeof value === 'string') {
    const out = value
      .replace(/[{}]/g, '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((v) => Number.isInteger(v) && v > 0);
    return out.length > 0 ? out : null;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Varredura do worker — atendimentos DUE de clones com lembrete ligado
// ─────────────────────────────────────────────────────────────────────────────────────

/** Atendimento candidato a lembrete, enriquecido com o que o render do template precisa. */
export interface DueReminderRow {
  atendimento_id: number;
  slot: string;
  tenant_id: string;
  /** Sessão WAHA do PRÓPRIO clone (remetente do lembrete). NULL = sem sessão -> pula. */
  waha_sessao: string | null;
  /** Shard do container WAHA da sessão (ADR 0020). 0 = shard atual. */
  waha_shard_id: number;
  /** Nome de exibição do negócio ({negocio}). */
  display_name: string;
  /** Janelas configuradas do clone. NULL = caller usa o default global. */
  reminder_windows_min: number[] | null;
  /** Template do clone. NULL = caller usa o default global. */
  reminder_template: string | null;
  /** Telefone do cliente final (destino). NULL/'' -> o caller pula (sem como enviar). */
  cliente_contato: string | null;
  cliente_nome: string | null;
  servico_nome: string | null;
  inicio_at: string;
  /** Nome do profissional (clone_colaboradores.nome via colaborador_id). NULL = SOLO -> omite. */
  profissional_nome: string | null;
  /**
   * Fuso (IANA) do clone (migration 068). Usado pra rotular o horário do lembrete no relógio
   * da barbearia. Default 'America/Sao_Paulo' (clone sem fuso = byte-idêntico ao de hoje).
   */
  timezone: string;
}

/**
 * Busca os atendimentos de AGENDA cujo `inicio_at` está dentro do horizonte de varredura
 * (de agora até `horizonMinutes` à frente), em clones com `reminders_enabled = TRUE`. O
 * worker, em memória, decide para CADA janela configurada se o atendimento já entrou no
 * gatilho [janela - tolerância, janela] — manter a decisão de janela no worker (não no SQL)
 * deixa o teste de janela puro e o SQL simples.
 *
 * Filtros (ADR 0027): origem='agenda', deleted_at IS NULL, status <> 'cancelado', e
 * inicio_at no futuro próximo. Escopo carrega slot + tenant_id de cada linha. LEFT JOIN em
 * clone_colaboradores (mesmo slot) para o nome do profissional — NULL no SOLO/individual.
 */
export async function findDueAgendaAtendimentos(horizonMinutes: number): Promise<DueReminderRow[]> {
  const r = await query<{
    atendimento_id: number;
    slot: string;
    tenant_id: string;
    waha_sessao: string | null;
    waha_shard_id: number;
    display_name: string;
    reminder_windows_min: number[] | null;
    reminder_template: string | null;
    cliente_contato: string | null;
    cliente_nome: string | null;
    servico_nome: string | null;
    inicio_at: string;
    profissional_nome: string | null;
    timezone: string | null;
  }>(
    `SELECT a.id            AS atendimento_id,
            a.slot          AS slot,
            a.tenant_id     AS tenant_id,
            f.waha_sessao   AS waha_sessao,
            f.waha_shard_id AS waha_shard_id,
            f.display_name  AS display_name,
            f.reminder_windows_min AS reminder_windows_min,
            f.reminder_template    AS reminder_template,
            a.cliente_contato AS cliente_contato,
            a.cliente_nome    AS cliente_nome,
            a.servico_nome    AS servico_nome,
            a.inicio_at       AS inicio_at,
            c.nome            AS profissional_nome,
            f.timezone        AS timezone
       FROM atendimentos a
       JOIN flow_clones f
         ON f.slot = a.slot
       LEFT JOIN clone_colaboradores c
         ON c.id = a.colaborador_id AND c.slot = a.slot
      WHERE f.reminders_enabled = TRUE
        AND a.origem = 'agenda'
        AND a.deleted_at IS NULL
        AND a.status <> 'cancelado'
        AND a.inicio_at IS NOT NULL
        AND a.inicio_at > now()
        AND a.inicio_at <= now() + ($1 || ' minutes')::interval
      ORDER BY a.inicio_at ASC`,
    [String(Math.trunc(horizonMinutes))],
  );
  return r.rows.map((x) => ({
    atendimento_id: Number(x.atendimento_id),
    slot: x.slot,
    tenant_id: x.tenant_id,
    waha_sessao: x.waha_sessao,
    waha_shard_id: Number(x.waha_shard_id ?? 0),
    display_name: x.display_name,
    reminder_windows_min: normalizeWindows(x.reminder_windows_min),
    reminder_template: x.reminder_template ?? null,
    cliente_contato: x.cliente_contato,
    cliente_nome: x.cliente_nome,
    servico_nome: x.servico_nome,
    inicio_at: x.inicio_at,
    profissional_nome: x.profissional_nome ?? null,
    timezone: x.timezone ?? 'America/Sao_Paulo',
  }));
}

// ─────────────────────────────────────────────────────────────────────────────────────
// CLAIM idempotente + auditoria do envio (reminder_log)
// ─────────────────────────────────────────────────────────────────────────────────────

/** Resultado do CLAIM: a linha reservada, ou null se já existia (alguém reservou antes). */
export interface ClaimedReminder {
  id: number;
}

/**
 * Reserva (CLAIM) o lembrete de um (atendimento, janela, horário-alvo). INSERT com
 * ON CONFLICT DO NOTHING sobre o UNIQUE (atendimento_id, window_min, inicio_at): se já existe,
 * retorna null (o worker pula — idempotência sob retry/cron sobreposto). Status nasce 'sent'
 * OTIMISTA; o caller faz markReminderFailed se o envio WAHA falhar. slot + tenant_id são
 * carimbados (resolvidos do atendimento/clone, nunca de input).
 */
export async function claimReminder(input: {
  atendimentoId: number;
  slot: string;
  tenantId: string;
  windowMin: number;
  inicioAt: string;
}): Promise<ClaimedReminder | null> {
  const r = await query<{ id: number }>(
    `INSERT INTO reminder_log
       (atendimento_id, slot, tenant_id, window_min, inicio_at, status, sent_at)
     VALUES ($1, $2, $3, $4, $5::timestamptz, 'sent', now())
     ON CONFLICT (atendimento_id, window_min, inicio_at) DO NOTHING
     RETURNING id`,
    [input.atendimentoId, input.slot, input.tenantId, Math.trunc(input.windowMin), input.inicioAt],
  );
  const row = r.rows[0];
  return row ? { id: Number(row.id) } : null;
}

/**
 * Marca um CLAIM como 'failed' (o envio WAHA não saiu). Escopado por id. Idempotente. NÃO
 * apaga a linha — assim o lembrete não é re-tentado num cron seguinte (decisão: one-way, sem
 * fila de retry; o claim já ocupa a chave). Para o ops auditar, fica como falha registrada.
 */
export async function markReminderFailed(id: number): Promise<void> {
  await query(`UPDATE reminder_log SET status = 'failed', sent_at = NULL WHERE id = $1`, [id]);
}
