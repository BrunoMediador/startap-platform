import { describe, expect, it } from 'vitest';
import type { StatusBilling } from './api-types';
import { computeBillingView } from './billing';

/**
 * Logica critica D1: o tom do card de billing por dias restantes.
 *   >=6 -> brand · 1..5 -> amber · <=0 -> danger · sem data -> neutral.
 */
function billing(dias: number | null, next: string | null = '2026-06-30'): StatusBilling {
  return { next_due_date: dias === null ? null : next, dias_restantes: dias, status: 'active' };
}

describe('computeBillingView (regra D1)', () => {
  it('sem billing -> neutral, sem alarme', () => {
    const v = computeBillingView(null);
    expect(v.tone).toBe('neutral');
    expect(v.hasDueDate).toBe(false);
    expect(v.vencido).toBe(false);
    expect(v.proximo).toBe(false);
  });

  it('sem next_due_date -> neutral', () => {
    const v = computeBillingView(billing(null));
    expect(v.tone).toBe('neutral');
    expect(v.hasDueDate).toBe(false);
  });

  it('>= 6 dias -> brand (normal)', () => {
    expect(computeBillingView(billing(12)).tone).toBe('brand');
    expect(computeBillingView(billing(6)).tone).toBe('brand');
  });

  it('1..5 dias -> amber (atencao)', () => {
    for (const d of [1, 2, 3, 4, 5]) {
      const v = computeBillingView(billing(d));
      expect(v.tone, `dias=${d}`).toBe('amber');
      expect(v.proximo).toBe(true);
      expect(v.vencido).toBe(false);
    }
  });

  it('0 ou negativo -> danger (vencido)', () => {
    expect(computeBillingView(billing(0)).tone).toBe('danger');
    expect(computeBillingView(billing(0)).vencido).toBe(true);
    expect(computeBillingView(billing(-3)).tone).toBe('danger');
    expect(computeBillingView(billing(-3)).vencido).toBe(true);
  });
});
