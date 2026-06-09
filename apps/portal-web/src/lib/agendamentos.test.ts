import { describe, expect, it } from 'vitest';
import { agruparAgendamentos, classify, parseInicio, totalAgendamentos } from './agendamentos';
import type { Agendamento } from './api-types';

// Referencia fixa: 2026-06-09 (terca), 14:00 horario local.
const NOW = new Date(2026, 5, 9, 14, 0, 0);

function ag(id: string, inicio: string | null): Agendamento {
  return { id, titulo: `Evento ${id}`, inicio, fim: null };
}

describe('parseInicio', () => {
  it('aceita date puro como meia-noite local', () => {
    const d = parseInicio('2026-06-09');
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(5);
    expect(d?.getDate()).toBe(9);
    expect(d?.getHours()).toBe(0);
  });
  it('aceita ISO datetime', () => {
    const d = parseInicio('2026-06-09T15:30:00');
    expect(d?.getHours()).toBe(15);
  });
  it('null/invalido -> null', () => {
    expect(parseInicio(null)).toBeNull();
    expect(parseInicio('xxx')).toBeNull();
  });
});

describe('classify', () => {
  it('mesmo dia -> hoje (date puro e datetime)', () => {
    expect(classify('2026-06-09', NOW)).toBe('hoje');
    expect(classify('2026-06-09T09:00:00', NOW)).toBe('hoje');
    expect(classify('2026-06-09T23:59:00', NOW)).toBe('hoje');
  });
  it('futuro alem de hoje -> proximos', () => {
    expect(classify('2026-06-10', NOW)).toBe('proximos');
    expect(classify('2026-06-20T08:00:00', NOW)).toBe('proximos');
  });
  it('passado -> recentes', () => {
    expect(classify('2026-06-08T18:00:00', NOW)).toBe('recentes');
    expect(classify('2026-06-02', NOW)).toBe('recentes');
  });
  it('sem inicio -> proximos (nao some da tela)', () => {
    expect(classify(null, NOW)).toBe('proximos');
  });
});

describe('agruparAgendamentos', () => {
  it('separa e ordena: hoje/proximos ASC, recentes DESC', () => {
    const lista = [
      ag('r1', '2026-06-04T10:00:00'), // recente
      ag('p2', '2026-06-15T10:00:00'), // proximo
      ag('h2', '2026-06-09T16:00:00'), // hoje (tarde)
      ag('r2', '2026-06-08T10:00:00'), // recente (mais novo)
      ag('h1', '2026-06-09T08:00:00'), // hoje (manha)
      ag('p1', '2026-06-10T10:00:00'), // proximo (mais cedo)
    ];
    const g = agruparAgendamentos(lista, NOW);

    expect(g.hoje.map((a) => a.id)).toEqual(['h1', 'h2']); // ASC
    expect(g.proximos.map((a) => a.id)).toEqual(['p1', 'p2']); // ASC
    expect(g.recentes.map((a) => a.id)).toEqual(['r2', 'r1']); // DESC (mais recente 1o)
  });

  it('evento sem inicio vai pro fim de proximos', () => {
    const g = agruparAgendamentos([ag('sem', null), ag('p', '2026-06-12T10:00:00')], NOW);
    expect(g.proximos.map((a) => a.id)).toEqual(['p', 'sem']);
  });

  it('lista vazia -> grupos vazios', () => {
    const g = agruparAgendamentos([], NOW);
    expect(totalAgendamentos(g)).toBe(0);
  });

  it('date puro de hoje cai em hoje, nao em recentes', () => {
    const g = agruparAgendamentos([ag('x', '2026-06-09')], NOW);
    expect(g.hoje).toHaveLength(1);
    expect(g.recentes).toHaveLength(0);
  });
});
