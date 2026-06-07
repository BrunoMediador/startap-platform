/**
 * portal-config — leitura/escrita de servicos, horarios e pausas escopadas por slot.
 *
 * ADR 0012 (Decisao 4 + 6): toda funcao recebe `slot` como PRIMEIRO parametro
 * explicito. O portal-api deriva esse slot SEMPRE de request.tenant.slot (nunca
 * do input do cliente). Queries 100% parametrizadas.
 *
 * Apos escrita em flow_clones, invalida o cache de clone (TTL 60s) para o webhook
 * pegar a versao nova em ate ~0s em vez de ate 60s.
 */
import type { Horarios, Servicos } from '@startap/core/schemas';
import { query } from '../client.js';
import { invalidateCloneCache } from './flow-clones.js';

function parseJsonbOrNull<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

// ---------------------------------------------------------------------------
// Servicos
// ---------------------------------------------------------------------------

/** Retorna os servicos do clone. `null` se o slot nao existe; `[]` se sem servicos. */
export async function getServicosBySlot(slot: string): Promise<Servicos | null> {
  const r = await query<{ servicos: unknown }>('SELECT servicos FROM flow_clones WHERE slot = $1', [
    slot,
  ]);
  if (r.rows.length === 0) return null;
  return parseJsonbOrNull<Servicos>(r.rows[0].servicos) ?? [];
}

/**
 * Grava os servicos do clone. Espera que `servicos` JA tenha passado pelo
 * servicosSchema do chamador. Retorna false se o slot nao existe.
 */
export async function updateServicosBySlot(slot: string, servicos: Servicos): Promise<boolean> {
  const r = await query(
    'UPDATE flow_clones SET servicos = $2::jsonb, updated_at = NOW() WHERE slot = $1',
    [slot, JSON.stringify(servicos)],
  );
  if (r.rowCount === 0) return false;
  invalidateCloneCache({ slot });
  return true;
}

// ---------------------------------------------------------------------------
// Horarios de funcionamento
// ---------------------------------------------------------------------------

/** Retorna a grade horaria do clone. `null` se o slot nao existe; `{}` se nao configurada. */
export async function getHorariosBySlot(slot: string): Promise<Horarios | null> {
  const r = await query<{ horarios_funcionamento: unknown }>(
    'SELECT horarios_funcionamento FROM flow_clones WHERE slot = $1',
    [slot],
  );
  if (r.rows.length === 0) return null;
  return parseJsonbOrNull<Horarios>(r.rows[0].horarios_funcionamento) ?? {};
}

/**
 * Grava a grade horaria do clone. Espera que `horarios` JA tenha passado pelo
 * horariosSchema do chamador. Retorna false se o slot nao existe.
 */
export async function updateHorariosBySlot(slot: string, horarios: Horarios): Promise<boolean> {
  const r = await query(
    'UPDATE flow_clones SET horarios_funcionamento = $2::jsonb, updated_at = NOW() WHERE slot = $1',
    [slot, JSON.stringify(horarios)],
  );
  if (r.rowCount === 0) return false;
  invalidateCloneCache({ slot });
  return true;
}

// ---------------------------------------------------------------------------
// Pausas (flow_pauses, flow_id = slot)
// ---------------------------------------------------------------------------

export interface PortalPausaRow {
  telefone: string;
  source: string | null;
  reason: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Lista pausas ATIVAS do fluxo do cliente (escopado por slot/flow_id). */
export async function listPausasBySlot(slot: string): Promise<PortalPausaRow[]> {
  const r = await query<PortalPausaRow>(
    `SELECT telefone, source, LEFT(reason, 200) AS reason, created_at, updated_at
     FROM flow_pauses
     WHERE flow_id = $1 AND active = TRUE
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 500`,
    [slot],
  );
  return r.rows;
}

/**
 * Cria (ou reativa) a pausa de um numero no fluxo do cliente, via portal.
 * source = 'portal' para rastreabilidade. `session` resolvido a partir do clone.
 * `telefone` deve ser apenas digitos (10-15) — validado pelo chamador.
 */
export async function addPausaBySlot(input: {
  slot: string;
  telefone: string;
}): Promise<PortalPausaRow | null> {
  const { slot, telefone } = input;

  // Resolve flow_name + session a partir do clone (graceful: NULL se nao achar).
  const meta = await query<{ display_name: string | null; waha_sessao: string | null }>(
    'SELECT display_name, waha_sessao FROM flow_clones WHERE slot = $1',
    [slot],
  );
  const flowName = meta.rows[0]?.display_name ?? null;
  const session = meta.rows[0]?.waha_sessao ?? null;

  const r = await query<PortalPausaRow>(
    `INSERT INTO flow_pauses
       (flow_id, flow_name, telefone, session, active, source, reason, updated_at)
     VALUES ($1, $2, $3, $4, TRUE, 'portal', 'Pausado via portal', NOW())
     ON CONFLICT (flow_id, telefone) DO UPDATE
       SET active     = TRUE,
           flow_name  = COALESCE(EXCLUDED.flow_name, flow_pauses.flow_name),
           session    = COALESCE(EXCLUDED.session, flow_pauses.session),
           source     = 'portal',
           reason     = CASE
             WHEN flow_pauses.reason IS NULL OR flow_pauses.reason = ''
             THEN 'Pausado via portal'
             ELSE flow_pauses.reason || ' | reativado via portal'
           END,
           updated_at = NOW()
     RETURNING telefone, source, LEFT(reason, 200) AS reason, created_at, updated_at`,
    [slot, flowName, telefone, session],
  );
  return r.rows[0] ?? null;
}

/**
 * Despausa (soft delete: active=false) um numero do fluxo do cliente.
 * O dono e o usuario do portal — pode gerenciar QUALQUER pausa do PROPRIO fluxo
 * (inclusive source='fromMe'/'antibot'), mas NUNCA de outro fluxo (slot e fixo).
 * Retorna false se nao havia pausa ativa para aquele numero.
 */
export async function removePausaBySlot(input: {
  slot: string;
  telefone: string;
}): Promise<boolean> {
  const r = await query(
    `UPDATE flow_pauses
       SET active = FALSE,
           updated_at = NOW(),
           reason = CASE
             WHEN reason IS NULL OR reason = '' THEN 'despausado via portal'
             ELSE reason || ' | despausado via portal'
           END
     WHERE flow_id = $1 AND telefone = $2 AND active = TRUE`,
    [input.slot, input.telefone],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Contagem de pausas ativas do fluxo (usado na home/status). */
export async function countPausasAtivasBySlot(slot: string): Promise<number> {
  const r = await query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM flow_pauses WHERE flow_id = $1 AND active = TRUE',
    [slot],
  );
  return Number(r.rows[0]?.count ?? 0);
}
