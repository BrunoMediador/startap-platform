/** Lógica pura do card de pausa/retomada em /conectar (ADR 0037). */
import { ApiError } from './api';
import type {
  BotPauseResponse,
  BotResumeResponse,
  ConexaoResponse,
  OperationalState,
} from './api-types';

export type PausaEstado =
  | 'ativo'
  | 'habilitado_desconectado'
  | 'habilitado_falha'
  | 'pausado_self'
  | 'bloqueado_billing'
  | 'pausado_startap_manual'
  | 'pausado_startap_abuse'
  | 'estado_desconhecido';

export interface PausaSnapshot {
  bot_paused?: boolean;
  pause_self?: boolean;
  pause_locked?: boolean;
  operational_state?: OperationalState;
}

export interface PausaPresentation {
  estado: PausaEstado;
  tone: 'ok' | 'danger' | 'warn' | 'amber' | 'info';
  badge: string;
  body: string;
  switchChecked: boolean;
  canPause: boolean;
  canResume: boolean;
  locked: boolean;
  action: 'resume' | 'billing' | 'support' | null;
}

export interface ResumeErrorView {
  kind: 'billing' | 'startap_billing' | 'startap_manual' | 'startap_abuse' | 'generic';
  message: string;
  action: 'billing' | 'support' | 'retry';
}

type FeedbackFocusTarget = { focus: () => void };

/**
 * Foca o alerta somente quando ele já existe após o commit React. O retorno
 * explícito mantém o contrato testável no harness Node do portal (sem jsdom).
 */
export function focusPausaErrorFeedbackAfterCommit(
  kind: 'success' | 'error' | null | undefined,
  target: FeedbackFocusTarget | null,
): boolean {
  if (kind !== 'error' || !target) return false;
  target.focus();
  return true;
}

export function isPausaFeatureOff(data: PausaSnapshot): boolean {
  return typeof data.bot_paused !== 'boolean';
}

/**
 * Só o estado composto pode declarar `ativo` ou liberar Retomar. API antiga
 * degrada para desconhecido: `flow_enabled`/`bot_paused` não carregam o gate de
 * cobrança e poderiam repetir o falso sucesso do SCRUM-170.
 */
export function resolvePausaEstado(data: PausaSnapshot): PausaEstado {
  const state = data.operational_state;
  if (!state) return 'estado_desconhecido';
  if (state.billing.blocking) return 'bloqueado_billing';
  if (state.startap_suspension.active) {
    return state.startap_suspension.kind === 'abuse'
      ? 'pausado_startap_abuse'
      : 'pausado_startap_manual';
  }
  if (state.owner_pause.active) {
    return state.actions.resume_owner.allowed ? 'pausado_self' : 'estado_desconhecido';
  }
  if (
    state.effective === 'working' &&
    state.waha.state === 'working' &&
    state.atendimento.processing &&
    state.atendimento.responding
  ) {
    return 'ativo';
  }
  if (state.waha.state === 'failed') return 'habilitado_falha';
  if (state.waha.state === 'disconnected') return 'habilitado_desconectado';
  return 'estado_desconhecido';
}

export function resolvePausaPresentation(data: PausaSnapshot): PausaPresentation {
  const estado = resolvePausaEstado(data);
  const ownerPreserved = data.operational_state?.owner_pause.active === true;

  if (estado === 'ativo') {
    return {
      estado,
      tone: 'ok',
      badge: 'Ativo',
      body: 'O assistente está respondendo no WhatsApp agora.',
      switchChecked: true,
      canPause: true,
      canResume: false,
      locked: false,
      action: null,
    };
  }
  if (estado === 'habilitado_desconectado' || estado === 'habilitado_falha') {
    const failed = estado === 'habilitado_falha';
    return {
      estado,
      tone: 'danger',
      badge: failed ? 'Falha no WhatsApp' : 'WhatsApp desconectado',
      body: failed
        ? 'O atendimento está habilitado, mas não responde porque a conexão do WhatsApp falhou.'
        : 'O atendimento está habilitado, mas não responde enquanto o WhatsApp estiver desconectado.',
      switchChecked: true,
      canPause: true,
      canResume: false,
      locked: false,
      action: null,
    };
  }
  if (estado === 'pausado_self') {
    return {
      estado,
      tone: 'amber',
      badge: 'Pausado por você',
      body: 'O assistente não responde, mas continua processando as pausas que você configurar.',
      switchChecked: false,
      canPause: false,
      canResume: true,
      locked: false,
      action: 'resume',
    };
  }
  if (estado === 'bloqueado_billing') {
    return {
      estado,
      tone: 'danger',
      badge: 'Pagamento pendente',
      body: ownerPreserved
        ? 'O pagamento bloqueia o atendimento e sua pausa continua ativa. Depois de pagar, você ainda precisará retomar quando quiser.'
        : 'O pagamento pendente bloqueia o processamento e as respostas do atendimento.',
      switchChecked: false,
      canPause: false,
      canResume: false,
      locked: true,
      action: 'billing',
    };
  }
  if (estado === 'pausado_startap_abuse') {
    return {
      estado,
      tone: 'warn',
      badge: 'Conta em análise',
      body: 'O atendimento está suspenso pela Startap. Fale com o suporte para revisar a situação.',
      switchChecked: false,
      canPause: false,
      canResume: false,
      locked: true,
      action: 'support',
    };
  }
  if (estado === 'pausado_startap_manual') {
    return {
      estado,
      tone: 'warn',
      badge: 'Suspenso pela Startap',
      body: 'O atendimento está suspenso pela Startap. Fale com o suporte para revisar a situação.',
      switchChecked: false,
      canPause: false,
      canResume: false,
      locked: true,
      action: 'support',
    };
  }
  return {
    estado,
    tone: 'info',
    badge: 'Estado indisponível',
    body: 'Não foi possível confirmar o estado final do atendimento. Atualize a página e tente novamente.',
    switchChecked: false,
    canPause: false,
    canResume: false,
    locked: true,
    action: null,
  };
}

/** Ativo significa respondendo de verdade, não apenas ausência de owner pause. */
export function isAtendimentoLigado(estado: PausaEstado): boolean {
  return estado === 'ativo';
}

export function isPausaTravada(estado: PausaEstado): boolean {
  return !['ativo', 'habilitado_desconectado', 'habilitado_falha', 'pausado_self'].includes(estado);
}

export const MSG_SUSPENSAO_STARTAP =
  'Seu atendimento foi pausado pela Startap. Fale com o suporte.';

/** Aplica apenas um snapshot FINAL composto. Sem snapshot, mantém o cache anterior. */
export function conexaoFromBotActionResponse(
  prev: ConexaoResponse,
  response: BotPauseResponse | BotResumeResponse,
): ConexaoResponse {
  const state = response.operational_state;
  if (!state) return prev;
  return {
    ...prev,
    operational_state: state,
    bot_paused: response.bot_paused,
    pause_self: state.owner_pause.active,
    pause_locked: state.billing.blocking || state.startap_suspension.active,
  };
}

function errorField(body: unknown, field: string): string | null {
  if (!body || typeof body !== 'object') return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}

export function resolveResumeError(error: unknown): ResumeErrorView {
  if (!(error instanceof ApiError) || error.status !== 409) {
    return {
      kind: 'generic',
      message:
        error instanceof ApiError && error.status === 0
          ? 'Sem conexão. Verifique sua internet e tente novamente.'
          : 'Não foi possível atualizar o atendimento. Tente novamente.',
      action: 'retry',
    };
  }

  const code = errorField(error.body, 'error');
  const kind = errorField(error.body, 'suspension_kind');
  const denied = errorField(error.body, 'denied_reason');
  if (code === 'billing_overdue') {
    return {
      kind: 'billing',
      message:
        'O pagamento está pendente e impede a retomada. Sua pausa continua ativa; regularize a mensalidade primeiro.',
      action: 'billing',
    };
  }
  if (code === 'suspensao_startap' && (kind === 'billing' || denied === 'startap_billing')) {
    return {
      kind: 'startap_billing',
      message: 'A suspensão de cobrança continua ativa. Regularize a mensalidade para continuar.',
      action: 'billing',
    };
  }
  if (code === 'suspensao_startap' && (kind === 'abuse' || denied === 'startap_abuse')) {
    return {
      kind: 'startap_abuse',
      message: 'A conta está em análise pela Startap. Fale com o suporte para revisar a situação.',
      action: 'support',
    };
  }
  if (code === 'suspensao_startap') {
    return {
      kind: 'startap_manual',
      message: MSG_SUSPENSAO_STARTAP,
      action: 'support',
    };
  }
  return {
    kind: 'generic',
    message: 'Não foi possível atualizar o atendimento. Tente novamente.',
    action: 'retry',
  };
}

export function resumeSuccessMessage(state: OperationalState | undefined): string {
  if (!state) return 'Solicitação concluída. Atualize a página para confirmar o estado.';
  if (state.owner_pause.active) return 'Sua pausa continua ativa.';
  if (state.billing.blocking) return 'O pagamento ainda bloqueia o atendimento.';
  if (state.startap_suspension.active) return 'A suspensão da Startap continua ativa.';
  if (
    state.effective === 'working' &&
    state.waha.state === 'working' &&
    state.atendimento.responding
  ) {
    return 'Pausa removida. O atendimento está respondendo no WhatsApp.';
  }
  if (state.waha.state === 'failed') {
    return 'Pausa removida. Reconecte o WhatsApp, cuja conexão falhou.';
  }
  if (state.waha.state === 'disconnected') {
    return 'Pausa removida. Reconecte o WhatsApp para o atendimento responder.';
  }
  return 'Pausa removida. O estado do WhatsApp ainda não pôde ser confirmado.';
}
