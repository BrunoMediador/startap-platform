import {
  OWNER_PAUSE_KIND,
  type SilenceGateCloneInput,
  type SilenceGateDeps,
  resolveSilenceGate,
} from './silence-gate.js';

export type WahaOperationalState = 'working' | 'disconnected' | 'failed' | 'unknown';
export type PublicStartapSuspensionKind = 'billing' | 'manual_other' | 'abuse';
export type EffectiveOperationalState =
  | 'working'
  | 'disconnected'
  | 'paused_by_owner'
  | 'blocked_billing'
  | 'blocked_startap'
  | 'unknown';
export type ResumeOwnerDeniedReason =
  | 'billing_overdue'
  | 'startap_billing'
  | 'startap_manual_other'
  | 'startap_abuse';

export interface OperationalStateInput extends SilenceGateCloneInput {
  /** Existe configuração estrutural suficiente para o atendimento deste clone. */
  atendimentoConfigured: boolean;
  /** Status bruto do WAHA. Ausência/erro de leitura deve chegar como `unknown`. */
  wahaStatus: string | null | undefined;
}

export interface ComposedOperationalState {
  waha: { state: WahaOperationalState };
  atendimento: {
    configured: boolean;
    processing: boolean;
    responding: boolean;
  };
  owner_pause: { active: boolean };
  billing: { blocking: boolean; dias_restantes: number | null };
  startap_suspension: {
    active: boolean;
    kind: PublicStartapSuspensionKind | null;
  };
  effective: EffectiveOperationalState;
  actions: {
    resume_owner: {
      allowed: boolean;
      denied_reason: ResumeOwnerDeniedReason | null;
    };
  };
}

export function normalizeWahaOperationalState(
  rawStatus: string | null | undefined,
): WahaOperationalState {
  const status = rawStatus?.trim().toUpperCase();
  if (!status || status === 'UNKNOWN') return 'unknown';
  if (status === 'WORKING') return 'working';
  if (status === 'FAILED') return 'failed';
  return 'disconnected';
}

function publicStartapKind(kind: string | null): PublicStartapSuspensionKind | null {
  if (kind === 'billing' || kind === 'manual_other' || kind === 'abuse') return kind;
  // Categoria futura/desconhecida continua bloqueando pelo gate, mas não vaza literal interno.
  if (kind != null && kind !== OWNER_PAUSE_KIND) return 'manual_other';
  return null;
}

function deniedReason(
  startapKind: PublicStartapSuspensionKind | null,
  billingOverdue: boolean,
): ResumeOwnerDeniedReason | null {
  if (startapKind === 'billing') return 'startap_billing';
  if (startapKind === 'manual_other') return 'startap_manual_other';
  if (startapKind === 'abuse') return 'startap_abuse';
  if (billingOverdue) return 'billing_overdue';
  return null;
}

/**
 * Projeta os eixos independentes do estado operacional em um contrato público seguro.
 * A decisão de silêncio/processamento/resposta pertence exclusivamente a
 * `resolveSilenceGate`; esta função não reproduz fórmula de carência ou precedência.
 */
export function projectOperationalState(
  input: OperationalStateInput,
  deps: SilenceGateDeps,
): ComposedOperationalState {
  const gate = resolveSilenceGate(input, deps);
  const wahaState = normalizeWahaOperationalState(input.wahaStatus);
  const ownerPauseActive =
    input.flow_enabled === false && input.suspended_kind === OWNER_PAUSE_KIND;
  const startapKind = input.flow_enabled === false ? publicStartapKind(input.suspended_kind) : null;
  const startapActive = startapKind != null;
  const billingOverdue = gate.silenced && gate.reason === 'billing-overdue';
  const billingBlocking = billingOverdue || startapKind === 'billing';
  const processing = input.atendimentoConfigured && !gate.silenced;
  const responding = processing && !gate.silenced && gate.respond;
  const reason = deniedReason(startapKind, billingOverdue);

  let effective: EffectiveOperationalState;
  if (!input.atendimentoConfigured) effective = 'unknown';
  else if (billingBlocking) effective = 'blocked_billing';
  else if (startapActive) effective = 'blocked_startap';
  else if (ownerPauseActive) effective = 'paused_by_owner';
  else if (wahaState === 'working') effective = 'working';
  else if (wahaState === 'unknown') effective = 'unknown';
  else effective = 'disconnected';

  return {
    waha: { state: wahaState },
    atendimento: {
      configured: input.atendimentoConfigured,
      processing,
      responding,
    },
    owner_pause: { active: ownerPauseActive },
    billing: {
      blocking: billingBlocking,
      dias_restantes: deps.daysUntilDue(input.next_due_date),
    },
    startap_suspension: { active: startapActive, kind: startapKind },
    effective,
    actions: {
      resume_owner: {
        allowed: reason == null,
        denied_reason: reason,
      },
    },
  };
}
