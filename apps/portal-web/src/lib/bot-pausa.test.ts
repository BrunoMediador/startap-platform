import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import type {
  EffectiveOperationalState,
  OperationalState,
  StartapSuspensionKind,
  WahaOperationalState,
} from './api-types';
import {
  conexaoFromBotActionResponse,
  focusPausaErrorFeedbackAfterCommit,
  isAtendimentoLigado,
  isPausaFeatureOff,
  isPausaTravada,
  resolvePausaEstado,
  resolvePausaPresentation,
  resolveResumeError,
  resumeSuccessMessage,
} from './bot-pausa';

function op({
  waha = 'working',
  owner = false,
  billing = false,
  startap = null,
  processing = true,
  responding = true,
  effective = 'working',
  allowed = true,
}: {
  waha?: WahaOperationalState;
  owner?: boolean;
  billing?: boolean;
  startap?: StartapSuspensionKind | null;
  processing?: boolean;
  responding?: boolean;
  effective?: EffectiveOperationalState;
  allowed?: boolean;
} = {}): OperationalState {
  return {
    waha: { state: waha },
    atendimento: { configured: true, processing, responding },
    owner_pause: { active: owner },
    billing: { blocking: billing, dias_restantes: billing ? -1 : 9 },
    startap_suspension: { active: startap != null, kind: startap },
    effective,
    actions: {
      resume_owner: {
        allowed,
        denied_reason: allowed
          ? null
          : billing
            ? 'billing_overdue'
            : startap === 'abuse'
              ? 'startap_abuse'
              : startap === 'billing'
                ? 'startap_billing'
                : 'startap_manual_other',
      },
    },
  };
}

const baseConnection = {
  enabled: true,
  session: 'sessao-a',
  status: 'WORKING',
  connected: true,
  needs_action: false,
  has_registered_phone: true,
  registered_phone_masked: '55 11 9••••-1234',
  can_reconnect: false,
  reconnect_cooldown_seconds: 0,
  bot_paused: false,
  pause_self: false,
  pause_locked: false,
};

describe('card de pausa — gate e fallback', () => {
  it('feature OFF continua definida pela ausência de bot_paused', () => {
    expect(isPausaFeatureOff({})).toBe(true);
    expect(isPausaFeatureOff({ bot_paused: false })).toBe(false);
  });

  it('API antiga nunca libera Retomar nem declara ativo', () => {
    expect(resolvePausaEstado({ bot_paused: false })).toBe('estado_desconhecido');
    expect(resolvePausaEstado({ bot_paused: true, pause_self: true, pause_locked: false })).toBe(
      'estado_desconhecido',
    );
    const view = resolvePausaPresentation({ bot_paused: true, pause_self: true });
    expect(view.canResume).toBe(false);
    expect(view.locked).toBe(true);
  });
});

describe('card de pausa — matriz composta', () => {
  it('ativo só quando effective=working + WAHA working + responding', () => {
    expect(resolvePausaEstado({ bot_paused: false, operational_state: op() })).toBe('ativo');
    expect(isAtendimentoLigado('ativo')).toBe(true);

    const uncertain = op({ responding: false, effective: 'working' });
    expect(resolvePausaEstado({ bot_paused: false, operational_state: uncertain })).toBe(
      'estado_desconhecido',
    );
  });

  it.each([
    ['disconnected', 'habilitado_desconectado'],
    ['failed', 'habilitado_falha'],
  ] as const)('WAHA %s fica explícito sem chamar de ativo', (waha, expected) => {
    const state = op({ waha, effective: 'disconnected' });
    const view = resolvePausaPresentation({ bot_paused: false, operational_state: state });
    expect(view.estado).toBe(expected);
    expect(view.badge).toMatch(/WhatsApp/);
    expect(view.canPause).toBe(true);
    expect(isAtendimentoLigado(view.estado)).toBe(false);
  });

  it('owner em dia permite Retomar somente pelo allowed autoritativo', () => {
    const state = op({ owner: true, responding: false, effective: 'paused_by_owner' });
    const view = resolvePausaPresentation({ bot_paused: true, operational_state: state });
    expect(view.estado).toBe('pausado_self');
    expect(view.canResume).toBe(true);
    expect(view.action).toBe('resume');
    expect(isPausaTravada(view.estado)).toBe(false);
  });

  it('owner + overdue bloqueia Retomar, comunica cobrança e preservação da pausa', () => {
    const state = op({
      owner: true,
      billing: true,
      processing: false,
      responding: false,
      effective: 'blocked_billing',
      allowed: false,
    });
    const view = resolvePausaPresentation({ bot_paused: true, operational_state: state });
    expect(view.estado).toBe('bloqueado_billing');
    expect(view.canResume).toBe(false);
    expect(view.action).toBe('billing');
    expect(view.body).toContain('pausa continua ativa');
    expect(isPausaTravada(view.estado)).toBe(true);
  });

  it.each([
    ['manual_other', 'pausado_startap_manual'],
    ['abuse', 'pausado_startap_abuse'],
  ] as const)('Startap %s trava Retomar e orienta suporte', (kind, expected) => {
    const state = op({
      startap: kind,
      processing: false,
      responding: false,
      effective: 'blocked_startap',
      allowed: false,
    });
    const view = resolvePausaPresentation({ bot_paused: true, operational_state: state });
    expect(view.estado).toBe(expected);
    expect(view.canResume).toBe(false);
    expect(view.action).toBe('support');
    expect(view.body).toContain('suporte');
  });
});

describe('cache usa somente resposta final composta', () => {
  it('resposta sem operational_state mantém cache anterior, sem hipótese otimista', () => {
    const previous = { ...baseConnection, operational_state: op() };
    expect(conexaoFromBotActionResponse(previous, { bot_paused: true })).toBe(previous);
  });

  it('resposta final owner+overdue mantém owner e marca lock de billing', () => {
    const state = op({
      owner: true,
      billing: true,
      processing: false,
      responding: false,
      effective: 'blocked_billing',
      allowed: false,
    });
    const next = conexaoFromBotActionResponse(
      { ...baseConnection, operational_state: op() },
      { bot_paused: true, operational_state: state },
    );
    expect(next.pause_self).toBe(true);
    expect(next.pause_locked).toBe(true);
    expect(next.operational_state?.billing.blocking).toBe(true);
  });
});

describe('erros de Retomar são classificados por contrato', () => {
  it('409 billing_overdue orienta mensalidade e confirma owner preservado', () => {
    const view = resolveResumeError(
      new ApiError(409, 'billing_overdue', { error: 'billing_overdue' }),
    );
    expect(view.kind).toBe('billing');
    expect(view.action).toBe('billing');
    expect(view.message).toContain('pausa continua ativa');
  });

  it('foca o feedback do 409 billing_overdue quando o commit disponibiliza o alerta', () => {
    const view = resolveResumeError(
      new ApiError(409, 'billing_overdue', { error: 'billing_overdue' }),
    );
    const focus = vi.fn();

    expect(view.kind).toBe('billing');
    expect(focusPausaErrorFeedbackAfterCommit('error', null)).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(focusPausaErrorFeedbackAfterCommit('error', { focus })).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
  });

  it.each([
    ['billing', 'startap_billing', 'billing'],
    ['manual_other', 'startap_manual', 'support'],
    ['abuse', 'startap_abuse', 'support'],
  ] as const)('409 Startap %s recebe tratamento próprio', (kind, expected, action) => {
    const view = resolveResumeError(
      new ApiError(409, 'suspensao_startap', {
        error: 'suspensao_startap',
        suspension_kind: kind,
      }),
    );
    expect(view.kind).toBe(expected);
    expect(view.action).toBe(action);
  });

  it('erro de rede oferece retry sem inventar estado', () => {
    const view = resolveResumeError(new ApiError(0, 'sem conexao', null));
    expect(view.kind).toBe('generic');
    expect(view.action).toBe('retry');
  });
});

describe('copy pós-resume usa o snapshot final', () => {
  it('não diz retomado quando WhatsApp está desconectado', () => {
    expect(resumeSuccessMessage(op({ waha: 'disconnected', effective: 'disconnected' }))).toContain(
      'Reconecte',
    );
  });

  it('só confirma respostas quando o estado final realmente responde', () => {
    expect(resumeSuccessMessage(op())).toContain('respondendo');
  });
});
