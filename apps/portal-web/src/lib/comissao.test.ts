import { describe, expect, it } from 'vitest';
import { formatPctComissao } from './comissao';

describe('formatPctComissao', () => {
  it('inteiro vira "10%"', () => {
    expect(formatPctComissao(10)).toBe('10%');
  });

  it('fração usa vírgula pt-BR e tira zeros à toa: 12.5 -> "12,5%"', () => {
    expect(formatPctComissao(12.5)).toBe('12,5%');
    expect(formatPctComissao(10.0)).toBe('10%');
  });

  it('zero é uma % válida (profissional com 0% configurado)', () => {
    expect(formatPctComissao(0)).toBe('0%');
  });

  it('null (não configurada) vira "—", nunca null/0 cru — evita o bug de tipo do #344', () => {
    expect(formatPctComissao(null)).toBe('—');
  });

  it('valores inválidos (NaN/negativo) caem em "—" defensivamente', () => {
    expect(formatPctComissao(Number.NaN)).toBe('—');
    expect(formatPctComissao(-5)).toBe('—');
  });
});
