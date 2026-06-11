import { describe, expect, it } from 'vitest';
import type { Horarios } from './api-types';
import {
  DIAS_STRIP,
  addMinutosHora,
  buildDayStrip,
  dateKeyLocal,
  formatDiaCurto,
  formatDiaExtenso,
  formatPhoneBR,
  telefoneDigits,
  validateNovoAgendamento,
} from './novo-agendamento';

// quinta-feira, 11 de junho de 2026, 14:30 local — referência fixa dos testes.
const NOW = new Date(2026, 5, 11, 14, 30);

const HORARIOS: Horarios = {
  segunda: { abre: '09:00', fecha: '19:00', fechado: false },
  terca: { abre: '09:00', fecha: '19:00', fechado: false },
  quarta: { abre: '09:00', fecha: '19:00', fechado: false },
  quinta: { abre: '09:00', fecha: '19:00', fechado: false },
  sexta: { abre: '09:00', fecha: '19:00', fechado: false },
  sabado: { abre: '09:00', fecha: '13:00', fechado: false },
  domingo: { abre: null, fecha: null, fechado: true },
};

describe('buildDayStrip', () => {
  it('gera 14 dias a partir de hoje, com Hoje/Amanhã e dateKeys locais', () => {
    const strip = buildDayStrip(HORARIOS, NOW);
    expect(strip).toHaveLength(DIAS_STRIP);
    expect(strip[0]).toMatchObject({ dateKey: '2026-06-11', label: 'Hoje', diaNum: 11 });
    expect(strip[1]).toMatchObject({ dateKey: '2026-06-12', label: 'Amanhã', diaNum: 12 });
    expect(strip[2]).toMatchObject({ dateKey: '2026-06-13', label: 'Sáb', diaNum: 13 });
    expect(strip[13].dateKey).toBe('2026-06-24');
  });

  it('marca domingo (fechado:true na grade) como fechado', () => {
    const strip = buildDayStrip(HORARIOS, NOW);
    const domingo = strip.find((d) => d.dateKey === '2026-06-14');
    expect(domingo?.fechado).toBe(true);
    const sexta = strip.find((d) => d.dateKey === '2026-06-12');
    expect(sexta?.fechado).toBe(false);
  });

  it('dia AUSENTE da grade conta como fechado (regra de lib/horarios.ts)', () => {
    const semSabado: Horarios = { ...HORARIOS };
    semSabado.sabado = undefined;
    const strip = buildDayStrip(semSabado, NOW);
    expect(strip.find((d) => d.dateKey === '2026-06-13')?.fechado).toBe(true);
  });

  it('sem grade carregada (undefined), nenhum dia é desabilitado', () => {
    const strip = buildDayStrip(undefined, NOW);
    expect(strip.every((d) => !d.fechado)).toBe(true);
  });

  it('vira o mês sem pular dia (junho → julho)', () => {
    const fimDeMes = new Date(2026, 5, 28, 10, 0); // 28/jun
    const strip = buildDayStrip(undefined, fimDeMes);
    expect(strip[2].dateKey).toBe('2026-06-30');
    expect(strip[3].dateKey).toBe('2026-07-01');
  });

  it('longo traz o dia por extenso pra acessibilidade', () => {
    const strip = buildDayStrip(HORARIOS, NOW);
    expect(strip[0].longo).toBe('quinta, 11 de junho');
    expect(strip[2].longo).toBe('sábado, 13 de junho');
  });
});

describe('formatação de dia/hora do resumo', () => {
  it('dateKeyLocal usa o fuso local, não UTC', () => {
    expect(dateKeyLocal(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('formatDiaExtenso: "sáb, 13 de junho"', () => {
    expect(formatDiaExtenso('2026-06-13')).toBe('sáb, 13 de junho');
    expect(formatDiaExtenso('2026-06-14')).toBe('dom, 14 de junho');
  });

  it('formatDiaCurto: "sáb 13/06"', () => {
    expect(formatDiaCurto('2026-06-13')).toBe('sáb 13/06');
    expect(formatDiaCurto('2026-12-01')).toBe('ter 01/12');
  });

  it('addMinutosHora soma a duração do serviço', () => {
    expect(addMinutosHora('10:00', 30)).toBe('10:30');
    expect(addMinutosHora('09:45', 45)).toBe('10:30');
    expect(addMinutosHora('23:50', 20)).toBe('00:10'); // wrap defensivo
  });
});

describe('formatPhoneBR (máscara progressiva)', () => {
  it('formata conforme digita', () => {
    expect(formatPhoneBR('')).toBe('');
    expect(formatPhoneBR('1')).toBe('(1');
    expect(formatPhoneBR('11')).toBe('(11');
    expect(formatPhoneBR('119')).toBe('(11) 9');
    expect(formatPhoneBR('11999')).toBe('(11) 999');
    expect(formatPhoneBR('1199999000')).toBe('(11) 9999-9000'); // fixo 10
    expect(formatPhoneBR('11999990007')).toBe('(11) 99999-0007'); // celular 11
  });

  it('aceita colar com pontuação e corta excesso', () => {
    expect(formatPhoneBR('(11) 99999-0007')).toBe('(11) 99999-0007');
    expect(formatPhoneBR('119999900071234')).toBe('(11) 99999-0007');
    expect(telefoneDigits('(11) 99999-0007')).toBe('11999990007');
  });
});

describe('validateNovoAgendamento', () => {
  it('nome vazio → erro inline', () => {
    const res = validateNovoAgendamento({ nome: '  ', telefone: '' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.nome).toBe('Diga o nome do cliente');
  });

  it('telefone incompleto → erro; vazio → ok sem telefone', () => {
    const incompleto = validateNovoAgendamento({ nome: 'João', telefone: '(11) 9999' });
    expect(incompleto.ok).toBe(false);
    if (!incompleto.ok) expect(incompleto.errors.telefone).toBe('Confere o número? Faltou dígito');

    const semTelefone = validateNovoAgendamento({ nome: 'João', telefone: '' });
    expect(semTelefone.ok).toBe(true);
    if (semTelefone.ok) expect(semTelefone.value).toEqual({ cliente_nome: 'João' });
  });

  it('telefone válido sai com DDI 55 (formato dos títulos do bot)', () => {
    const res = validateNovoAgendamento({ nome: ' João Pedro ', telefone: '(11) 99999-0007' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({
        cliente_nome: 'João Pedro',
        cliente_telefone: '5511999990007',
      });
    }
  });

  it('fixo de 10 dígitos também passa', () => {
    const res = validateNovoAgendamento({ nome: 'Maria', telefone: '(11) 3333-4444' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.cliente_telefone).toBe('551133334444');
  });
});
