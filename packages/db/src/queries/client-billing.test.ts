import { describe, expect, it } from 'vitest';
import {
  advanceDueDate,
  advanceFromMaxDue,
  computeBillingState,
  daysUntilDue,
} from './client-billing.js';

describe('advanceDueDate', () => {
  it('avanca 1 mes preservando o dia', () => {
    expect(advanceDueDate('2026-06-10', 1)).toBe('2026-07-10');
  });

  it('avanca virando o ano', () => {
    expect(advanceDueDate('2026-12-15', 1)).toBe('2027-01-15');
  });

  it('avanca multiplos meses', () => {
    expect(advanceDueDate('2026-01-31', 2)).toBe('2026-03-31');
  });

  it('clampa dia 31 para fim de fevereiro (sem vazar para marco)', () => {
    expect(advanceDueDate('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('respeita ano bissexto (2028 fev tem 29)', () => {
    expect(advanceDueDate('2028-01-31', 1)).toBe('2028-02-29');
  });

  it('clampa 31 -> 30 em meses de 30 dias', () => {
    expect(advanceDueDate('2026-05-31', 1)).toBe('2026-06-30');
  });

  it('lanca em data malformada', () => {
    expect(() => advanceDueDate('10/06/2026')).toThrow();
    expect(() => advanceDueDate('2026-13-01')).not.toThrow(); // formato ok; valor extremo tratado pelo Date
  });
});

describe('daysUntilDue', () => {
  it('retorna positivo quando vencimento no futuro', () => {
    const today = new Date('2026-06-06T12:00:00Z');
    expect(daysUntilDue('2026-06-16', today)).toBe(10);
  });

  it('retorna 0 no dia do vencimento', () => {
    const today = new Date('2026-06-16T23:00:00Z');
    expect(daysUntilDue('2026-06-16', today)).toBe(0);
  });

  it('retorna negativo quando vencido', () => {
    const today = new Date('2026-06-20T00:00:00Z');
    expect(daysUntilDue('2026-06-16', today)).toBe(-4);
  });

  it('retorna null sem next_due_date', () => {
    expect(daysUntilDue(null)).toBeNull();
  });
});

// ─── ADR 0014: computeBillingState (fonte unica do estado) ─────────────────────
describe('computeBillingState (ADR 0014, window=7)', () => {
  // Hoje fixo: 2026-06-10 (UTC meia-noite ancorada por daysUntilDue).
  const HOJE = new Date('2026-06-10T12:00:00Z');

  it('sem_config quando nao ha next_due_date', () => {
    const r = computeBillingState(null, HOJE);
    expect(r.state).toBe('sem_config');
    expect(r.diasRestantes).toBeNull();
    expect(r.dentroDaJanela).toBe(false);
    expect(r.podeGerarPix).toBe(false);
  });

  it('em_dia quando faltam MAIS que 7 dias (d=8)', () => {
    const r = computeBillingState('2026-06-18', HOJE); // d = 8
    expect(r.state).toBe('em_dia');
    expect(r.diasRestantes).toBe(8);
    expect(r.dentroDaJanela).toBe(false);
    expect(r.podeGerarPix).toBe(false);
  });

  it('LIMIAR: d=8 ainda em_dia / d=7 ja a_vencer (fronteira da janela)', () => {
    expect(computeBillingState('2026-06-18', HOJE).state).toBe('em_dia'); // d=8
    expect(computeBillingState('2026-06-17', HOJE).state).toBe('a_vencer'); // d=7
  });

  it('a_vencer quando 1 <= d <= 7', () => {
    for (const [date, d] of [
      ['2026-06-17', 7],
      ['2026-06-13', 3],
      ['2026-06-11', 1],
    ] as const) {
      const r = computeBillingState(date, HOJE);
      expect(r.state, `d=${d}`).toBe('a_vencer');
      expect(r.diasRestantes).toBe(d);
      expect(r.dentroDaJanela).toBe(true);
      expect(r.podeGerarPix).toBe(true);
    }
  });

  it('LIMIAR: d=1 a_vencer / d=0 (hoje) ja vencido', () => {
    expect(computeBillingState('2026-06-11', HOJE).state).toBe('a_vencer'); // d=1
    expect(computeBillingState('2026-06-10', HOJE).state).toBe('vencido'); // d=0
  });

  it('vencido quando d <= 0', () => {
    for (const date of ['2026-06-10', '2026-06-09', '2026-05-01']) {
      const r = computeBillingState(date, HOJE);
      expect(r.state, date).toBe('vencido');
      expect(r.dentroDaJanela).toBe(true);
      expect(r.podeGerarPix).toBe(true);
    }
  });

  it('windowDays customizavel', () => {
    // Com janela de 3 dias, d=5 ainda esta em_dia.
    expect(computeBillingState('2026-06-15', HOJE, 3).state).toBe('em_dia'); // d=5
    expect(computeBillingState('2026-06-13', HOJE, 3).state).toBe('a_vencer'); // d=3
  });
});

// ─── ADR 0014: avanco max(due, hoje) + cycleMonths ─────────────────────────────
describe('advanceFromMaxDue (ADR 0014)', () => {
  const HOJE = new Date('2026-06-10T12:00:00Z');

  it('em dia: parte de next_due_date (nao perde tempo pago)', () => {
    // due no futuro -> max e a propria due. 2026-07-10 + 1 mes = 2026-08-10.
    expect(advanceFromMaxDue('2026-07-10', HOJE)).toBe('2026-08-10');
  });

  it('vencido: parte de HOJE -> NUNCA renova pro passado', () => {
    // venceu 2026-05-01: a partir dela +1mes = 2026-06-01 (ainda passado).
    // max(due, hoje) usa hoje (2026-06-10) +1mes = 2026-07-10 (futuro).
    expect(advanceFromMaxDue('2026-05-01', HOJE)).toBe('2026-07-10');
  });

  it('re-cobranca (data movida pro passado): a partir de hoje', () => {
    expect(advanceFromMaxDue('2020-01-01', HOJE)).toBe('2026-07-10');
  });

  it('vence hoje (d=0): parte de hoje +1mes', () => {
    expect(advanceFromMaxDue('2026-06-10', HOJE)).toBe('2026-07-10');
  });

  it('sem next_due_date: parte de hoje', () => {
    expect(advanceFromMaxDue(null, HOJE)).toBe('2026-07-10');
  });

  it('respeita cycleMonths', () => {
    expect(advanceFromMaxDue('2026-07-10', HOJE, 2)).toBe('2026-09-10');
  });
});
