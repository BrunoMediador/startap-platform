import { describe, expect, it } from 'vitest';
import type { Horarios } from './api-types';
import {
  DIAS_STRIP,
  MAX_AHEAD_DAYS,
  addMinutosHora,
  buildCriarAgendamentoBody,
  buildDayStrip,
  buildWeekStrip,
  dateKeyLocal,
  formatDiaCurto,
  formatDiaExtenso,
  formatIntervaloSemana,
  formatPhoneBR,
  podeAvancarSemana,
  podeVoltarSemana,
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
  it('gera 7 dias a partir de hoje, com Hoje/Amanhã e dateKeys locais', () => {
    const strip = buildDayStrip(HORARIOS, NOW);
    expect(strip).toHaveLength(DIAS_STRIP);
    expect(strip[0]).toMatchObject({ dateKey: '2026-06-11', label: 'Hoje', diaNum: 11 });
    expect(strip[1]).toMatchObject({ dateKey: '2026-06-12', label: 'Amanhã', diaNum: 12 });
    expect(strip[2]).toMatchObject({ dateKey: '2026-06-13', label: 'Sáb', diaNum: 13 });
    expect(strip[6].dateKey).toBe('2026-06-17');
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

describe('buildWeekStrip (navegação por semana, horizonte 365d)', () => {
  it('offset 0 é idêntico ao buildDayStrip cru (Hoje/Amanhã, nada passado/fora da janela)', () => {
    const semana = buildWeekStrip(HORARIOS, 0, NOW);
    const cru = buildDayStrip(HORARIOS, NOW);
    expect(semana.map((d) => d.dateKey)).toEqual(cru.map((d) => d.dateKey));
    expect(semana[0]).toMatchObject({ label: 'Hoje', passado: false, foraDaJanela: false });
    expect(semana[1]).toMatchObject({ label: 'Amanhã', passado: false, foraDaJanela: false });
    expect(semana.every((d) => !d.passado && !d.foraDaJanela)).toBe(true);
  });

  it('offset futuro pula 7*offset dias e nunca rotula Hoje/Amanhã', () => {
    const semana1 = buildWeekStrip(HORARIOS, 1, NOW);
    expect(semana1[0].dateKey).toBe('2026-06-18'); // hoje (11/06) + 7
    expect(semana1.some((d) => d.label === 'Hoje' || d.label === 'Amanhã')).toBe(false);
    expect(semana1[0].label).toBe('Qui'); // 18/06/2026 é quinta
  });

  it('offset negativo (semana passada) marca todo dia como passado', () => {
    const semanaAnterior = buildWeekStrip(HORARIOS, -1, NOW);
    expect(semanaAnterior[0].dateKey).toBe('2026-06-04');
    expect(semanaAnterior.every((d) => d.passado)).toBe(true);
  });

  it('marca foraDaJanela além de hoje + 365 dias', () => {
    // hoje (11/06/2026) + 365 = 11/06/2027; a semana que cruza essa borda tem
    // dias dentro e fora do horizonte na mesma pill-row.
    const semanasAteOLimite = Math.floor(MAX_AHEAD_DAYS / DIAS_STRIP);
    const semanaDaBorda = buildWeekStrip(HORARIOS, semanasAteOLimite, NOW);
    expect(semanaDaBorda.some((d) => d.foraDaJanela)).toBe(true);
    expect(semanaDaBorda.some((d) => !d.foraDaJanela)).toBe(true);
  });
});

describe('podeAvancarSemana / podeVoltarSemana', () => {
  it('não deixa voltar antes da semana atual (offset 0 é o piso)', () => {
    expect(podeVoltarSemana(0)).toBe(false);
    expect(podeVoltarSemana(1)).toBe(true);
  });

  it('deixa avançar enquanto a PRÓXIMA semana tiver algum dia dentro do horizonte', () => {
    // (weekOffset+1)*DIAS_STRIP <= MAX_AHEAD_DAYS → último offset válido = 51
    // (52*7=364<=365) e o primeiro inválido = 52 (53*7=371>365).
    const ultimaSemanaValida = Math.floor(MAX_AHEAD_DAYS / DIAS_STRIP) - 1;
    expect(podeAvancarSemana(ultimaSemanaValida)).toBe(true);
    const primeiraSemanaTotalmenteFora = Math.floor(MAX_AHEAD_DAYS / DIAS_STRIP);
    expect(podeAvancarSemana(primeiraSemanaTotalmenteFora)).toBe(false);
  });
});

describe('formatIntervaloSemana', () => {
  it('mesmo mês: "11–17 de junho"', () => {
    const semana = buildWeekStrip(HORARIOS, 0, NOW);
    expect(formatIntervaloSemana(semana)).toBe('11–17 de junho');
  });

  it('virando o mês: "29 de jun–5 de julho"', () => {
    const fimDeMes = new Date(2026, 5, 29, 10, 0); // 29/jun/2026 (segunda)
    const semana = buildWeekStrip(HORARIOS, 0, fimDeMes);
    expect(formatIntervaloSemana(semana)).toBe('29 de jun–5 de julho');
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

describe('buildCriarAgendamentoBody (gating de profissional)', () => {
  const base = {
    servico: 'Corte',
    data: '2026-06-13',
    hora: '10:00',
    cliente_nome: 'João',
  } as const;

  it('individual: nunca envia colaborador_id (mesmo com um selecionado)', () => {
    const res = buildCriarAgendamentoBody({
      productType: 'individual',
      base: { ...base },
      colaboradorId: 7,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.body).toEqual(base);
      expect('colaborador_id' in res.body).toBe(false);
    }
  });

  it('individual sem seleção: body byte-a-byte igual ao de hoje', () => {
    const res = buildCriarAgendamentoBody({
      productType: 'individual',
      base: { ...base, cliente_telefone: '5511999990007' },
      colaboradorId: null,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.body).toEqual({ ...base, cliente_telefone: '5511999990007' });
    }
  });

  it('estabelecimento: envia o colaborador_id selecionado', () => {
    const res = buildCriarAgendamentoBody({
      productType: 'estabelecimento',
      base: { ...base },
      colaboradorId: 42,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.body).toEqual({ ...base, colaborador_id: 42 });
  });

  it('estabelecimento sem profissional escolhido: erro colaborador_obrigatorio', () => {
    const res = buildCriarAgendamentoBody({
      productType: 'estabelecimento',
      base: { ...base },
      colaboradorId: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('colaborador_obrigatorio');
  });
});
