import { describe, expect, it } from 'vitest';
import {
  defaultBloqueioFormValues,
  formatDateInputInTimeZone,
  formatTimeInputInTimeZone,
  isAgendaBloqueio,
  separarAgendamentosDeBloqueios,
  zonedDateTimeToUtcIso,
} from './agenda-bloqueios';
import type { Agendamento } from './api-types';

describe('isAgendaBloqueio', () => {
  it('detecta summaries de bloqueio pelo prefixo canonico', () => {
    expect(isAgendaBloqueio({ titulo: 'Bloqueio: Almoco - intervalo' })).toBe(true);
    expect(isAgendaBloqueio({ titulo: 'Joao - Corte | WhatsApp: 5511999999999' })).toBe(false);
  });
});

describe('separarAgendamentosDeBloqueios', () => {
  it('separa bloqueios da lista normal da agenda', () => {
    const itens: Agendamento[] = [
      { id: 'evt-1', titulo: 'Cliente - Corte', inicio: '2026-08-21T10:00:00Z', fim: null },
      {
        id: 'evt-2',
        titulo: 'Bloqueio: Ferias - descanso',
        inicio: '2026-08-22T10:00:00Z',
        fim: null,
      },
    ];

    const out = separarAgendamentosDeBloqueios(itens);
    expect(out.agendamentos.map((item) => item.id)).toEqual(['evt-1']);
    expect(out.bloqueios.map((item) => item.id)).toEqual(['evt-2']);
  });
});

describe('zonedDateTimeToUtcIso', () => {
  it('converte horario local da agenda de Sao Paulo para UTC', () => {
    expect(zonedDateTimeToUtcIso('2026-08-21', '12:30', 'America/Sao_Paulo')).toBe(
      '2026-08-21T15:30:00.000Z',
    );
  });

  it('converte horario local da agenda de Cuiaba para UTC', () => {
    expect(zonedDateTimeToUtcIso('2026-08-21', '12:30', 'America/Cuiaba')).toBe(
      '2026-08-21T16:30:00.000Z',
    );
  });
});

describe('defaults de formulario', () => {
  it('gera datas e horas no fuso escolhido', () => {
    const now = new Date('2026-08-20T15:10:00.000Z');
    const values = defaultBloqueioFormValues('America/Sao_Paulo', now);

    expect(values.inicioData).toBe(
      formatDateInputInTimeZone('America/Sao_Paulo', new Date(now.getTime() + 30 * 60_000)),
    );
    expect(values.inicioHora).toBe(
      formatTimeInputInTimeZone('America/Sao_Paulo', new Date(now.getTime() + 30 * 60_000)),
    );
    expect(values.fimHora).toBe(
      formatTimeInputInTimeZone('America/Sao_Paulo', new Date(now.getTime() + 90 * 60_000)),
    );
  });
});
