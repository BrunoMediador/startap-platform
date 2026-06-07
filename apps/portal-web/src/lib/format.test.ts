import { describe, expect, it } from 'vitest';
import {
  formatDuracao,
  formatPrecoCents,
  initials,
  maskPhoneDisplay,
  parsePrecoToCents,
} from './format';

describe('formatPrecoCents', () => {
  it('formata centavos em BRL', () => {
    expect(formatPrecoCents(5000)).toMatch(/R\$\s?50,00/);
    expect(formatPrecoCents(0)).toMatch(/R\$\s?0,00/);
    expect(formatPrecoCents(14990)).toMatch(/R\$\s?149,90/);
  });
});

describe('parsePrecoToCents', () => {
  it('aceita virgula decimal e milhar', () => {
    expect(parsePrecoToCents('50,00')).toBe(5000);
    expect(parsePrecoToCents('50')).toBe(5000);
    expect(parsePrecoToCents('1.234,50')).toBe(123450);
    expect(parsePrecoToCents('R$ 35,00')).toBe(3500);
  });
  it('rejeita invalidos', () => {
    expect(parsePrecoToCents('')).toBeNull();
    expect(parsePrecoToCents('abc')).toBeNull();
    expect(parsePrecoToCents('-5')).toBeNull();
  });
});

describe('formatDuracao', () => {
  it('minutos e horas', () => {
    expect(formatDuracao(30)).toBe('30 min');
    expect(formatDuracao(60)).toBe('1h');
    expect(formatDuracao(90)).toBe('1h30');
  });
});

describe('initials', () => {
  it('1 ou 2 palavras', () => {
    expect(initials('Jackson Lima')).toBe('JL');
    expect(initials('Corte')).toBe('CO');
    expect(initials(null)).toBe('?');
    expect(initials('')).toBe('?');
  });
});

describe('maskPhoneDisplay (LGPD na UI)', () => {
  it('mascara o meio, mantem DDD e 2 ultimos digitos', () => {
    const masked = maskPhoneDisplay('5511999990042');
    expect(masked).toContain('(11)');
    expect(masked).toContain('42');
    expect(masked).toContain('•');
    // nunca expoe a sequencia inteira
    expect(masked).not.toContain('99999');
  });
  it('lida com numero sem DDI', () => {
    const masked = maskPhoneDisplay('11999990007');
    expect(masked).toContain('(11)');
    expect(masked).toContain('07');
  });
});
