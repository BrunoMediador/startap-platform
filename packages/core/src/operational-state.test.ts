import { describe, expect, it } from 'vitest';
import { projectOperationalState } from './operational-state.js';

function deps(days: number | null) {
  return {
    graceDays: 3,
    daysUntilDue: () => days,
    billingOverdueSilenceOn: true,
  };
}

function input(overrides: Partial<Parameters<typeof projectOperationalState>[0]> = {}) {
  return {
    atendimentoConfigured: true,
    wahaStatus: 'WORKING',
    flow_enabled: true,
    suspended_kind: null,
    next_due_date: '2099-01-01',
    billing_amount_cents: 8500,
    ...overrides,
  };
}

describe('projectOperationalState', () => {
  it('projeta clone ativo em dia e normaliza WAHA WORKING', () => {
    expect(projectOperationalState(input(), deps(30))).toEqual({
      waha: { state: 'working' },
      atendimento: { configured: true, processing: true, responding: true },
      owner_pause: { active: false },
      billing: { blocking: false, dias_restantes: 30 },
      startap_suspension: { active: false, kind: null },
      effective: 'working',
      actions: { resume_owner: { allowed: true, denied_reason: null } },
    });
  });

  it('owner_request em dia processa sem responder e permite retomada', () => {
    const state = projectOperationalState(
      input({ flow_enabled: false, suspended_kind: 'owner_request' }),
      deps(10),
    );
    expect(state.atendimento).toEqual({ configured: true, processing: true, responding: false });
    expect(state.owner_pause.active).toBe(true);
    expect(state.billing.blocking).toBe(false);
    expect(state.effective).toBe('paused_by_owner');
    expect(state.actions.resume_owner).toEqual({ allowed: true, denied_reason: null });
  });

  it('owner_request overdue além da carência mantém os eixos independentes e bloqueia resume', () => {
    const state = projectOperationalState(
      input({ flow_enabled: false, suspended_kind: 'owner_request' }),
      deps(-4),
    );
    expect(state.owner_pause.active).toBe(true);
    expect(state.billing).toEqual({ blocking: true, dias_restantes: -4 });
    expect(state.atendimento).toEqual({ configured: true, processing: false, responding: false });
    expect(state.effective).toBe('blocked_billing');
    expect(state.actions.resume_owner).toEqual({
      allowed: false,
      denied_reason: 'billing_overdue',
    });
  });

  it('flag billing OFF mantém owner overdue como pausa respond=false, sem bloqueio derivado', () => {
    const state = projectOperationalState(
      input({ flow_enabled: false, suspended_kind: 'owner_request' }),
      { ...deps(-20), billingOverdueSilenceOn: false },
    );
    expect(state.owner_pause.active).toBe(true);
    expect(state.billing.blocking).toBe(false);
    expect(state.atendimento).toEqual({ configured: true, processing: true, responding: false });
    expect(state.actions.resume_owner).toEqual({ allowed: true, denied_reason: null });
  });

  it.each([
    ['billing', 'blocked_billing', 'startap_billing'],
    ['manual_other', 'blocked_startap', 'startap_manual_other'],
    ['abuse', 'blocked_startap', 'startap_abuse'],
  ] as const)(
    'classifica suspensão Startap %s sem vazar motivo livre',
    (kind, effective, reason) => {
      const state = projectOperationalState(
        input({ flow_enabled: false, suspended_kind: kind }),
        deps(20),
      );
      expect(state.startap_suspension).toEqual({ active: true, kind });
      expect(state.atendimento.processing).toBe(false);
      expect(state.effective).toBe(effective);
      expect(state.actions.resume_owner).toEqual({ allowed: false, denied_reason: reason });
    },
  );

  it.each([
    ['STOPPED', 'disconnected'],
    ['SCAN_QR_CODE', 'disconnected'],
    ['FAILED', 'failed'],
    ['unknown', 'unknown'],
    [null, 'unknown'],
  ] as const)('mantém WAHA como eixo próprio: %s -> %s', (raw, expected) => {
    const state = projectOperationalState(input({ wahaStatus: raw }), deps(20));
    expect(state.waha.state).toBe(expected);
  });

  it('atendimento sem configuração estrutural não processa e fica unknown', () => {
    const state = projectOperationalState(input({ atendimentoConfigured: false }), deps(20));
    expect(state.atendimento).toEqual({ configured: false, processing: false, responding: false });
    expect(state.effective).toBe('unknown');
  });
});
