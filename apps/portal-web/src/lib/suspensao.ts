/**
 * Avisos de pausa/bloqueio da Home.
 *
 * Com `operational_state`, a UI apresenta os eixos já resolvidos pelo backend e
 * nunca recalcula carência. O fallback legado só usa categorias explícitas e
 * `flow_enabled=false`; ele não transforma mero status `overdue` em bloqueio.
 */
import type { StatusResponse } from './api-types';

export type MotivoPausa =
  | 'owner'
  | 'inadimplencia'
  | 'startap_manual'
  | 'startap_abuse'
  | 'startap_outro';

export interface AvisoSuspensao {
  motivo: MotivoPausa;
  title: string;
  body: string;
  action: 'resume' | 'billing' | 'support';
  actionLabel: string;
  ownerPausePreserved: boolean;
}

type StatusParaMotivo = Pick<
  StatusResponse,
  'flow_enabled' | 'suspended_kind' | 'billing' | 'operational_state'
>;

/** null = nenhum bloqueio/pausa que exija aviso persistente. */
export function resolveMotivoPausa(status: StatusParaMotivo): MotivoPausa | null {
  const operational = status.operational_state;
  if (operational) {
    if (operational.billing.blocking) return 'inadimplencia';
    if (operational.startap_suspension.active) {
      return operational.startap_suspension.kind === 'abuse' ? 'startap_abuse' : 'startap_manual';
    }
    if (operational.owner_pause.active) return 'owner';
    return null;
  }

  // Fallback de rollout: só estados persistidos explícitos. Não há fórmula de
  // dias/carência no browser e conta ativa nunca vira cobrança por inferência.
  if (status.flow_enabled) return null;
  if (status.suspended_kind === 'owner_request') return 'owner';
  if (status.suspended_kind === 'billing') return 'inadimplencia';
  if (status.suspended_kind === 'abuse') return 'startap_abuse';
  if (status.suspended_kind === 'manual_other') return 'startap_manual';
  return 'startap_outro';
}

export function resolveAvisoSuspensao(status: StatusParaMotivo): AvisoSuspensao | null {
  const motivo = resolveMotivoPausa(status);
  if (!motivo) return null;

  const ownerPausePreserved =
    motivo === 'inadimplencia' && status.operational_state?.owner_pause.active === true;

  if (motivo === 'owner') {
    return {
      motivo,
      title: 'Você pausou o atendimento',
      body: 'O assistente não responde até você retomar. O WhatsApp segue conectado quando a sessão está saudável.',
      action: 'resume',
      actionLabel: 'Ir para retomar',
      ownerPausePreserved: false,
    };
  }

  if (motivo === 'inadimplencia') {
    return {
      motivo,
      title: 'Pagamento pendente bloqueando o atendimento',
      body: ownerPausePreserved
        ? 'O bloqueio financeiro interrompe o atendimento, mas sua pausa continua registrada. Depois do pagamento, o assistente continuará pausado por você até que escolha retomar.'
        : 'O atendimento não processa nem responde enquanto o pagamento estiver pendente. A confirmação remove somente o bloqueio de cobrança.',
      action: 'billing',
      actionLabel: 'Ver mensalidade',
      ownerPausePreserved,
    };
  }

  if (motivo === 'startap_abuse') {
    return {
      motivo,
      title: 'Conta em análise pela Startap',
      body: 'O atendimento está suspenso e não processa mensagens. Fale com o suporte para revisar a situação.',
      action: 'support',
      actionLabel: 'Falar com o suporte',
      ownerPausePreserved: false,
    };
  }

  return {
    motivo,
    title: 'Atendimento suspenso pela Startap',
    body: 'O atendimento está suspenso e não processa mensagens. Fale com o suporte para revisar a situação.',
    action: 'support',
    actionLabel: 'Falar com o suporte',
    ownerPausePreserved: false,
  };
}

export function isInadimplencia(status: StatusParaMotivo): boolean {
  return resolveMotivoPausa(status) === 'inadimplencia';
}
