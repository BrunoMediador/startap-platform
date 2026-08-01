import { describe, expect, it } from 'vitest';
import { OCORRENCIAS_MAX, OCORRENCIAS_MIN, expandirDatas } from './recorrencia.js';

describe('expandirDatas', () => {
  it('semanal: soma 7 dias por ocorrencia, inclui a ancora como 1a', () => {
    expect(expandirDatas('2026-08-03', 'semanal', 4)).toEqual([
      '2026-08-03',
      '2026-08-10',
      '2026-08-17',
      '2026-08-24',
    ]);
  });

  it('semanal: atravessa virada de mes/ano sem erro', () => {
    expect(expandirDatas('2026-12-28', 'semanal', 3)).toEqual([
      '2026-12-28',
      '2027-01-04',
      '2027-01-11',
    ]);
  });

  it('mensal: caso difícil — 31/01 clampa no ultimo dia do mes de destino', () => {
    // 31/01 -> fev nao tem 31 -> clampa 28 (2026 nao e bissexto) -> mar tem 31 -> volta a 31.
    expect(expandirDatas('2026-01-31', 'mensal', 3)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
    ]);
  });

  it('mensal: 31/01 em ano bissexto clampa em 29/02', () => {
    expect(expandirDatas('2028-01-31', 'mensal', 2)).toEqual(['2028-01-31', '2028-02-29']);
  });

  it('trimestral: soma 3 meses por ocorrencia, com clamp quando aplicavel', () => {
    expect(expandirDatas('2026-11-30', 'trimestral', 3)).toEqual([
      '2026-11-30',
      '2027-02-28', // fev nao tem 30 -> clampa 28 (2027 nao bissexto)
      '2027-05-30',
    ]);
  });

  it('semestral: soma 6 meses por ocorrencia, atravessa ano', () => {
    expect(expandirDatas('2026-08-15', 'semestral', 3)).toEqual([
      '2026-08-15',
      '2027-02-15',
      '2027-08-15',
    ]);
  });

  it('mensal: dia comum (15) nunca clampa e atravessa virada de ano', () => {
    expect(expandirDatas('2026-11-15', 'mensal', 4)).toEqual([
      '2026-11-15',
      '2026-12-15',
      '2027-01-15',
      '2027-02-15',
    ]);
  });

  it('rejeita ocorrencias abaixo do minimo', () => {
    expect(() => expandirDatas('2026-08-03', 'semanal', OCORRENCIAS_MIN - 1)).toThrow();
  });

  it('rejeita ocorrencias acima do maximo', () => {
    expect(() => expandirDatas('2026-08-03', 'semanal', OCORRENCIAS_MAX + 1)).toThrow();
  });

  it('aceita os limites min e max', () => {
    expect(expandirDatas('2026-08-03', 'semanal', OCORRENCIAS_MIN)).toHaveLength(OCORRENCIAS_MIN);
    expect(expandirDatas('2026-08-03', 'semanal', OCORRENCIAS_MAX)).toHaveLength(OCORRENCIAS_MAX);
  });

  it('rejeita data-ancora em formato invalido', () => {
    expect(() => expandirDatas('03-08-2026', 'semanal', 3)).toThrow();
  });
});
