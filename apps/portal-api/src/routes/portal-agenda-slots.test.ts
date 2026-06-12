/**
 * Testes do GET /portal/agenda/slots (Missão 020 F4 — agendamento manual).
 *
 * DB e GCal MOCKADOS — nada bate em banco/agenda real. O cálculo de slots
 * (computeFreeSlotsForDay) roda com a implementação REAL — é exatamente o
 * contrato que o front consome. Invariante anti-IDOR: slot SEMPRE da sessão.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// config.js valida process.env no import (cadeia tenant.js -> session.js) — mockamos.
vi.mock('../config.js', () => ({
  config: { NODE_ENV: 'test', REDIS_HOST: 'localhost', REDIS_PORT: 6379, REDIS_PASSWORD: '' },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('@startap/db', () => ({
  flowClones: { getCloneBySlot: vi.fn() },
  query: vi.fn(),
  portalUsers: { getSlotForActivePortalUser: vi.fn() },
}));

const { getGcalForSlotMock, invalidateGcalCacheMock } = vi.hoisted(() => ({
  getGcalForSlotMock: vi.fn(),
  invalidateGcalCacheMock: vi.fn(),
}));
vi.mock('@startap/integrations', () => ({
  gcal: {
    getGcalForSlot: (...a: unknown[]) => getGcalForSlotMock(...a),
    invalidateGcalCache: (...a: unknown[]) => invalidateGcalCacheMock(...a),
  },
}));

// loadScheduleConfig mockado (config vem do banco); funções puras REAIS via
// importOriginal — o spread mantém computeFreeSlotsForDay etc. de verdade.
const { loadScheduleConfigMock } = vi.hoisted(() => ({ loadScheduleConfigMock: vi.fn() }));
vi.mock('@startap/integrations/scheduling', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@startap/integrations/scheduling')>();
  return { ...actual, loadScheduleConfig: (...a: unknown[]) => loadScheduleConfigMock(...a) };
});

// withTenant stub: injeta tenant fixo (slot da sessão). Auth real em tenant.test.ts.
const injectedSlot = 'clone_teste_a1b2c3';
vi.mock('../lib/tenant.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/tenant.js')>('../lib/tenant.js');
  return {
    ...actual,
    withTenant: vi.fn(async (req: { tenant?: unknown }) => {
      req.tenant = { slot: injectedSlot, userId: 7, username: 'dono', sid: 'sid-atual' };
    }),
  };
});

// O mock acima só troca loadScheduleConfig — nowPartsInTz aqui é a REAL.
import { nowPartsInTz } from '@startap/integrations/scheduling';
import Fastify, { type FastifyInstance } from 'fastify';
import { groupSlots, portalAgendaSlotsRoutes } from './portal-agenda-slots.js';

const WORK_ABERTO_TODOS: Record<number, [number, number] | null> = {
  0: [9 * 60, 19 * 60],
  1: [9 * 60, 19 * 60],
  2: [9 * 60, 19 * 60],
  3: [9 * 60, 19 * 60],
  4: [9 * 60, 19 * 60],
  5: [9 * 60, 19 * 60],
  6: [9 * 60, 19 * 60],
};

const WORK_FECHADO_TODOS: Record<number, [number, number] | null> = {
  0: null,
  1: null,
  2: null,
  3: null,
  4: null,
  5: null,
  6: null,
};

const CONFIG_OK = {
  work: WORK_ABERTO_TODOS,
  services: [
    { name: 'Corte', min: 30 },
    { name: 'Corte + barba', min: 45 },
  ],
  source: 'flow_clones' as const,
};

// Dias dinâmicos (sem fake timers — fastify.inject não gosta): grade aberta
// todos os dias, então o weekday do dia futuro não importa.
const FUTURO = nowPartsInTz(new Date(Date.now() + 3 * 86_400_000)).dateKey;
const PASSADO = nowPartsInTz(new Date(Date.now() - 2 * 86_400_000)).dateKey;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalAgendaSlotsRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  loadScheduleConfigMock.mockResolvedValue(CONFIG_OK);
});

describe('GET /portal/agenda/slots', () => {
  it('200: grade livre com buraco do evento, agrupada manhã/tarde/noite', async () => {
    const listEvents = vi.fn().mockResolvedValue([
      {
        id: 'ev1',
        summary: 'Fulano - Corte | WhatsApp: 5511999990000',
        start: { dateTime: `${FUTURO}T10:00:00-03:00` },
        end: { dateTime: `${FUTURO}T10:30:00-03:00` },
      },
    ]);
    getGcalForSlotMock.mockResolvedValue({ listEvents });

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/portal/agenda/slots?data=${FUTURO}&servico=Corte`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gcal_configured).toBe(true);
    expect(body.aberto).toBe(true);
    expect(body.servico).toEqual({ nome: 'Corte', duracao_min: 30 });
    // 09:00-19:00 com passo 30 = 20 slots; evento tira o 10:00.
    expect(body.count).toBe(19);
    expect(body.slots).not.toContain('10:00');
    expect(body.slots).toContain('09:30');
    expect(body.slots).toContain('10:30');
    expect(body.grupos.manha).toEqual(['09:00', '09:30', '10:30', '11:00', '11:30']);
    expect(body.grupos.tarde[0]).toBe('12:00');
    expect(body.grupos.noite).toEqual(['18:00', '18:30']);
    // Anti-IDOR: slot veio da sessão, nunca da query.
    expect(loadScheduleConfigMock).toHaveBeenCalledWith(injectedSlot);
    expect(getGcalForSlotMock).toHaveBeenCalledWith(injectedSlot);
    await app.close();
  });

  it('duração 45min muda o passo da grade', async () => {
    const listEvents = vi.fn().mockResolvedValue([]);
    getGcalForSlotMock.mockResolvedValue({ listEvents });

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/portal/agenda/slots?data=${FUTURO}&servico=${encodeURIComponent('Corte + barba')}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.servico.duracao_min).toBe(45);
    expect(body.slots.slice(0, 3)).toEqual(['09:00', '09:45', '10:30']);
    await app.close();
  });

  it('dia fechado: aberto=false, slots vazios, GCal nem é consultado', async () => {
    loadScheduleConfigMock.mockResolvedValue({ ...CONFIG_OK, work: WORK_FECHADO_TODOS });
    const listEvents = vi.fn();
    getGcalForSlotMock.mockResolvedValue({ listEvents });

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/portal/agenda/slots?data=${FUTURO}&servico=Corte`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.aberto).toBe(false);
    expect(body.slots).toEqual([]);
    expect(listEvents).not.toHaveBeenCalled();
    await app.close();
  });

  it('GCal não configurado: 200 com gcal_configured=false (pré-setup, não é erro)', async () => {
    getGcalForSlotMock.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/portal/agenda/slots?data=${FUTURO}&servico=Corte`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().gcal_configured).toBe(false);
    expect(res.json().slots).toEqual([]);
    await app.close();
  });

  it('400: serviço não cadastrado no tenant', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/portal/agenda/slots?data=${FUTURO}&servico=Luzes`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('servico_nao_encontrado');
    await app.close();
  });

  it('400: data no passado', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/portal/agenda/slots?data=${PASSADO}&servico=Corte`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('data_no_passado');
    await app.close();
  });

  it('400: data em formato inválido', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/agenda/slots?data=13/06/2026&servico=Corte',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('parametros_invalidos');
    await app.close();
  });

  it('422: horários/serviços do fluxo não configurados', async () => {
    loadScheduleConfigMock.mockRejectedValue(new Error('Configuração ausente'));
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/portal/agenda/slots?data=${FUTURO}&servico=Corte`,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('config_ausente');
    await app.close();
  });

  it('502: falha do GCal ao listar eventos', async () => {
    getGcalForSlotMock.mockResolvedValue({
      listEvents: vi.fn().mockRejectedValue(new Error('GCal -> HTTP 500')),
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/portal/agenda/slots?data=${FUTURO}&servico=Corte`,
    });
    expect(res.statusCode).toBe(502);
    await app.close();
  });
});

describe('groupSlots', () => {
  it('agrupa por manhã (<12h), tarde (12-17h59) e noite (>=18h)', () => {
    expect(groupSlots(['09:00', '11:55', '12:00', '17:30', '18:00', '21:15'])).toEqual({
      manha: ['09:00', '11:55'],
      tarde: ['12:00', '17:30'],
      noite: ['18:00', '21:15'],
    });
  });
});
