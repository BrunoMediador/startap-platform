import { describe, expect, it } from 'vitest';
import {
  type FiltroAgendamentos,
  agruparAgendamentos,
  classify,
  filtrarAgendamentos,
  normalizar,
  parseInicio,
  temFiltroAtivo,
  totalAgendamentos,
} from './agendamentos';
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

// ── Filtros + paginacao da Inicio (leva 3, BLOCO B) ──────────────────────────

/** Agendamento com titulo customizado (pra testar busca por nome). */
function agN(id: string, titulo: string, inicio: string | null): Agendamento {
  return { id, titulo, inicio, fim: null };
}

const f = (over: Partial<FiltroAgendamentos> = {}): FiltroAgendamentos => ({
  periodo: 'todos',
  busca: '',
  data: '',
  ...over,
});

describe('normalizar', () => {
  it('lowercase + remove acentos + trim', () => {
    expect(normalizar('  André  ')).toBe('andre');
    expect(normalizar('JOÃO')).toBe('joao');
    expect(normalizar('Conceição')).toBe('conceicao');
  });
});

describe('temFiltroAtivo', () => {
  it('todos vazio -> false', () => {
    expect(temFiltroAtivo(f())).toBe(false);
  });
  it('qualquer filtro setado -> true', () => {
    expect(temFiltroAtivo(f({ periodo: 'hoje' }))).toBe(true);
    expect(temFiltroAtivo(f({ busca: 'jo' }))).toBe(true);
    expect(temFiltroAtivo(f({ data: '2026-06-09' }))).toBe(true);
  });
  it('busca/data so com espacos -> false', () => {
    expect(temFiltroAtivo(f({ busca: '   ', data: '  ' }))).toBe(false);
  });
});

describe('filtrarAgendamentos', () => {
  const lista = [
    agN('h1', 'Jackson Lima', '2026-06-09T08:00:00'), // hoje manha
    agN('h2', 'Rafael Alves', '2026-06-09T16:00:00'), // hoje tarde
    agN('p1', 'Marcos Souza', '2026-06-10T09:00:00'), // proximo
    agN('p2', 'André Conceição', '2026-06-15T10:00:00'), // proximo
    agN('r1', 'João Recente', '2026-06-04T10:00:00'), // recente
  ];

  it('periodo todos: ordem hoje -> proximos -> recentes', () => {
    const out = filtrarAgendamentos(lista, f(), NOW);
    expect(out.map((a) => a.id)).toEqual(['h1', 'h2', 'p1', 'p2', 'r1']);
  });

  it('periodo hoje: so os de hoje (ASC)', () => {
    const out = filtrarAgendamentos(lista, f({ periodo: 'hoje' }), NOW);
    expect(out.map((a) => a.id)).toEqual(['h1', 'h2']);
  });

  it('periodo proximos / recentes', () => {
    expect(filtrarAgendamentos(lista, f({ periodo: 'proximos' }), NOW).map((a) => a.id)).toEqual([
      'p1',
      'p2',
    ]);
    expect(filtrarAgendamentos(lista, f({ periodo: 'recentes' }), NOW).map((a) => a.id)).toEqual([
      'r1',
    ]);
  });

  it('busca por nome: case e acento-insensitive', () => {
    expect(filtrarAgendamentos(lista, f({ busca: 'andre' }), NOW).map((a) => a.id)).toEqual(['p2']);
    expect(filtrarAgendamentos(lista, f({ busca: 'JACKSON' }), NOW).map((a) => a.id)).toEqual([
      'h1',
    ]);
    expect(filtrarAgendamentos(lista, f({ busca: 'joão' }), NOW).map((a) => a.id)).toEqual(['r1']);
  });

  it('busca sem match -> vazio', () => {
    expect(filtrarAgendamentos(lista, f({ busca: 'zzz' }), NOW)).toEqual([]);
  });

  it('data exata: so eventos daquele dia (date local, nao UTC)', () => {
    const out = filtrarAgendamentos(lista, f({ data: '2026-06-09' }), NOW);
    expect(out.map((a) => a.id)).toEqual(['h1', 'h2']);
  });

  it('combina os 3 filtros (periodo E busca E data)', () => {
    // hoje + busca "rafael" + data de hoje -> so h2
    const out = filtrarAgendamentos(
      lista,
      f({ periodo: 'hoje', busca: 'rafael', data: '2026-06-09' }),
      NOW,
    );
    expect(out.map((a) => a.id)).toEqual(['h2']);
  });

  it('combinacao impossivel -> vazio (periodo recentes + data de hoje)', () => {
    const out = filtrarAgendamentos(lista, f({ periodo: 'recentes', data: '2026-06-09' }), NOW);
    expect(out).toEqual([]);
  });
});

describe('paginacao 5/pagina (logica de slice usada na UI)', () => {
  const PAGE = 5;
  const muitos = Array.from({ length: 12 }, (_, i) =>
    agN(`x${i}`, `Cliente ${i}`, '2026-06-09T08:00:00'),
  );

  it('12 itens -> 3 paginas; pagina 1 = primeiros 5', () => {
    const out = filtrarAgendamentos(muitos, f(), NOW);
    expect(out).toHaveLength(12);
    const totalPages = Math.ceil(out.length / PAGE);
    expect(totalPages).toBe(3);
    expect(out.slice(0, PAGE)).toHaveLength(5);
    expect(out.slice(10, 15)).toHaveLength(2); // ultima pagina parcial
  });
});
