import { describe, expect, it } from 'vitest';
import { advanceDueDate, daysUntilDue } from './client-billing.js';

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
