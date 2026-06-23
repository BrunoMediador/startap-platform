import { describe, expect, it } from 'vitest';
import {
  COR_SEM_PROFISSIONAL,
  PALETA_PROFISSIONAIS,
  agruparPorHorario,
  corDoProfissional,
  filtrarPorProfissional,
  profissionaisNaAgenda,
} from './agenda-estabelecimento';
import type { Agendamento } from './api-types';

function ag(over: Partial<Agendamento>): Agendamento {
  return {
    id: over.id ?? 'evt',
    titulo: over.titulo ?? 'João - Corte',
    inicio: over.inicio ?? null,
    fim: over.fim ?? null,
    colaborador_id: over.colaborador_id,
    profissional_nome: over.profissional_nome,
  };
}

describe('corDoProfissional — cor estável por id', () => {
  it('id 1-based mapeia pro 1º matiz da paleta', () => {
    expect(corDoProfissional(1, 'Bené')).toBe(PALETA_PROFISSIONAIS[0]);
    expect(corDoProfissional(2, 'Caly')).toBe(PALETA_PROFISSIONAIS[1]);
  });

  it('é DETERMINÍSTICA: mesmo id → mesma cor sempre (sem flicker)', () => {
    expect(corDoProfissional(3, 'X')).toBe(corDoProfissional(3, 'Y'));
  });

  it('faz wrap quando o id passa do tamanho da paleta', () => {
    const n = PALETA_PROFISSIONAIS.length;
    expect(corDoProfissional(n + 1, 'A')).toBe(PALETA_PROFISSIONAIS[0]);
  });

  it('sem id mas com nome: hash do nome (determinístico)', () => {
    const c1 = corDoProfissional(undefined, 'Bené');
    const c2 = corDoProfissional(undefined, 'Bené');
    expect(c1).toBe(c2);
    expect(PALETA_PROFISSIONAIS).toContain(c1);
  });

  it('sem id e sem nome → cor neutra', () => {
    expect(corDoProfissional(undefined, undefined)).toBe(COR_SEM_PROFISSIONAL);
    expect(corDoProfissional(undefined, '   ')).toBe(COR_SEM_PROFISSIONAL);
  });
});

describe('profissionaisNaAgenda — legenda/filtro', () => {
  it('deduplica por colaborador_id e conta os eventos', () => {
    const lista = profissionaisNaAgenda([
      ag({ id: 'a', colaborador_id: 1, profissional_nome: 'Bené' }),
      ag({ id: 'b', colaborador_id: 1, profissional_nome: 'Bené' }),
      ag({ id: 'c', colaborador_id: 2, profissional_nome: 'Caly' }),
    ]);
    expect(lista).toHaveLength(2);
    const bene = lista.find((p) => p.id === 1);
    expect(bene?.count).toBe(2);
    expect(bene?.cor).toBe(PALETA_PROFISSIONAIS[0]);
  });

  it('ordena por nome (pt-BR) e joga "sem profissional" pro fim', () => {
    const lista = profissionaisNaAgenda([
      ag({ id: 'x', colaborador_id: undefined, profissional_nome: undefined }),
      ag({ id: 'a', colaborador_id: 2, profissional_nome: 'Caly' }),
      ag({ id: 'b', colaborador_id: 1, profissional_nome: 'Bené' }),
    ]);
    expect(lista.map((p) => p.nome)).toEqual(['Bené', 'Caly', 'Sem profissional']);
    expect(lista[2].id).toBeNull();
  });
});

describe('filtrarPorProfissional', () => {
  const lista = [
    ag({ id: 'a', colaborador_id: 1 }),
    ag({ id: 'b', colaborador_id: 2 }),
    ag({ id: 'c', colaborador_id: 1 }),
  ];

  it('null = "Todos" não filtra', () => {
    expect(filtrarPorProfissional(lista, null)).toHaveLength(3);
  });

  it('id específico mantém só os daquele profissional', () => {
    const so1 = filtrarPorProfissional(lista, 1);
    expect(so1.map((a) => a.id)).toEqual(['a', 'c']);
  });
});

describe('agruparPorHorario — paralelos lado a lado', () => {
  it('eventos no MESMO minuto (profissionais distintos) caem no MESMO grupo', () => {
    const grupos = agruparPorHorario([
      ag({
        id: 'a',
        inicio: '2026-06-23T09:00:00-03:00',
        colaborador_id: 1,
        profissional_nome: 'Bené',
      }),
      ag({
        id: 'b',
        inicio: '2026-06-23T09:00:00-03:00',
        colaborador_id: 2,
        profissional_nome: 'Caly',
      }),
    ]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].eventos).toHaveLength(2);
    // Ordenado por nome do profissional (Bené antes de Caly).
    expect(grupos[0].eventos.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('horários distintos viram grupos distintos, ordenados ASC', () => {
    const grupos = agruparPorHorario([
      ag({ id: 'tarde', inicio: '2026-06-23T15:00:00-03:00' }),
      ag({ id: 'manha', inicio: '2026-06-23T09:00:00-03:00' }),
    ]);
    expect(grupos.map((g) => g.eventos[0].id)).toEqual(['manha', 'tarde']);
  });

  it('eventos sem início vão pro grupo "sem", no fim', () => {
    const grupos = agruparPorHorario([
      ag({ id: 'semhora', inicio: null }),
      ag({ id: 'comhora', inicio: '2026-06-23T09:00:00-03:00' }),
    ]);
    expect(grupos[grupos.length - 1].chave).toBe('sem');
    expect(grupos[grupos.length - 1].eventos[0].id).toBe('semhora');
  });
});
