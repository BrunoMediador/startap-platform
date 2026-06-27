import { describe, expect, it } from 'vitest';
import type { Agendamento } from './api-types';
import {
  AHEAD_CAP,
  PAST_CAP,
  agendaPeriodoLimites,
  agendaPeriodoPadrao,
  agendaPeriodoPresets,
  filtrarPorPeriodo,
  periodoParaPastAhead,
} from './colaborador-agenda-periodo';

// Fixa "hoje" = 2026-06-23 (terça) pra os cálculos serem determinísticos.
const NOW = new Date(2026, 5, 23, 10, 0, 0); // mês 5 = junho (0-based)

function ag(id: string, inicio: string | null): Agendamento {
  return { id, titulo: `Corte ${id}`, inicio, fim: null };
}

describe('agendaPeriodoPadrao', () => {
  it('janela default = hoje-7 .. hoje+14 (preserva o que era exibido antes)', () => {
    expect(agendaPeriodoPadrao(NOW)).toEqual({ de: '2026-06-16', ate: '2026-07-07' });
  });
});

describe('agendaPeriodoLimites', () => {
  it('trava o picker dentro do que o backend suporta (hoje-30 .. hoje+60)', () => {
    const lim = agendaPeriodoLimites({ de: '2026-06-16', ate: '2026-07-07' }, NOW);
    expect(lim.de.min).toBe('2026-05-24'); // hoje - 30
    expect(lim.ate.max).toBe('2026-08-22'); // hoje + 60
  });

  it('mantém a janela coerente (de <= ate)', () => {
    const lim = agendaPeriodoLimites({ de: '2026-06-16', ate: '2026-07-07' }, NOW);
    expect(lim.de.max).toBe('2026-07-07'); // de não passa do ate
    expect(lim.ate.min).toBe('2026-06-16'); // ate não fica antes do de
  });
});

describe('agendaPeriodoPresets', () => {
  it('oferece Hoje / Próx. 7 / Próx. 30 / Últimos 7', () => {
    const presets = agendaPeriodoPresets(NOW);
    expect(presets.map((p) => p.label)).toEqual([
      'Hoje',
      'Próx. 7 dias',
      'Próx. 30 dias',
      'Últimos 7 dias',
    ]);
    expect(presets[0]?.value).toEqual({ de: '2026-06-23', ate: '2026-06-23' });
    expect(presets[3]?.value).toEqual({ de: '2026-06-16', ate: '2026-06-23' });
  });
});

describe('periodoParaPastAhead', () => {
  it('converte a janela em past/ahead relativos a hoje', () => {
    expect(periodoParaPastAhead({ de: '2026-06-16', ate: '2026-07-07' }, NOW)).toEqual({
      past: 7,
      ahead: 14,
    });
  });

  it('capa past em 30 e ahead em 60 (limites do backend)', () => {
    const r = periodoParaPastAhead({ de: '2020-01-01', ate: '2030-01-01' }, NOW);
    expect(r.past).toBe(PAST_CAP);
    expect(r.ahead).toBe(AHEAD_CAP);
  });

  it('de no futuro -> past=0; ate no passado -> ahead=1 (nunca abaixo do mínimo)', () => {
    expect(periodoParaPastAhead({ de: '2026-06-30', ate: '2026-07-05' }, NOW).past).toBe(0);
    expect(periodoParaPastAhead({ de: '2026-06-01', ate: '2026-06-10' }, NOW).ahead).toBe(1);
  });

  it('datas vazias caem no default (-7 / +14)', () => {
    expect(periodoParaPastAhead({ de: '', ate: '' }, NOW)).toEqual({ past: 7, ahead: 14 });
  });
});

describe('filtrarPorPeriodo', () => {
  const lista = [
    ag('a', '2026-06-10T09:00:00-03:00'), // antes do de
    ag('b', '2026-06-23T09:00:00-03:00'), // dentro
    ag('c', '2026-07-07T18:00:00-03:00'), // último dia (inclusive)
    ag('d', '2026-07-20T09:00:00-03:00'), // depois do ate
    ag('e', null), // sem horário -> mantido
  ];

  it('apara pro intervalo exato [de, ate], inclusive no último dia', () => {
    const r = filtrarPorPeriodo(lista, { de: '2026-06-16', ate: '2026-07-07' });
    expect(r.map((x) => x.id)).toEqual(['b', 'c', 'e']);
  });

  it('preserva agendamentos sem horário (não somem da tela)', () => {
    const r = filtrarPorPeriodo([ag('z', null)], { de: '2026-06-16', ate: '2026-06-17' });
    expect(r.map((x) => x.id)).toEqual(['z']);
  });
});
