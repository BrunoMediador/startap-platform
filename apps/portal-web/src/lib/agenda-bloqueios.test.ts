import { describe, expect, it } from 'vitest';
import {
  BLOQUEIO_PERIODICIDADE_LABELS,
  buildAgendaBloqueioRecorrenciaKey,
  buildCriarAgendaBloqueioSerieBody,
  buildPreviewAgendaBloqueioRecorrenciaBody,
  defaultBloqueioFormValues,
  falhaAgendaBloqueioSerieLabel,
  formatDateInputInTimeZone,
  formatTimeInputInTimeZone,
  initRevisaoAgendaBloqueioRecorrencia,
  isAgendaBloqueio,
  resumoResultadoAgendaBloqueioSerie,
  separarAgendamentosDeBloqueios,
  statusAgendaBloqueioRecorrenciaLabel,
  zonedDateTimeToUtcIso,
} from './agenda-bloqueios';
import type {
  AgendaBloqueioInput,
  Agendamento,
  CriarAgendaBloqueioSerieResponse,
  PreviewAgendaBloqueioRecorrencia,
} from './api-types';

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

describe('BLOQUEIO_PERIODICIDADE_LABELS', () => {
  it('cobre os 4 valores com copy igual ao fluxo de recorrencia existente', () => {
    expect(BLOQUEIO_PERIODICIDADE_LABELS).toEqual({
      semanal: 'Toda semana',
      mensal: 'Todo mes',
      trimestral: 'A cada 3 meses',
      semestral: 'A cada 6 meses',
    });
  });
});

describe('recorrencia de bloqueios', () => {
  const base: AgendaBloqueioInput = {
    inicio_at: '2026-08-28T15:00:00.000Z',
    fim_at: '2026-08-28T16:00:00.000Z',
    timezone: 'America/Sao_Paulo',
    tipo: 'almoco',
    motivo: 'Equipe em reuniao',
    colaborador_id: 7,
  };

  const previews: PreviewAgendaBloqueioRecorrencia[] = [
    {
      inicio_at: '2026-08-28T15:00:00.000Z',
      fim_at: '2026-08-28T16:00:00.000Z',
      status: 'livre',
    },
    {
      inicio_at: '2026-09-04T15:00:00.000Z',
      fim_at: '2026-09-04T16:00:00.000Z',
      status: 'ocupado',
    },
    {
      inicio_at: '2026-09-11T15:00:00.000Z',
      fim_at: '2026-09-11T16:00:00.000Z',
      status: 'fora_do_horario',
    },
  ];

  it('monta o body do preview com o mesmo payload do bloqueio simples', () => {
    expect(
      buildPreviewAgendaBloqueioRecorrenciaBody({
        base,
        periodicidade: 'mensal',
        ocorrencias: 4,
      }),
    ).toEqual({
      ...base,
      periodicidade: 'mensal',
      ocorrencias: 4,
    });
  });

  it('preserva a previa para revisao explicita antes da confirmacao', () => {
    const revisao = initRevisaoAgendaBloqueioRecorrencia(previews);
    expect(revisao).toEqual(previews);
  });

  it('envia no POST /serie os mesmos parametros canonicos da previa', () => {
    expect(
      buildCriarAgendaBloqueioSerieBody({
        base,
        periodicidade: 'mensal',
        ocorrencias: 4,
      }),
    ).toEqual({
      ...base,
      periodicidade: 'mensal',
      ocorrencias: 4,
    });
  });

  it('a chave da previa muda quando qualquer dado relevante muda', () => {
    const a = buildAgendaBloqueioRecorrenciaKey({
      base,
      periodicidade: 'semanal',
      ocorrencias: 3,
    });
    const b = buildAgendaBloqueioRecorrenciaKey({
      base: { ...base, motivo: 'Outro motivo' },
      periodicidade: 'semanal',
      ocorrencias: 3,
    });
    expect(a).not.toBe(b);
  });
});

describe('statusAgendaBloqueioRecorrenciaLabel / falhaAgendaBloqueioSerieLabel', () => {
  it('traduz os status e os reasons extras do backend', () => {
    expect(statusAgendaBloqueioRecorrenciaLabel('livre')).toBe('Livre');
    expect(statusAgendaBloqueioRecorrenciaLabel('ocupado')).toBe('Ja existe algo marcado');
    expect(statusAgendaBloqueioRecorrenciaLabel('fora_do_horario')).toBe(
      'Fora do horario de funcionamento',
    );
    expect(statusAgendaBloqueioRecorrenciaLabel('fechado')).toBe('Fechado nesse dia');
    expect(statusAgendaBloqueioRecorrenciaLabel('fora_da_janela')).toBe(
      'Fora do periodo permitido',
    );
    expect(statusAgendaBloqueioRecorrenciaLabel('passado')).toBe('Esse horario ja passou');
    expect(falhaAgendaBloqueioSerieLabel('gcal_rate_limit')).toBe(
      'A agenda ficou sobrecarregada nesse momento',
    );
    expect(falhaAgendaBloqueioSerieLabel('erro_gcal')).toBe(
      'Nao foi possivel confirmar com a agenda',
    );
  });
});

describe('resumoResultadoAgendaBloqueioSerie', () => {
  function resposta(criados: number, falhas: number): CriarAgendaBloqueioSerieResponse {
    return {
      ok: criados > 0,
      serie_id: 'serie-123',
      criados: Array.from({ length: criados }, (_, index) => ({
        id: `bloq-${index + 1}`,
        serie_id: 'serie-123',
        inicio_at: '2026-08-28T15:00:00.000Z',
        fim_at: '2026-08-28T16:00:00.000Z',
      })),
      falhas: Array.from({ length: falhas }, () => ({
        serie_id: 'serie-123',
        inicio_at: '2026-09-04T15:00:00.000Z',
        fim_at: '2026-09-04T16:00:00.000Z',
        error: 'conflito',
        reason: 'ocupado',
      })),
    };
  }

  it('explica total, parcial e falha total sem esconder o parcial', () => {
    expect(resumoResultadoAgendaBloqueioSerie(resposta(2, 0))).toBe('2 bloqueios criados.');
    expect(resumoResultadoAgendaBloqueioSerie(resposta(1, 0))).toBe('1 bloqueio criado.');
    expect(resumoResultadoAgendaBloqueioSerie(resposta(2, 1))).toContain('2 de 3 bloqueios');
    expect(resumoResultadoAgendaBloqueioSerie(resposta(0, 2))).toBe(
      'Nenhum bloqueio foi criado. Revise a serie e tente de novo.',
    );
  });
});
