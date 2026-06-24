import { describe, expect, it } from 'vitest';
import {
  formatAgendamentoDia,
  formatAgendamentoHora,
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

// ── BUG DE DINHEIRO 3 (ADR 0027): label do DIA/HORA saía em UTC -> dia errado ────────────
// A barbearia é BR (UTC-3). O timestamptz vem em UTC; sem timeZone, toLocale* usa o fuso do
// runtime (Next SSR roda em UTC). Um horário noturno (22:00 BRT = 01:00 UTC do dia SEGUINTE)
// caía no dia errado. O fix fixa America/Sao_Paulo. Estes testes são determinísticos em
// QUALQUER TZ de runtime (a função força BR_TZ internamente).
describe('formatAgendamentoHora (fuso da barbearia — Bug 3)', () => {
  it('22:00 BRT (= 01:00 UTC do dia seguinte) -> "22:00", não "01:00"', () => {
    // 2026-06-23 22:00 -03:00 === 2026-06-24T01:00:00Z
    expect(formatAgendamentoHora('2026-06-24T01:00:00.000Z')).toBe('22:00');
  });
  it('13:00 BRT (= 16:00 UTC) -> "13:00"', () => {
    expect(formatAgendamentoHora('2026-06-23T16:00:00.000Z')).toBe('13:00');
  });
  it('date puro (sem hora) -> "" (dia inteiro)', () => {
    expect(formatAgendamentoHora('2026-06-23')).toBe('');
  });
});

describe('formatAgendamentoDia (fuso da barbearia — Bug 3)', () => {
  // "now" fixo pro cálculo hoje/amanhã/ontem ser determinístico (ref = 2026-06-23 ~meio-dia BRT).
  const now = new Date('2026-06-23T15:00:00.000Z'); // 12:00 BRT do dia 23

  it('22:00 BRT do dia 23 (= 01:00 UTC do dia 24) -> "Hoje", NÃO "Amanhã"', () => {
    // O instante UTC cai no dia 24; em BR ainda é dia 23 -> tem que ser "Hoje".
    expect(formatAgendamentoDia('2026-06-24T01:00:00.000Z', now)).toBe('Hoje');
  });
  it('22:00 BRT do dia 24 -> "Amanhã" relativo ao dia 23', () => {
    expect(formatAgendamentoDia('2026-06-25T01:00:00.000Z', now)).toBe('Amanhã');
  });
  it('02:00 BRT do dia 23 (= 05:00 UTC do dia 23) -> "Hoje"', () => {
    expect(formatAgendamentoDia('2026-06-23T05:00:00.000Z', now)).toBe('Hoje');
  });
  it('ontem: 22:00 BRT do dia 22 (= 01:00 UTC do dia 23) -> "Ontem"', () => {
    expect(formatAgendamentoDia('2026-06-23T01:00:00.000Z', now)).toBe('Ontem');
  });
  it('date puro "YYYY-MM-DD" usa o dia BR (não escorrega pro dia anterior)', () => {
    expect(formatAgendamentoDia('2026-06-23', now)).toBe('Hoje');
    expect(formatAgendamentoDia('2026-06-24', now)).toBe('Amanhã');
  });
  it('null -> "Sem data"', () => {
    expect(formatAgendamentoDia(null, now)).toBe('Sem data');
  });
});
