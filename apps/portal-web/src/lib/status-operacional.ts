/**
 * Apresentação pura do estado operacional composto na Home.
 *
 * O backend é a única fonte da fórmula de carência/bloqueio. Aqui só ordenamos
 * e nomeamos os eixos já projetados. Na ausência do contrato novo, o fallback é
 * deliberadamente fail-closed: conexão WORKING não basta para afirmar que o
 * atendimento está ativo.
 */
import type { OperationalState, StatusResponse, WahaOperationalState } from './api-types';

export type StatusHeroKind =
  | 'active'
  | 'owner_pause'
  | 'billing_block'
  | 'startap_manual'
  | 'startap_abuse'
  | 'waha_disconnected'
  | 'waha_failed'
  | 'unknown';

export type StatusHeroTone = 'ok' | 'danger' | 'warn' | 'amber' | 'info';

export interface StatusHeroView {
  kind: StatusHeroKind;
  tone: StatusHeroTone;
  title: string;
  description: string;
  badge: string;
  context: string;
  href: '/conectar' | '/mensalidade' | null;
  ariaLabel: string | null;
  wahaLabel: string;
  atendimentoLabel: string;
  trulyActive: boolean;
  ownerPauseAlsoActive: boolean;
}

function normalizeLegacyWaha(raw: string | null | undefined): WahaOperationalState {
  const status = raw?.trim().toUpperCase();
  if (status === 'WORKING') return 'working';
  if (status === 'FAILED') return 'failed';
  if (!status || status === 'UNKNOWN') return 'unknown';
  return 'disconnected';
}

function wahaLabel(state: WahaOperationalState): string {
  if (state === 'working') return 'WhatsApp conectado';
  if (state === 'failed') return 'Falha no WhatsApp';
  if (state === 'disconnected') return 'WhatsApp desconectado';
  return 'Status do WhatsApp indisponível';
}

function atendimentoLabel(state: OperationalState): string {
  if (!state.atendimento.configured) return 'Atendimento não configurado';
  if (state.waha.state !== 'working') return 'Atendimento sem responder';
  if (state.atendimento.responding) return 'Atendimento respondendo';
  if (state.atendimento.processing) return 'Processando sem responder';
  return 'Atendimento bloqueado';
}

function base(
  state: OperationalState,
  view: Omit<
    StatusHeroView,
    'wahaLabel' | 'atendimentoLabel' | 'trulyActive' | 'ownerPauseAlsoActive'
  >,
): StatusHeroView {
  const trulyActive =
    state.effective === 'working' &&
    state.waha.state === 'working' &&
    state.atendimento.processing &&
    state.atendimento.responding;
  return {
    ...view,
    wahaLabel: wahaLabel(state.waha.state),
    atendimentoLabel: atendimentoLabel(state),
    trulyActive,
    ownerPauseAlsoActive: state.owner_pause.active,
  };
}

function resolveComposed(state: OperationalState): StatusHeroView {
  if (state.billing.blocking) {
    const ownerAlso = state.owner_pause.active;
    return base(state, {
      kind: 'billing_block',
      tone: 'danger',
      title: 'Pagamento pendente',
      description: ownerAlso
        ? 'O atendimento está bloqueado e sua pausa continua ativa.'
        : 'O atendimento está bloqueado até a confirmação do pagamento.',
      badge: 'Bloqueado',
      context: ownerAlso
        ? 'pagamento pendente; sua pausa será preservada.'
        : 'pagamento pendente bloqueando o atendimento.',
      href: '/mensalidade',
      ariaLabel: 'Pagamento pendente bloqueando o atendimento — ver mensalidade',
    });
  }

  if (state.startap_suspension.active) {
    const abuse = state.startap_suspension.kind === 'abuse';
    return base(state, {
      kind: abuse ? 'startap_abuse' : 'startap_manual',
      tone: 'warn',
      title: abuse ? 'Conta em análise pela Startap' : 'Atendimento suspenso pela Startap',
      description: 'Fale com o suporte para revisar a suspensão.',
      badge: 'Suspenso',
      context: 'atendimento suspenso; fale com o suporte.',
      href: null,
      ariaLabel: null,
    });
  }

  if (state.owner_pause.active) {
    return base(state, {
      kind: 'owner_pause',
      tone: 'amber',
      title: 'Atendimento pausado por você',
      description: 'Sua pausa está ativa. Retome quando quiser.',
      badge: 'Pausado',
      context: 'você pausou o atendimento — retome quando quiser.',
      href: state.actions.resume_owner.allowed ? '/conectar' : null,
      ariaLabel: state.actions.resume_owner.allowed
        ? 'Atendimento pausado por você — ir para retomar'
        : null,
    });
  }

  if (state.waha.state === 'failed') {
    return base(state, {
      kind: 'waha_failed',
      tone: 'danger',
      title: 'Falha na conexão do WhatsApp',
      description: 'Reconecte para o atendimento voltar a responder.',
      badge: 'Falha',
      context: 'a conexão do WhatsApp falhou — reconecte para voltar.',
      href: '/conectar',
      ariaLabel: 'Falha na conexão do WhatsApp — ir para reconectar',
    });
  }

  if (state.waha.state === 'disconnected') {
    return base(state, {
      kind: 'waha_disconnected',
      tone: 'danger',
      title: 'WhatsApp desconectado',
      description: 'Reconecte para o atendimento voltar a responder.',
      badge: 'Desconectado',
      context: 'o WhatsApp está desconectado — toque no status.',
      href: '/conectar',
      ariaLabel: 'WhatsApp desconectado — ir para reconectar',
    });
  }

  const trulyActive =
    state.effective === 'working' &&
    state.waha.state === 'working' &&
    state.atendimento.processing &&
    state.atendimento.responding;
  if (trulyActive) {
    return base(state, {
      kind: 'active',
      tone: 'ok',
      title: 'Assistente ativo',
      description: 'Atendendo no WhatsApp agora.',
      badge: 'Ativo',
      context: 'tudo rodando por aqui.',
      href: null,
      ariaLabel: null,
    });
  }

  return base(state, {
    kind: 'unknown',
    tone: 'info',
    title: 'Estado do atendimento indisponível',
    description: 'Não foi possível confirmar se o assistente está respondendo.',
    badge: 'Indisponível',
    context: 'estamos confirmando o estado do atendimento.',
    href: null,
    ariaLabel: null,
  });
}

function resolveLegacy(status: StatusResponse): StatusHeroView {
  const waha = normalizeLegacyWaha(status.waha.status);
  const common = {
    wahaLabel: wahaLabel(waha),
    trulyActive: false,
    ownerPauseAlsoActive: status.suspended_kind === 'owner_request',
  };

  if (!status.flow_enabled && status.suspended_kind === 'owner_request') {
    return {
      ...common,
      kind: 'owner_pause',
      tone: 'amber',
      title: 'Atendimento pausado por você',
      description: 'Atualize a página para confirmar quando será possível retomar.',
      badge: 'Pausado',
      context: 'você pausou o atendimento.',
      href: null,
      ariaLabel: null,
      atendimentoLabel: 'Atendimento sem responder',
    };
  }

  if (!status.flow_enabled && status.suspended_kind === 'billing') {
    return {
      ...common,
      kind: 'billing_block',
      tone: 'danger',
      title: 'Pagamento pendente',
      description: 'O atendimento está bloqueado até a confirmação do pagamento.',
      badge: 'Bloqueado',
      context: 'pagamento pendente bloqueando o atendimento.',
      href: '/mensalidade',
      ariaLabel: 'Pagamento pendente bloqueando o atendimento — ver mensalidade',
      atendimentoLabel: 'Atendimento bloqueado',
    };
  }

  if (!status.flow_enabled) {
    const abuse = status.suspended_kind === 'abuse';
    return {
      ...common,
      kind: abuse ? 'startap_abuse' : 'startap_manual',
      tone: 'warn',
      title: abuse ? 'Conta em análise pela Startap' : 'Atendimento suspenso pela Startap',
      description: 'Fale com o suporte para revisar a suspensão.',
      badge: 'Suspenso',
      context: 'atendimento suspenso; fale com o suporte.',
      href: null,
      ariaLabel: null,
      atendimentoLabel: 'Atendimento bloqueado',
    };
  }

  if (waha === 'failed' || waha === 'disconnected') {
    const failed = waha === 'failed';
    return {
      ...common,
      kind: failed ? 'waha_failed' : 'waha_disconnected',
      tone: 'danger',
      title: failed ? 'Falha na conexão do WhatsApp' : 'WhatsApp desconectado',
      description: 'Reconecte para o atendimento voltar a responder.',
      badge: failed ? 'Falha' : 'Desconectado',
      context: failed
        ? 'a conexão do WhatsApp falhou — reconecte para voltar.'
        : 'o WhatsApp está desconectado — toque no status.',
      href: '/conectar',
      ariaLabel: failed
        ? 'Falha na conexão do WhatsApp — ir para reconectar'
        : 'WhatsApp desconectado — ir para reconectar',
      atendimentoLabel: 'Atendimento sem responder',
    };
  }

  // Mesmo com WAHA WORKING, a API antiga não confirma gate de billing nem se o
  // atendimento realmente responde. Nunca transformar ausência de contrato em ativo.
  return {
    ...common,
    kind: 'unknown',
    tone: 'info',
    title: 'Confirmando estado do atendimento',
    description: 'Atualize a página em instantes para ver o estado completo.',
    badge: 'Confirmando',
    context: 'estamos confirmando o estado do atendimento.',
    href: null,
    ariaLabel: null,
    atendimentoLabel: 'Resposta ainda não confirmada',
  };
}

export function resolveStatusHeroView(status: StatusResponse): StatusHeroView {
  return status.operational_state
    ? resolveComposed(status.operational_state)
    : resolveLegacy(status);
}
