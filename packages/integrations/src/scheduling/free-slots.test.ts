/**
 * Testes unitários para loadScheduleConfig (V3 — sem fallback silencioso).
 *
 * Não conecta no banco — usa mocks do módulo @startap/db.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks devem ser declarados antes do import do módulo testado.
vi.mock('@startap/db', () => ({
  flowClones: {
    getCloneBySlot: vi.fn(),
  },
  query: vi.fn(),
}));

import { flowClones, query } from '@startap/db';
import {
  computeFreeSlotsForDay,
  loadScheduleConfig,
  weekdayOfDateKey,
  zonedWallTimeToUtc,
} from './free-slots.js';

const mockGetCloneBySlot = vi.mocked(flowClones.getCloneBySlot);
const mockQuery = vi.mocked(query);

const HORARIOS_VALIDOS = {
  domingo: { fechado: true },
  segunda: { fechado: false, abre: '09:00', fecha: '18:00' },
  terca: { fechado: false, abre: '09:00', fecha: '18:00' },
  quarta: { fechado: false, abre: '09:00', fecha: '18:00' },
  quinta: { fechado: false, abre: '09:00', fecha: '18:00' },
  sexta: { fechado: false, abre: '09:00', fecha: '18:00' },
  sabado: { fechado: false, abre: '09:00', fecha: '18:00' },
};

const SERVICOS_VALIDOS = [
  { nome: 'Corte', duracao_min: 30, preco_cents: 2500 },
  { nome: 'Barba', duracao_min: 30, preco_cents: 2000 },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadScheduleConfig — caminho feliz', () => {
  it('retorna config do clone quando flow_clones tem horarios e servicos', async () => {
    mockGetCloneBySlot.mockResolvedValue({
      slot: 'clone_cirilobarbearia_c8w2f0',
      matriz_slot: 'teste_barbearia',
      horarios_funcionamento: HORARIOS_VALIDOS,
      servicos: SERVICOS_VALIDOS,
    } as never);

    const cfg = await loadScheduleConfig('clone_cirilobarbearia_c8w2f0');

    expect(cfg.source).toBe('flow_clones');
    expect(cfg.services).toHaveLength(2);
    expect(cfg.services[0]?.name).toBe('Corte');
    expect(cfg.work[1]).toEqual([9 * 60, 18 * 60]);
  });

  it('cai para bot_config da matriz quando clone existe mas sem config', async () => {
    mockGetCloneBySlot.mockResolvedValue({
      slot: 'clone_sem_config',
      matriz_slot: 'teste_barbearia',
      horarios_funcionamento: null,
      servicos: null,
    } as never);

    mockQuery.mockResolvedValue({
      rows: [
        {
          horarios_funcionamento: HORARIOS_VALIDOS,
          servicos: SERVICOS_VALIDOS,
        },
      ],
    } as never);

    const cfg = await loadScheduleConfig('clone_sem_config');

    expect(cfg.source).toBe('bot_config');
    expect(cfg.services).toHaveLength(2);
  });

  it('retorna config do bot_config quando nao ha clone (slot e a propria matriz)', async () => {
    mockGetCloneBySlot.mockResolvedValue(null);

    mockQuery.mockResolvedValue({
      rows: [
        {
          horarios_funcionamento: HORARIOS_VALIDOS,
          servicos: SERVICOS_VALIDOS,
        },
      ],
    } as never);

    const cfg = await loadScheduleConfig('teste_barbearia');

    expect(cfg.source).toBe('bot_config');
  });
});

describe('loadScheduleConfig — erro explícito (V3: sem fallback silencioso)', () => {
  it('lanca erro quando clone existe mas nem clone nem matriz tem config', async () => {
    mockGetCloneBySlot.mockResolvedValue({
      slot: 'clone_mal_configurado',
      matriz_slot: 'matriz_mal_configurada',
      horarios_funcionamento: null,
      servicos: null,
    } as never);

    // Matriz também sem config
    mockQuery.mockResolvedValue({ rows: [] } as never);

    await expect(loadScheduleConfig('clone_mal_configurado')).rejects.toThrow(
      "Configuração de horários/serviços ausente para o slot 'clone_mal_configurado'",
    );
  });

  it('lanca erro quando nao ha clone e bot_config do slot esta sem config', async () => {
    mockGetCloneBySlot.mockResolvedValue(null);
    mockQuery.mockResolvedValue({ rows: [] } as never);

    await expect(loadScheduleConfig('slot_sem_config')).rejects.toThrow(
      "Configuração de horários/serviços ausente para o slot 'slot_sem_config'",
    );
  });

  it('lanca erro quando nao ha clone e bot_config tem horarios mas sem servicos', async () => {
    mockGetCloneBySlot.mockResolvedValue(null);
    mockQuery.mockResolvedValue({
      rows: [
        {
          horarios_funcionamento: HORARIOS_VALIDOS,
          servicos: [],
        },
      ],
    } as never);

    await expect(loadScheduleConfig('slot_sem_servicos')).rejects.toThrow(
      "Configuração de horários/serviços ausente para o slot 'slot_sem_servicos'",
    );
  });

  it('NAO retorna BUILTIN_DEFAULTS em nenhum cenario — o tipo "defaults" foi removido', async () => {
    mockGetCloneBySlot.mockResolvedValue(null);
    mockQuery.mockResolvedValue({ rows: [] } as never);

    // Garantir que não é possível obter source: 'defaults' — o tipo foi removido do ScheduleConfig.
    // A promise deve rejeitar antes de qualquer return.
    const result = loadScheduleConfig('qualquer_slot');
    await expect(result).rejects.toThrow();
  });
});

// ---- computeFreeSlotsForDay (Missão 020 F4 — grade do agendamento manual) ----
//
// Funções puras: sem mock de banco. Datas fixas — 2026-06-13 é sábado (wd 6),
// 2026-06-14 é domingo (wd 0). `now` injetado pra não depender do relógio real.

const WORK_SAB_09_12: Record<number, [number, number] | null> = {
  0: null,
  1: null,
  2: null,
  3: null,
  4: null,
  5: null,
  6: [9 * 60, 12 * 60],
};

// Relógio de referência: quarta 2026-06-10 12:00 BRT (antes dos dias-alvo).
const NOW_REF = new Date('2026-06-10T12:00:00-03:00');

function evento(inicio: string, fim: string) {
  return {
    id: 'ev',
    summary: 'Fulano - Corte | WhatsApp: 5511999990000',
    start: { dateTime: inicio },
    end: { dateTime: fim },
  };
}

describe('computeFreeSlotsForDay', () => {
  it('dia fechado retorna vazio', () => {
    const slots = computeFreeSlotsForDay([], WORK_SAB_09_12, {
      dateKey: '2026-06-14', // domingo: fechado
      durationMin: 30,
      now: NOW_REF,
    });
    expect(slots).toEqual([]);
  });

  it('dia no passado retorna vazio mesmo se aberto', () => {
    const slots = computeFreeSlotsForDay([], WORK_SAB_09_12, {
      dateKey: '2026-06-06', // sábado anterior ao NOW_REF
      durationMin: 30,
      now: NOW_REF,
    });
    expect(slots).toEqual([]);
  });

  it('duração 30min sem eventos: grade alinhada 09:00..11:30', () => {
    const slots = computeFreeSlotsForDay([], WORK_SAB_09_12, {
      dateKey: '2026-06-13',
      durationMin: 30,
      now: NOW_REF,
    });
    expect(slots).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
  });

  it('evento 10:00-10:30 abre o buraco certo na grade de 30min', () => {
    const slots = computeFreeSlotsForDay(
      [evento('2026-06-13T10:00:00-03:00', '2026-06-13T10:30:00-03:00')],
      WORK_SAB_09_12,
      { dateKey: '2026-06-13', durationMin: 30, now: NOW_REF },
    );
    expect(slots).toEqual(['09:00', '09:30', '10:30', '11:00', '11:30']);
  });

  it('duração 45min: passo 45, último slot encaixa exato no fechamento', () => {
    const slots = computeFreeSlotsForDay([], WORK_SAB_09_12, {
      dateKey: '2026-06-13',
      durationMin: 45,
      now: NOW_REF,
    });
    // 11:15 + 45 = 12:00 (fecha) — encaixa; 12:00 não cabe.
    expect(slots).toEqual(['09:00', '09:45', '10:30', '11:15']);
  });

  it('duração 45min com evento 10:00-10:30: bloqueia só o slot que sobrepõe', () => {
    const slots = computeFreeSlotsForDay(
      [evento('2026-06-13T10:00:00-03:00', '2026-06-13T10:30:00-03:00')],
      WORK_SAB_09_12,
      { dateKey: '2026-06-13', durationMin: 45, now: NOW_REF },
    );
    // 09:45-10:30 sobrepõe o evento; 10:30-11:15 encosta sem sobrepor (livre).
    expect(slots).toEqual(['09:00', '10:30', '11:15']);
  });

  it('HOJE aplica piso de 10min arredondado pro passo do serviço', () => {
    // Sábado 09:12 BRT: piso = ceil((552+10)/30)*30 = 570 → primeiro slot 09:30.
    const slots = computeFreeSlotsForDay([], WORK_SAB_09_12, {
      dateKey: '2026-06-13',
      durationMin: 30,
      now: new Date('2026-06-13T09:12:00-03:00'),
    });
    expect(slots).toEqual(['09:30', '10:00', '10:30', '11:00', '11:30']);
  });

  it('eventos de outro dia não afetam a grade do dia alvo', () => {
    const slots = computeFreeSlotsForDay(
      [evento('2026-06-06T10:00:00-03:00', '2026-06-06T10:30:00-03:00')],
      WORK_SAB_09_12,
      { dateKey: '2026-06-13', durationMin: 30, now: NOW_REF },
    );
    expect(slots).toContain('10:00');
    expect(slots).toHaveLength(6);
  });

  it('data inválida retorna vazio', () => {
    const slots = computeFreeSlotsForDay([], WORK_SAB_09_12, {
      dateKey: '2026-02-31',
      durationMin: 30,
      now: NOW_REF,
    });
    expect(slots).toEqual([]);
  });
});

describe('zonedWallTimeToUtc / weekdayOfDateKey', () => {
  it('converte hora de parede BRT pra instante UTC (-03:00)', () => {
    expect(zonedWallTimeToUtc('2026-06-13', 10 * 60).toISOString()).toBe(
      '2026-06-13T13:00:00.000Z',
    );
    // 24:00 de parede = 00:00 do dia seguinte.
    expect(zonedWallTimeToUtc('2026-06-13', 24 * 60).toISOString()).toBe(
      '2026-06-14T03:00:00.000Z',
    );
  });

  it('weekdayOfDateKey: sábado=6, domingo=0, data inexistente=null', () => {
    expect(weekdayOfDateKey('2026-06-13')).toBe(6);
    expect(weekdayOfDateKey('2026-06-14')).toBe(0);
    expect(weekdayOfDateKey('2026-02-31')).toBeNull();
  });
});
