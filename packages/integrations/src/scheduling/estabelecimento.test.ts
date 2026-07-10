/**
 * Testes da montagem de agenda multi-colaborador (estabelecimento.ts — ADR 0023/0024, Fase A).
 *
 * Cobre os pontos críticos do BLOCO 1:
 *  (b) estabelecimento monta a agenda POR COLABORADOR via UMA chamada freebusy.query
 *      batched (todos os calendarIds de uma vez — ADR 0024 §5);
 *  (c) resolveColaboradorByShortId roteia pro colaborador certo e REJEITA id
 *      inválido / inativo / de OUTRO slot (sem vazamento cross-tenant — o caller usa
 *      este resolver server-side pra escolher o calendarId no inserir_agendamento);
 *  (d) bloco [PROFISSIONAIS] com a REGRA DE DESAMBIGUAÇÃO de homônimos.
 *
 * Não toca rede/DB: o GoogleCalendarClient é um stub com .freeBusy/.listEvents espionáveis.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FreeBusyResult, GoogleCalendarClient } from '../google-calendar/client.js';
import type { ColaboradorGcal } from '../google-calendar/per-clone.js';
import {
  buildEstabelecimentoContext,
  colaboradorFazServico,
  decorateColaboradores,
  resolveColaboradorByShortId,
  servicosDoColaborador,
} from './estabelecimento.js';
import { type ScheduleConfig, formatarAgendaComConfig } from './free-slots.js';

// Config de agenda fixa: ter-sab 09-18, 1 serviço de 30min. Suficiente para a grade.
const CONFIG: ScheduleConfig = {
  work: {
    0: null,
    1: null,
    2: [9 * 60, 18 * 60],
    3: [9 * 60, 18 * 60],
    4: [9 * 60, 18 * 60],
    5: [9 * 60, 18 * 60],
    6: [9 * 60, 18 * 60],
  },
  services: [{ name: 'Corte', min: 30 }],
  source: 'flow_clones',
  timezone: 'America/Sao_Paulo',
};

/** Stub mínimo de GoogleCalendarClient: só os métodos que o estabelecimento usa. */
function makeClient(
  freeBusyImpl?: (calendarIds: string[]) => FreeBusyResult,
): GoogleCalendarClient {
  return {
    freeBusy: vi.fn(async (opts: { calendarIds: string[] }) =>
      freeBusyImpl ? freeBusyImpl(opts.calendarIds) : {},
    ),
    listEvents: vi.fn(async () => []),
  } as unknown as GoogleCalendarClient;
}

function colab(
  partial: Partial<ColaboradorGcal> & { colaboradorId: number; nome: string; calendarId: string },
): ColaboradorGcal {
  return {
    client: partial.client ?? makeClient(),
    ...partial,
  } as ColaboradorGcal;
}

const TIME = {
  timeMin: '2026-06-15T12:00:00.000Z',
  timeMax: '2026-06-21T12:00:00.000Z',
};

// ─────────────────────────────────────────────────────────────────────────────
// (b) agenda por colaborador via freebusy batched (1 chamada)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildEstabelecimentoContext — freebusy batched', () => {
  it('faz UMA chamada freebusy com TODOS os calendarIds e rotula por colaborador', async () => {
    const shared = makeClient(() => ({}));
    const colaboradores: ColaboradorGcal[] = [
      colab({ colaboradorId: 10, nome: 'João S.', calendarId: 'cal-joao-s', client: shared }),
      colab({ colaboradorId: 11, nome: 'Maria', calendarId: 'cal-maria', client: shared }),
    ];

    const ctx = await buildEstabelecimentoContext(colaboradores, CONFIG, TIME);

    // 1 única chamada freebusy, com os 2 calendarIds juntos (batch — ADR 0024 §5).
    const fb = shared.freeBusy as unknown as ReturnType<typeof vi.fn>;
    expect(fb).toHaveBeenCalledTimes(1);
    expect(fb.mock.calls[0][0].calendarIds).toEqual(['cal-joao-s', 'cal-maria']);

    // shortId estável por ordem: C1, C2.
    expect(ctx.colaboradores.map((c) => c.shortId)).toEqual(['C1', 'C2']);

    // [HORARIOS] rotulado por colaborador (id curto + nome em cada sub-seção).
    expect(ctx.horariosBlock).toContain('C1 — João S.');
    expect(ctx.horariosBlock).toContain('C2 — Maria');
  });

  it('a ocupação (busy) de cada colaborador entra na grade dele (não na do outro)', async () => {
    // João está ocupado o dia 16/06 inteiro; Maria está livre. O dia 16 deve sumir
    // pra João mas continuar pra Maria.
    const busyByCal: FreeBusyResult = {
      'cal-joao-s': [{ start: '2026-06-16T09:00:00-03:00', end: '2026-06-16T18:00:00-03:00' }],
      'cal-maria': [],
    };
    const shared = makeClient((ids) => {
      // devolve só os ids pedidos (espelha o contrato do freebusy.query)
      const out: FreeBusyResult = {};
      for (const id of ids) out[id] = busyByCal[id] ?? [];
      return out;
    });
    const colaboradores: ColaboradorGcal[] = [
      colab({ colaboradorId: 10, nome: 'João S.', calendarId: 'cal-joao-s', client: shared }),
      colab({ colaboradorId: 11, nome: 'Maria', calendarId: 'cal-maria', client: shared }),
    ];

    const ctx = await buildEstabelecimentoContext(colaboradores, CONFIG, TIME);

    // Sanidade: a sub-seção de cada colaborador existe e são distintas.
    const joaoIdx = ctx.horariosBlock.indexOf('C1 — João S.');
    const mariaIdx = ctx.horariosBlock.indexOf('C2 — Maria');
    expect(joaoIdx).toBeGreaterThanOrEqual(0);
    expect(mariaIdx).toBeGreaterThan(joaoIdx);
  });

  it('lista vazia → blocos vazios e NENHUMA chamada freebusy', async () => {
    const ctx = await buildEstabelecimentoContext([], CONFIG, TIME);
    expect(ctx.colaboradores).toEqual([]);
    expect(ctx.profissionaisBlock).toBe('');
    expect(ctx.horariosBlock).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) desambiguação de homônimos no bloco [PROFISSIONAIS]
// ─────────────────────────────────────────────────────────────────────────────

describe('buildEstabelecimentoContext — bloco [PROFISSIONAIS] + desambiguação', () => {
  it('lista cada profissional pelo id curto e impõe a regra de desambiguação', async () => {
    const shared = makeClient(() => ({}));
    const colaboradores: ColaboradorGcal[] = [
      colab({ colaboradorId: 1, nome: 'João S.', calendarId: 'cal-1', client: shared }),
      colab({ colaboradorId: 2, nome: 'João P.', calendarId: 'cal-2', client: shared }),
    ];

    const ctx = await buildEstabelecimentoContext(colaboradores, CONFIG, TIME);

    // ids curtos com nome (permite distinguir os dois Joãos pelo sobrenome).
    expect(ctx.profissionaisBlock).toContain('C1 = João S.');
    expect(ctx.profissionaisBlock).toContain('C2 = João P.');
    // regra de desambiguação OBRIGATÓRIA presente.
    expect(ctx.profissionaisBlock).toMatch(/homônimos|homonimos/i);
    expect(ctx.profissionaisBlock).toMatch(/SEMPRE pergunte/i);
    // NÃO oferece "qualquer profissional"/pooled no MVP (isso é Fase B).
    expect(ctx.profissionaisBlock).not.toMatch(/qualquer profissional/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) resolveColaboradorByShortId — roteamento + rejeição (server-side)
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveColaboradorByShortId — roteamento e rejeição', () => {
  const decorados = decorateColaboradores([
    colab({ colaboradorId: 10, nome: 'João S.', calendarId: 'cal-joao' }),
    colab({ colaboradorId: 11, nome: 'Maria', calendarId: 'cal-maria' }),
  ]);

  it('id curto válido (C1/C2) resolve pro colaborador certo', () => {
    expect(resolveColaboradorByShortId(decorados, 'C1')?.calendarId).toBe('cal-joao');
    expect(resolveColaboradorByShortId(decorados, 'C2')?.calendarId).toBe('cal-maria');
  });

  it('tolera caixa/espaço no id curto ("c1", " C2 ")', () => {
    expect(resolveColaboradorByShortId(decorados, 'c1')?.colaboradorId).toBe(10);
    expect(resolveColaboradorByShortId(decorados, ' C2 ')?.colaboradorId).toBe(11);
  });

  it('aceita id numérico do colaborador (validado contra a mesma lista)', () => {
    expect(resolveColaboradorByShortId(decorados, '10')?.calendarId).toBe('cal-joao');
  });

  it('REJEITA id curto inexistente (C3) → null', () => {
    expect(resolveColaboradorByShortId(decorados, 'C3')).toBeNull();
  });

  it('REJEITA id numérico de colaborador que não está na lista (inativo/outro slot) → null', () => {
    // 99 = colaborador inativo (não veio do resolvedor) OU de outro slot: não está na
    // lista decorada deste slot → rejeita. É a barreira contra vazamento cross-tenant:
    // o resolvedor só decora ATIVOS do slot/tenant pedido.
    expect(resolveColaboradorByShortId(decorados, '99')).toBeNull();
  });

  it('REJEITA vazio / lixo (nunca aceita calendarId cru)', () => {
    expect(resolveColaboradorByShortId(decorados, '')).toBeNull();
    expect(resolveColaboradorByShortId(decorados, 'cal-joao')).toBeNull(); // calendarId NUNCA é aceito
    expect(resolveColaboradorByShortId(decorados, 'C1; DROP TABLE')).toBeNull();
  });

  it('lista de OUTRO slot não resolve um id do slot original (isolamento)', () => {
    const outroSlot = decorateColaboradores([
      colab({ colaboradorId: 50, nome: 'Outro', calendarId: 'cal-OUTRA-AGENDA' }),
    ]);
    // C1 do outro slot aponta pra agenda do outro slot, NUNCA pra 'cal-joao' do slot original.
    expect(resolveColaboradorByShortId(outroSlot, 'C1')?.calendarId).toBe('cal-OUTRA-AGENDA');
    // o id numérico 10 (do slot original) não existe na lista do outro slot → null.
    expect(resolveColaboradorByShortId(outroSlot, '10')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 2 — serviço POR profissional: bloco [PROFISSIONAIS] + validação server-side
// ─────────────────────────────────────────────────────────────────────────────

// Config com 3 serviços globais — cobre o cenário do Bruno (Maria não faz Corte).
const CONFIG_MULTI: ScheduleConfig = {
  ...CONFIG,
  services: [
    { name: 'Corte', min: 30 },
    { name: 'Barba', min: 30 },
    { name: 'Manicure', min: 40 },
    { name: 'Sobrancelha', min: 20 },
  ],
};

describe('servicosDoColaborador — fallback global vs lista do colaborador', () => {
  it('colaborador COM servicos → usa a lista DELE (canonizada contra os globais)', () => {
    const bruno = { servicos: ['corte', 'BARBA'] }; // caixa diferente de propósito
    expect(servicosDoColaborador(bruno, CONFIG_MULTI)).toEqual(['Corte', 'Barba']);
  });

  it('colaborador com servicos VAZIO → fallback: faz TODOS os globais', () => {
    expect(servicosDoColaborador({ servicos: [] }, CONFIG_MULTI)).toEqual([
      'Corte',
      'Barba',
      'Manicure',
      'Sobrancelha',
    ]);
  });

  it('servico do colaborador que sumiu da lista global é descartado', () => {
    const maria = { servicos: ['Manicure', 'Serviço Extinto'] };
    expect(servicosDoColaborador(maria, CONFIG_MULTI)).toEqual(['Manicure']);
  });

  it('se TODOS os servicos do colaborador sumiram dos globais → cai pro fallback global', () => {
    const inconsistente = { servicos: ['Só Coisas Antigas'] };
    expect(servicosDoColaborador(inconsistente, CONFIG_MULTI)).toEqual([
      'Corte',
      'Barba',
      'Manicure',
      'Sobrancelha',
    ]);
  });
});

describe('colaboradorFazServico — validação serviço×profissional', () => {
  const bruno = { servicos: ['Corte', 'Barba'] };
  const maria = { servicos: ['Manicure', 'Sobrancelha'] };

  it('aceita serviço que o profissional faz (case/espaço tolerante)', () => {
    expect(colaboradorFazServico(bruno, CONFIG_MULTI, 'Corte')).toBe(true);
    expect(colaboradorFazServico(bruno, CONFIG_MULTI, '  corte ')).toBe(true);
  });

  it('REJEITA serviço que o profissional NÃO faz (cenário do Bruno: Maria × Corte)', () => {
    expect(colaboradorFazServico(maria, CONFIG_MULTI, 'Corte')).toBe(false);
  });

  it('colaborador sem servicos (fallback global) faz qualquer serviço global', () => {
    expect(colaboradorFazServico({ servicos: [] }, CONFIG_MULTI, 'Corte')).toBe(true);
    expect(colaboradorFazServico({ servicos: [] }, CONFIG_MULTI, 'Manicure')).toBe(true);
  });

  it('serviço pedido vazio → não bloqueia (true)', () => {
    expect(colaboradorFazServico(maria, CONFIG_MULTI, '')).toBe(true);
    expect(colaboradorFazServico(maria, CONFIG_MULTI, '   ')).toBe(true);
  });
});

describe('buildProfissionaisBlock — serviços por profissional', () => {
  it('lista os serviços DE CADA colaborador (não os globais pra todos)', async () => {
    const shared = makeClient(() => ({}));
    const colaboradores: ColaboradorGcal[] = [
      colab({
        colaboradorId: 1,
        nome: 'Bruno',
        calendarId: 'cal-bruno',
        client: shared,
        servicos: ['Corte', 'Barba'],
      }),
      colab({
        colaboradorId: 2,
        nome: 'Maria',
        calendarId: 'cal-maria',
        client: shared,
        servicos: ['Manicure', 'Sobrancelha'],
      }),
    ];

    const ctx = await buildEstabelecimentoContext(colaboradores, CONFIG_MULTI, TIME);

    expect(ctx.profissionaisBlock).toContain('C1 = Bruno (faz: Corte, Barba)');
    expect(ctx.profissionaisBlock).toContain('C2 = Maria (faz: Manicure, Sobrancelha)');
    // Maria NÃO deve aparecer fazendo Corte.
    expect(ctx.profissionaisBlock).not.toMatch(/Maria \(faz:[^)]*Corte/);
    // regra de "não agende serviço que o profissional não faz" presente.
    expect(ctx.profissionaisBlock).toMatch(/não faz|nao faz/i);
  });

  it('colaborador sem servicos cadastrados cai no fallback (todos os globais)', async () => {
    const shared = makeClient(() => ({}));
    const colaboradores: ColaboradorGcal[] = [
      colab({
        colaboradorId: 1,
        nome: 'Curinga',
        calendarId: 'cal-curinga',
        client: shared,
        servicos: [],
      }),
    ];

    const ctx = await buildEstabelecimentoContext(colaboradores, CONFIG_MULTI, TIME);
    expect(ctx.profissionaisBlock).toContain(
      'C1 = Curinga (faz: Corte, Barba, Manicure, Sobrancelha)',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SCRUM-28 (resíduo) — a grade [HORARIOS] filtra os serviços POR profissional
// (não lista todos os serviços do clone debaixo de cada barbeiro).
// ─────────────────────────────────────────────────────────────────────────────

describe('buildHorariosBlock — serviços por profissional na grade [HORARIOS]', () => {
  it('grade de cada profissional mostra SÓ os serviços que ele faz', async () => {
    const shared = makeClient(() => ({}));
    const colaboradores: ColaboradorGcal[] = [
      colab({
        colaboradorId: 1,
        nome: 'Bruno',
        calendarId: 'cal-bruno',
        client: shared,
        servicos: ['Corte', 'Barba'],
      }),
      colab({
        colaboradorId: 2,
        nome: 'Maria',
        calendarId: 'cal-maria',
        client: shared,
        servicos: ['Manicure', 'Sobrancelha'],
      }),
    ];

    const ctx = await buildEstabelecimentoContext(colaboradores, CONFIG_MULTI, TIME);

    // A sub-seção do Bruno traz Corte/Barba; a da Maria traz Manicure/Sobrancelha.
    const brunoSec = ctx.horariosBlock.slice(
      ctx.horariosBlock.indexOf('C1 — Bruno'),
      ctx.horariosBlock.indexOf('C2 — Maria'),
    );
    const mariaSec = ctx.horariosBlock.slice(ctx.horariosBlock.indexOf('C2 — Maria'));

    expect(brunoSec).toMatch(/Corte \(30min\)/);
    expect(brunoSec).toMatch(/Barba \(30min\)/);
    // Bruno NÃO faz Manicure/Sobrancelha → não aparecem na grade dele (o bug do card).
    expect(brunoSec).not.toMatch(/Manicure/);
    expect(brunoSec).not.toMatch(/Sobrancelha/);

    expect(mariaSec).toMatch(/Manicure \(40min\)/);
    expect(mariaSec).toMatch(/Sobrancelha \(20min\)/);
    // Maria NÃO faz Corte/Barba → não aparecem na grade dela.
    expect(mariaSec).not.toMatch(/Corte/);
    expect(mariaSec).not.toMatch(/Barba/);
  });

  it('colaborador SEM serviços marcados → grade com TODOS os globais (fallback byte-idêntico)', async () => {
    const shared = makeClient(() => ({}));
    // Curinga (sem serviços) deve ter a MESMA grade que a formatação global do config —
    // ou seja, a introdução do filtro não muda nada pra quem não configurou.
    const curinga = colab({
      colaboradorId: 1,
      nome: 'Curinga',
      calendarId: 'cal-curinga',
      client: shared,
      servicos: [],
    });

    const ctx = await buildEstabelecimentoContext([curinga], CONFIG_MULTI, TIME);
    const grade = ctx.horariosBlock.slice(ctx.horariosBlock.indexOf('C1 — Curinga'));

    // Todos os 4 serviços globais aparecem na grade do Curinga (comportamento anterior).
    expect(grade).toMatch(/Corte \(30min\)/);
    expect(grade).toMatch(/Barba \(30min\)/);
    expect(grade).toMatch(/Manicure \(40min\)/);
    expect(grade).toMatch(/Sobrancelha \(20min\)/);

    // A grade do fallback é IGUAL, linha a linha, à formatação global do config
    // (prova de byte-identidade da introdução do filtro no caminho fallback).
    const gradeGlobal = formatarAgendaComConfig([], CONFIG_MULTI);
    for (const linha of gradeGlobal.split('\n')) {
      expect(grade).toContain(linha);
    }
  });
});
