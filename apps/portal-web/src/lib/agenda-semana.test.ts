import { describe, expect, it } from 'vitest';
import { buildSemana, semDataCount } from './agenda-semana';
import type { Agendamento } from './api-types';

// Referência: 2026-06-10 (QUARTA), 14:00 local. Semana = seg 08 → dom 14 de junho.
const NOW = new Date(2026, 5, 10, 14, 0, 0);

function ag(id: string, inicio: string | null): Agendamento {
  return { id, titulo: `Evento ${id}`, inicio, fim: null };
}

describe('buildSemana — estrutura', () => {
  it('7 colunas segunda→domingo, com a segunda correta', () => {
    const s = buildSemana([], 0, NOW);
    expect(s.dias).toHaveLength(7);
    expect(s.dias.map((d) => d.curto)).toEqual(['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom']);
    expect(s.inicioKey).toBe('2026-06-08'); // segunda
    expect(s.fimKey).toBe('2026-06-14'); // domingo
    expect(s.dias.map((d) => d.diaNum)).toEqual([8, 9, 10, 11, 12, 13, 14]);
  });

  it('marca o dia de hoje (quarta 10)', () => {
    const s = buildSemana([], 0, NOW);
    const hoje = s.dias.filter((d) => d.hoje);
    expect(hoje).toHaveLength(1);
    expect(hoje[0].dateKey).toBe('2026-06-10');
  });

  it('título do range no mesmo mês', () => {
    expect(buildSemana([], 0, NOW).titulo).toBe('8–14 de junho');
  });

  it('offset desloca a semana (próxima / passada)', () => {
    expect(buildSemana([], 1, NOW).inicioKey).toBe('2026-06-15');
    expect(buildSemana([], -1, NOW).inicioKey).toBe('2026-06-01');
  });

  it('título cruzando mês usa abreviação dos dois meses', () => {
    // semana de 29/jun a 05/jul (offset +3 a partir de 08/jun)
    const s = buildSemana([], 3, NOW);
    expect(s.inicioKey).toBe('2026-06-29');
    expect(s.fimKey).toBe('2026-07-05');
    expect(s.titulo).toBe('29 de jun – 5 de jul');
  });
});

describe('buildSemana — distribuição de eventos', () => {
  const lista = [
    ag('qua-tarde', '2026-06-10T16:00:00'),
    ag('qua-manha', '2026-06-10T09:00:00'),
    ag('seg', '2026-06-08T11:00:00'),
    ag('dom', '2026-06-14T20:00:00'),
    ag('fora-passado', '2026-06-01T10:00:00'), // semana anterior
    ag('fora-futuro', '2026-06-20T10:00:00'), // semana seguinte
    ag('sem-data', null),
  ];

  it('coloca cada evento na coluna do seu dia', () => {
    const s = buildSemana(lista, 0, NOW);
    const byKey = Object.fromEntries(s.dias.map((d) => [d.dateKey, d.eventos.map((e) => e.id)]));
    expect(byKey['2026-06-08']).toEqual(['seg']);
    expect(byKey['2026-06-14']).toEqual(['dom']);
  });

  it('ordena a coluna por horário ASC', () => {
    const s = buildSemana(lista, 0, NOW);
    const qua = s.dias.find((d) => d.dateKey === '2026-06-10');
    expect(qua?.eventos.map((e) => e.id)).toEqual(['qua-manha', 'qua-tarde']);
  });

  it('ignora eventos fora da semana e sem data', () => {
    const s = buildSemana(lista, 0, NOW);
    const todos = s.dias.flatMap((d) => d.eventos.map((e) => e.id));
    expect(todos).not.toContain('fora-passado');
    expect(todos).not.toContain('fora-futuro');
    expect(todos).not.toContain('sem-data');
  });

  it('date puro "YYYY-MM-DD" cai no dia local certo', () => {
    const s = buildSemana([ag('puro', '2026-06-12')], 0, NOW);
    const sex = s.dias.find((d) => d.dateKey === '2026-06-12');
    expect(sex?.eventos.map((e) => e.id)).toEqual(['puro']);
  });
});

describe('semDataCount', () => {
  it('conta só os eventos sem inicio válido', () => {
    expect(semDataCount([ag('a', null), ag('b', '2026-06-10T10:00:00'), ag('c', 'invalido')])).toBe(
      2,
    );
  });
});
