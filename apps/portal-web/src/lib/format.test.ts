import { describe, expect, it } from 'vitest';
import {
  formatDuracao,
  formatPhoneDisplay,
  formatPrecoCents,
  initials,
  normalizePhone,
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

describe('formatPhoneDisplay (numero COMPLETO pro dono — sem mascara)', () => {
  it('celular BR com DDI -> +55 (DD) 9XXXX-XXXX, numero inteiro visivel', () => {
    const out = formatPhoneDisplay('5535991153270');
    expect(out).toBe('+55 (35) 99115-3270');
    // nunca esconde digitos: o dono ve o numero completo do proprio cliente
    expect(out).not.toContain('•');
  });
  it('celular BR sem DDI -> (DD) 9XXXX-XXXX', () => {
    expect(formatPhoneDisplay('11999990007')).toBe('(11) 99999-0007');
  });
  it('fixo BR (10 digitos) -> (DD) XXXX-XXXX', () => {
    expect(formatPhoneDisplay('1133224455')).toBe('(11) 3322-4455');
  });
  it('aceita entrada ja formatada e devolve formato canonico', () => {
    expect(formatPhoneDisplay('+55 (35) 99115-3270')).toBe('+55 (35) 99115-3270');
  });
});

describe('normalizePhone (join contatos x pausas)', () => {
  it('tira DDI 55 e qualquer formatacao', () => {
    expect(normalizePhone('+55 (35) 99115-3270')).toBe('35991153270');
    expect(normalizePhone('5535991153270')).toBe('35991153270');
    expect(normalizePhone('35991153270')).toBe('35991153270');
  });
  it('numeros equivalentes (com/sem DDI) normalizam igual', () => {
    expect(normalizePhone('5511999990007')).toBe(normalizePhone('11999990007'));
  });
});
