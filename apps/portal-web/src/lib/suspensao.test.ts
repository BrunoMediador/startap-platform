import { describe, expect, it } from 'vitest';
import type { StatusBilling, StatusResponse } from './api-types';
import { isInadimplencia, resolveMotivoPausa } from './suspensao';

type Over = Partial<Pick<StatusResponse, 'flow_enabled' | 'suspended_kind' | 'billing'>>;
const billing = (over: Partial<StatusBilling> = {}): StatusBilling => ({
  next_due_date: '2026-07-15',
  dias_restantes: 18,
  status: 'active',
  ...over,
});
const st = (over: Over): Pick<StatusResponse, 'flow_enabled' | 'suspended_kind' | 'billing'> => ({
  flow_enabled: false,
  suspended_kind: null,
  billing: billing(),
  ...over,
});

describe('resolveMotivoPausa', () => {
  it('atendimento ativo (flow_enabled=true) -> null', () => {
    expect(resolveMotivoPausa(st({ flow_enabled: true }))).toBeNull();
  });

  it('caso Samuel: owner_request + billing EM DIA -> owner (NUNCA inadimplencia)', () => {
    const s = st({ suspended_kind: 'owner_request', billing: billing({ status: 'active' }) });
    expect(resolveMotivoPausa(s)).toBe('owner');
    expect(isInadimplencia(s)).toBe(false);
  });

  it('owner_request com vencimento próximo ainda é owner (não cobra)', () => {
    const s = st({
      suspended_kind: 'owner_request',
      billing: billing({ status: 'active', dias_restantes: 2 }),
    });
    expect(resolveMotivoPausa(s)).toBe('owner');
  });

  it('suspended_kind=billing -> inadimplencia', () => {
    expect(resolveMotivoPausa(st({ suspended_kind: 'billing' }))).toBe('inadimplencia');
  });

  it('billing.status overdue -> inadimplencia (mesmo sem kind)', () => {
    expect(resolveMotivoPausa(st({ billing: billing({ status: 'overdue' }) }))).toBe(
      'inadimplencia',
    );
  });

  it('billing.status suspended -> inadimplencia', () => {
    expect(resolveMotivoPausa(st({ billing: billing({ status: 'suspended' }) }))).toBe(
      'inadimplencia',
    );
  });

  it('manual_other -> startap_outro (suporte, não mensalidade)', () => {
    const s = st({ suspended_kind: 'manual_other' });
    expect(resolveMotivoPausa(s)).toBe('startap_outro');
    expect(isInadimplencia(s)).toBe(false);
  });

  it('abuse -> startap_outro', () => {
    expect(resolveMotivoPausa(st({ suspended_kind: 'abuse' }))).toBe('startap_outro');
  });

  it('pausa legada (kind null) + billing em dia -> startap_outro (não inventa cobrança)', () => {
    const s = st({ suspended_kind: null, billing: billing({ status: 'active' }) });
    expect(resolveMotivoPausa(s)).toBe('startap_outro');
    expect(isInadimplencia(s)).toBe(false);
  });

  it('pausado sem billing configurado + kind null -> startap_outro', () => {
    expect(resolveMotivoPausa(st({ suspended_kind: null, billing: null }))).toBe('startap_outro');
  });
});
