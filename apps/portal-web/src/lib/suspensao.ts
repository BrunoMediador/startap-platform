/**
 * Classifica o PORQUÊ de um atendimento estar pausado (flow_enabled=false), pra a
 * Home nunca confundir uma pausa do próprio dono (owner_request) com inadimplência.
 *
 * Bug que motivou (Samuel, 2026-06-27): o cliente pausou pelo portal (owner_request,
 * mensalidade EM DIA) e a Home ainda mandava "regularize sua mensalidade". A decisão
 * de copy estava amarrada só em `flow_enabled=false`, ignorando o motivo e o billing.
 *
 * REGRA DURA: o aviso "regularize a mensalidade" SÓ aparece em `inadimplencia`.
 * NUNCA por causa de owner_request, NUNCA numa conta em dia.
 *
 * Lógica pura (sem React/DOM) pra ser testável isolada — mesma convenção de lib/*.
 */
import type { StatusResponse } from './api-types';

/**
 * - 'owner'        = o próprio dono pausou pelo portal (suspended_kind='owner_request').
 *                    Ele retoma sozinho em /conectar. NUNCA é cobrança.
 * - 'inadimplencia'= cobrança de verdade: suspended_kind='billing' OU billing.status
 *                    overdue/suspended. ÚNICO caso que fala em mensalidade.
 * - 'startap_outro'= suspenso pela Startap por outro motivo (manual_other/abuse) ou
 *                    pausa legada sem categoria + sem sinal de inadimplência -> suporte.
 */
export type MotivoPausa = 'owner' | 'inadimplencia' | 'startap_outro';

type StatusParaMotivo = Pick<StatusResponse, 'flow_enabled' | 'suspended_kind' | 'billing'>;

/** null = atendimento ativo (flow_enabled=true). Senão, o porquê da pausa. */
export function resolveMotivoPausa(status: StatusParaMotivo): MotivoPausa | null {
  if (status.flow_enabled) return null;

  // Pausa do próprio dono: jamais tratar como cobrança, mesmo que o vencimento
  // esteja próximo — ele desligou de propósito e retoma quando quiser.
  if (status.suspended_kind === 'owner_request') return 'owner';

  // Inadimplência REAL: a Startap suspendeu por cobrança, OU o billing está
  // vencido/suspenso. Só aqui se fala em "regularizar mensalidade".
  if (status.suspended_kind === 'billing') return 'inadimplencia';
  const b = status.billing;
  if (b && (b.status === 'overdue' || b.status === 'suspended')) return 'inadimplencia';

  // Suspenso pela Startap por outro motivo (manual_other/abuse) ou pausa legada:
  // não inventa cobrança — manda falar com o suporte.
  return 'startap_outro';
}

/** Atalho: só `inadimplencia` libera a copy de "regularize a mensalidade". */
export function isInadimplencia(status: StatusParaMotivo): boolean {
  return resolveMotivoPausa(status) === 'inadimplencia';
}
