import { describe, expect, it } from 'vitest';
import { resolveSilenceGate } from './silence-gate.js';

/** daysUntilDue determinístico pra teste: recebe o mapa fixo do cenário. */
function fixedDaysUntilDue(days: number | null) {
  return (_nextDueDate: string | null) => days;
}

describe('resolveSilenceGate (gate único de silêncio total)', () => {
  it('flow_enabled=false -> silenced (flow-suspended), mesmo em dia', () => {
    const result = resolveSilenceGate(
      { flow_enabled: false, next_due_date: '2099-01-01', billing_amount_cents: 8500 },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(9999), billingOverdueSilenceOn: true },
    );
    expect(result).toEqual({ silenced: true, reason: 'flow-suspended', diasRestantes: null });
  });

  it('vencido além da carência + flag ON -> silenced (billing-overdue)', () => {
    const result = resolveSilenceGate(
      { flow_enabled: true, next_due_date: '2026-01-01', billing_amount_cents: 8500 },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(-4), billingOverdueSilenceOn: true },
    );
    expect(result).toEqual({ silenced: true, reason: 'billing-overdue', diasRestantes: -4 });
  });

  it('vencido dentro da carência (-3, último dia) -> NÃO silencia', () => {
    const result = resolveSilenceGate(
      { flow_enabled: true, next_due_date: '2026-01-01', billing_amount_cents: 8500 },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(-3), billingOverdueSilenceOn: true },
    );
    expect(result).toEqual({ silenced: false });
  });

  it('flag OFF -> nunca silencia por vencimento (só o eixo manual continua valendo)', () => {
    const result = resolveSilenceGate(
      { flow_enabled: true, next_due_date: '2026-01-01', billing_amount_cents: 8500 },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(-30), billingOverdueSilenceOn: false },
    );
    expect(result).toEqual({ silenced: false });
  });

  it('sem billing (next_due_date null) -> nunca silencia por vencimento', () => {
    const result = resolveSilenceGate(
      { flow_enabled: true, next_due_date: null, billing_amount_cents: 8500 },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(-30), billingOverdueSilenceOn: true },
    );
    expect(result).toEqual({ silenced: false });
  });

  it('amount_cents=0 (guard) -> nunca silencia por vencimento mesmo vencido', () => {
    const result = resolveSilenceGate(
      { flow_enabled: true, next_due_date: '2026-01-01', billing_amount_cents: 0 },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(-30), billingOverdueSilenceOn: true },
    );
    expect(result).toEqual({ silenced: false });
  });

  it('em dia (diasRestantes positivo) -> NÃO silencia', () => {
    const result = resolveSilenceGate(
      { flow_enabled: true, next_due_date: '2026-12-01', billing_amount_cents: 8500 },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(20), billingOverdueSilenceOn: true },
    );
    expect(result).toEqual({ silenced: false });
  });

  it('suspensão manual tem precedência no motivo sobre vencido (ambos os eixos true)', () => {
    const result = resolveSilenceGate(
      { flow_enabled: false, next_due_date: '2026-01-01', billing_amount_cents: 8500 },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(-100), billingOverdueSilenceOn: true },
    );
    expect(result.silenced).toBe(true);
    if (result.silenced) expect(result.reason).toBe('flow-suspended');
  });
});
