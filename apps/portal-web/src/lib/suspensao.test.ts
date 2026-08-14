import { describe, expect, it } from 'vitest';
import type { OperationalState, StatusBilling, StatusResponse } from './api-types';
import { isInadimplencia, resolveAvisoSuspensao, resolveMotivoPausa } from './suspensao';

const billing = (over: Partial<StatusBilling> = {}): StatusBilling => ({
  next_due_date: '2026-08-30',
  dias_restantes: 17,
  status: 'active',
  ...over,
});

function op(
  over: Partial<{
    owner: boolean;
    billing: boolean;
    startap: 'billing' | 'manual_other' | 'abuse' | null;
  }> = {},
): OperationalState {
  const owner = over.owner ?? false;
  const blocked = over.billing ?? false;
  const startap = over.startap ?? null;
  return {
    waha: { state: 'working' },
    atendimento: {
      configured: true,
      processing: !blocked && !startap,
      responding: !owner && !blocked && !startap,
    },
    owner_pause: { active: owner },
    billing: { blocking: blocked, dias_restantes: blocked ? -1 : 17 },
    startap_suspension: { active: startap != null, kind: startap },
    effective: blocked
      ? 'blocked_billing'
      : startap
        ? 'blocked_startap'
        : owner
          ? 'paused_by_owner'
          : 'working',
    actions: {
      resume_owner: {
        allowed: !blocked && !startap,
        denied_reason: blocked
          ? 'billing_overdue'
          : startap === 'abuse'
            ? 'startap_abuse'
            : startap === 'billing'
              ? 'startap_billing'
              : startap
                ? 'startap_manual_other'
                : null,
      },
    },
  };
}

function st(
  over: Partial<
    Pick<StatusResponse, 'flow_enabled' | 'suspended_kind' | 'billing' | 'operational_state'>
  > = {},
) {
  return {
    flow_enabled: true,
    suspended_kind: null,
    billing: billing(),
    ...over,
  };
}

describe('resolveMotivoPausa — contrato composto', () => {
  it('owner_request em dia é autonomia do dono, nunca cobrança', () => {
    const status = st({ operational_state: op({ owner: true }) });
    expect(resolveMotivoPausa(status)).toBe('owner');
    expect(isInadimplencia(status)).toBe(false);
  });

  it('owner + overdue prioriza bloqueio financeiro sem apagar owner', () => {
    const status = st({ operational_state: op({ owner: true, billing: true }) });
    expect(resolveMotivoPausa(status)).toBe('inadimplencia');
    const aviso = resolveAvisoSuspensao(status);
    expect(aviso?.ownerPausePreserved).toBe(true);
    expect(aviso?.body).toContain('continuará pausado por você');
  });

  it('billing blocking aparece mesmo com flow_enabled legado true', () => {
    const status = st({ flow_enabled: true, operational_state: op({ billing: true }) });
    expect(resolveMotivoPausa(status)).toBe('inadimplencia');
    expect(resolveAvisoSuspensao(status)?.title).toContain('bloqueando');
  });

  it.each([
    ['manual_other', 'startap_manual'],
    ['abuse', 'startap_abuse'],
  ] as const)('suspensão %s orienta suporte', (kind, expected) => {
    const aviso = resolveAvisoSuspensao(st({ operational_state: op({ startap: kind }) }));
    expect(aviso?.motivo).toBe(expected);
    expect(aviso?.action).toBe('support');
    expect(aviso?.body).toContain('suporte');
  });

  it('estado composto ativo não mostra aviso', () => {
    expect(resolveAvisoSuspensao(st({ operational_state: op() }))).toBeNull();
  });
});

describe('resolveMotivoPausa — fallback de rollout sem fórmula financeira', () => {
  it('API antiga ativa + billing.status overdue NÃO inventa bloqueio', () => {
    const status = st({ flow_enabled: true, billing: billing({ status: 'overdue' }) });
    expect(resolveMotivoPausa(status)).toBeNull();
  });

  it('categorias persistidas explícitas continuam seguras', () => {
    expect(resolveMotivoPausa(st({ flow_enabled: false, suspended_kind: 'owner_request' }))).toBe(
      'owner',
    );
    expect(resolveMotivoPausa(st({ flow_enabled: false, suspended_kind: 'billing' }))).toBe(
      'inadimplencia',
    );
    expect(resolveMotivoPausa(st({ flow_enabled: false, suspended_kind: 'abuse' }))).toBe(
      'startap_abuse',
    );
  });

  it('pausa legada sem categoria nunca vira cobrança', () => {
    const status = st({ flow_enabled: false, suspended_kind: null, billing: null });
    expect(resolveMotivoPausa(status)).toBe('startap_outro');
    expect(isInadimplencia(status)).toBe(false);
  });
});
