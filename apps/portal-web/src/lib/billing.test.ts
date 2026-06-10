import { describe, expect, it } from 'vitest';
import type { StatusBilling } from './api-types';
import { computeBillingState, computeBillingView, isDentroDaJanela } from './billing';

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

/**
 * Logica critica ADR 0014: o `state` por data de vencimento derivado de
 * dias_restantes (janela de 7 dias). Decide se a tela auto-gera PIX e se o card
 * mostra o CTA "Pagar". DEVE espelhar computeBillingState do backend.
 */
describe('computeBillingState (regra ADR 0014, janela 7d)', () => {
  it('sem dias -> sem_config (sem PIX, sem CTA)', () => {
    expect(computeBillingState(null)).toBe('sem_config');
    expect(isDentroDaJanela('sem_config')).toBe(false);
  });

  it('d > 7 -> em_dia (fora da janela, sem PIX)', () => {
    for (const d of [8, 12, 30, 365]) {
      expect(computeBillingState(d), `dias=${d}`).toBe('em_dia');
    }
    expect(isDentroDaJanela('em_dia')).toBe(false);
  });

  it('1..7 -> a_vencer (na janela, gera PIX / CTA Pagar)', () => {
    for (const d of [1, 4, 6, 7]) {
      expect(computeBillingState(d), `dias=${d}`).toBe('a_vencer');
    }
    expect(isDentroDaJanela('a_vencer')).toBe(true);
  });

  it('0 ou negativo -> vencido (na janela, gera PIX / CTA Pagar)', () => {
    for (const d of [0, -1, -30]) {
      expect(computeBillingState(d), `dias=${d}`).toBe('vencido');
    }
    expect(isDentroDaJanela('vencido')).toBe(true);
  });

  it('limite da janela: 7 e a_vencer, 8 e em_dia', () => {
    expect(computeBillingState(7)).toBe('a_vencer');
    expect(computeBillingState(8)).toBe('em_dia');
  });
});
