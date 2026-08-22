import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  configMock,
  agendaCreate,
  agendaAttach,
  agendaGetForRecovery,
  agendaHasSerieForRecovery,
  agendaMarkFailed,
  agendaMarkCleanupFailed,
  agendaList,
  agendaListFutureBySerieId,
  agendaGetActive,
  agendaSoftDelete,
  agendaSeriesClaim,
  agendaSeriesMarkResult,
  agendaOperationCreatePlan,
  agendaOperationGet,
  agendaOperationList,
  agendaOperationClaimDispatch,
  agendaOperationClaimRecovery,
  agendaOperationMarkOccurrence,
  agendaOperationMarkResult,
  getScopeBySlot,
  getGcalForSlot,
  getGcalsForSlot,
  invalidateGcalCache,
} = vi.hoisted(() => ({
  configMock: {
    AGENDA_BLOQUEIOS_ENABLED: true,
    AGENDA_BLOQUEIOS_SLOTS: 'clone_owner',
    COLABORADOR_PORTAL_ENABLED: true,
  } as Record<string, unknown>,
  agendaCreate: vi.fn(),
  agendaAttach: vi.fn(),
  agendaGetForRecovery: vi.fn(),
  agendaHasSerieForRecovery: vi.fn(),
  agendaMarkFailed: vi.fn(),
  agendaMarkCleanupFailed: vi.fn(),
  agendaList: vi.fn(),
  agendaListFutureBySerieId: vi.fn(),
  agendaGetActive: vi.fn(),
  agendaSoftDelete: vi.fn(),
  agendaSeriesClaim: vi.fn(),
  agendaSeriesMarkResult: vi.fn(),
  agendaOperationCreatePlan: vi.fn(),
  agendaOperationGet: vi.fn(),
  agendaOperationList: vi.fn(),
  agendaOperationClaimDispatch: vi.fn(),
  agendaOperationClaimRecovery: vi.fn(),
  agendaOperationMarkOccurrence: vi.fn(),
  agendaOperationMarkResult: vi.fn(),
  getScopeBySlot: vi.fn(),
  getGcalForSlot: vi.fn(),
  getGcalsForSlot: vi.fn(),
  invalidateGcalCache: vi.fn(),
}));

vi.mock('../config.js', () => ({ config: configMock }));
vi.mock('@startap/db', () => ({
  agendaBloqueios: {
    create: agendaCreate,
    attachGcalEventId: agendaAttach,
    getByIdForRecovery: agendaGetForRecovery,
    hasSerieForRecovery: agendaHasSerieForRecovery,
    markCreateFailed: agendaMarkFailed,
    markCreateCleanupFailed: agendaMarkCleanupFailed,
    list: agendaList,
    listFutureActiveBySerieId: agendaListFutureBySerieId,
    getActiveById: agendaGetActive,
    softDeleteById: agendaSoftDelete,
  },
  agendaBloqueioSeries: {
    claimCreate: agendaSeriesClaim,
    markCreateResult: agendaSeriesMarkResult,
  },
  agendaBloqueioOperacoes: {
    createPlan: agendaOperationCreatePlan,
    getOperationForRecovery: agendaOperationGet,
    listForRecovery: agendaOperationList,
    claimDispatch: agendaOperationClaimDispatch,
    claimRecovery: agendaOperationClaimRecovery,
    markOccurrence: agendaOperationMarkOccurrence,
    markOperationResult: agendaOperationMarkResult,
  },
  cloneColaboradores: { getScopeBySlot },
}));
vi.mock('@startap/integrations', () => ({
  gcal: { getGcalForSlot, getGcalsForSlot, invalidateGcalCache },
}));
vi.mock('../lib/tenant.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/tenant.js')>('../lib/tenant.js');
  return {
    ...actual,
    withTenant: vi.fn(async (req: { tenant?: unknown }) => {
      req.tenant = {
        slot: 'clone_owner',
        userId: 22,
        username: 'dono',
        sid: 'sid-owner',
      };
    }),
    withColaborador: vi.fn(async (req: { colaborador?: unknown }) => {
      req.colaborador = {
        slot: 'clone_owner',
        tenantId: '00000000-0000-4000-8000-000000000001',
        colaboradorId: 7,
        username: 'bene',
        nome: 'Bene',
        sid: 'sid-colab',
      };
    }),
  };
});

import Fastify from 'fastify';
import { portalAgendaBloqueiosRoutes } from './portal-agenda-bloqueios.js';

const BASE_BODY = {
  inicio_at: '2026-08-21T12:00:00-03:00',
  fim_at: '2026-08-21T13:00:00-03:00',
  timezone: 'America/Sao_Paulo',
  tipo: 'almoco',
  motivo: 'intervalo',
};
const BASE_SERIE_BODY = {
  inicio_at: '2026-08-21T12:00:00-03:00',
  fim_at: '2026-08-21T13:00:00-03:00',
  timezone: 'America/Sao_Paulo',
  tipo: 'almoco',
  motivo: 'intervalo',
  periodicidade: 'semanal',
  ocorrencias: 2,
};
let durablePlan: Array<{
  operation_id: string;
  ordinal: number;
  inicio_at: string;
  fim_at: string;
  bloqueio_id: string;
  gcal_event_id: string;
  status: 'planned' | 'gcal_dispatch_started' | 'recovery_required' | 'active';
  error_code: string | null;
}> = [];

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(portalAgendaBloqueiosRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  configMock.AGENDA_BLOQUEIOS_ENABLED = true;
  configMock.AGENDA_BLOQUEIOS_SLOTS = 'clone_owner';
  configMock.COLABORADOR_PORTAL_ENABLED = true;
  getScopeBySlot.mockResolvedValue({
    tenant_id: '00000000-0000-4000-8000-000000000001',
    timezone: 'America/Sao_Paulo',
    product_type: 'estabelecimento',
    seat_cap: 2,
  });
  agendaCreate.mockResolvedValue({
    id: '11111111-1111-4111-8111-111111111111',
    slot: 'clone_owner',
    tenant_id: '00000000-0000-4000-8000-000000000001',
    colaborador_id: 8,
    gcal_event_id: null,
    status: 'creating',
  });
  agendaAttach.mockResolvedValue({
    id: '11111111-1111-4111-8111-111111111111',
    slot: 'clone_owner',
    tenant_id: '00000000-0000-4000-8000-000000000001',
    colaborador_id: 8,
    serie_id: null,
    gcal_event_id: 'gcal-block-1',
    status: 'active',
  });
  agendaGetForRecovery.mockResolvedValue(null);
  agendaHasSerieForRecovery.mockResolvedValue(false);
  agendaList.mockResolvedValue([]);
  agendaListFutureBySerieId.mockResolvedValue([]);
  agendaGetActive.mockResolvedValue(null);
  agendaSoftDelete.mockResolvedValue(null);
  agendaSeriesClaim.mockResolvedValue({
    claimed: true,
    serie: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'creating',
      response_status: null,
      response_body: null,
    },
  });
  agendaOperationCreatePlan.mockImplementation(
    async (input: {
      occurrences: Array<{
        ordinal: number;
        inicioAt: string;
        fimAt: string;
        bloqueioId: string;
        gcalEventId: string;
      }>;
    }) => {
      durablePlan = input.occurrences.map((occurrence) => ({
        operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        ordinal: occurrence.ordinal,
        inicio_at: occurrence.inicioAt,
        fim_at: occurrence.fimAt,
        bloqueio_id: occurrence.bloqueioId,
        gcal_event_id: occurrence.gcalEventId,
        status: 'planned',
        error_code: null,
      }));
      return {
        created: true,
        operation: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'planned' },
      };
    },
  );
  agendaOperationGet.mockResolvedValue({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    status: 'planned',
    actor_role: 'owner',
    actor_user_id: 22,
    actor_colaborador_id: null,
    timezone: 'America/Sao_Paulo',
    tipo: 'almoco',
    motivo: 'intervalo',
    response_status: null,
    response_body: null,
  });
  agendaOperationList.mockImplementation(async () => durablePlan);
  agendaOperationClaimDispatch.mockImplementation(async (input: { ordinal: number }) => {
    const occurrence = durablePlan.find((candidate) => candidate.ordinal === input.ordinal);
    if (!occurrence || occurrence.status !== 'planned') return null;
    occurrence.status = 'gcal_dispatch_started';
    return occurrence;
  });
  agendaOperationClaimRecovery.mockImplementation(async (input: { ordinal: number }) => {
    const occurrence = durablePlan.find((candidate) => candidate.ordinal === input.ordinal);
    if (!occurrence || occurrence.status !== 'recovery_required') return null;
    occurrence.status = 'gcal_dispatch_started';
    return occurrence;
  });
  getGcalForSlot.mockResolvedValue({
    createEvent: vi.fn().mockResolvedValue({ id: 'gcal-block-single' }),
    deleteEvent: vi.fn().mockResolvedValue(undefined),
    getEvent: vi.fn(),
    listEvents: vi.fn().mockResolvedValue([]),
  });
  getGcalsForSlot.mockResolvedValue([
    {
      colaboradorId: 7,
      nome: 'Bene',
      calendarId: 'cal-7',
      client: {
        createEvent: vi.fn().mockResolvedValue({ id: 'gcal-block-7' }),
        deleteEvent: vi.fn().mockResolvedValue(undefined),
        getEvent: vi.fn(),
        listEvents: vi.fn().mockResolvedValue([]),
      },
      servicos: [],
    },
    {
      colaboradorId: 8,
      nome: 'Outro',
      calendarId: 'cal-8',
      client: {
        createEvent: vi.fn().mockResolvedValue({ id: 'gcal-block-1' }),
        deleteEvent: vi.fn().mockResolvedValue(undefined),
        getEvent: vi.fn(),
        listEvents: vi.fn().mockResolvedValue([]),
      },
      servicos: [],
    },
  ]);
});

describe('AGENDA_BLOQUEIOS_ENABLED', () => {
  it('OFF -> 404 feature_off sem tocar DB/GCal mutante', async () => {
    configMock.AGENDA_BLOQUEIOS_ENABLED = false;
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios',
      payload: { ...BASE_BODY, colaborador_id: 8 },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'feature_off' });
    expect(agendaCreate).not.toHaveBeenCalled();
    expect(getGcalForSlot).not.toHaveBeenCalled();
    expect(getGcalsForSlot).not.toHaveBeenCalled();
    await app.close();
  });

  it('global ON + slot fora da allowlist -> 404 feature_off sem tocar DB/GCal', async () => {
    configMock.AGENDA_BLOQUEIOS_ENABLED = true;
    configMock.AGENDA_BLOQUEIOS_SLOTS = 'clone_barber_dragon_caly8b';
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios',
      payload: { ...BASE_BODY, colaborador_id: 8 },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'feature_off' });
    expect(agendaCreate).not.toHaveBeenCalled();
    expect(getGcalsForSlot).not.toHaveBeenCalled();
    await app.close();
  });

  it('colaborador com slot fora da allowlist -> 404 feature_off sem tocar DB/GCal', async () => {
    configMock.AGENDA_BLOQUEIOS_ENABLED = true;
    configMock.COLABORADOR_PORTAL_ENABLED = true;
    configMock.AGENDA_BLOQUEIOS_SLOTS = 'clone_barber_dragon_caly8b';
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/colaborador/bloqueios',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'feature_off' });
    expect(agendaList).not.toHaveBeenCalled();
    expect(getGcalsForSlot).not.toHaveBeenCalled();
    await app.close();
  });

  it('global ON + slot permitido na allowlist -> libera a rota', async () => {
    configMock.AGENDA_BLOQUEIOS_ENABLED = true;
    configMock.AGENDA_BLOQUEIOS_SLOTS = 'clone_barber_dragon_caly8b, clone_owner';
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/agenda/bloqueios' });

    expect(res.statusCode).toBe(200);
    expect(agendaList).toHaveBeenCalledWith(expect.objectContaining({ slot: 'clone_owner' }));
    await app.close();
  });

  it("global ON + AGENDA_BLOQUEIOS_SLOTS='*' -> libera a rota", async () => {
    configMock.AGENDA_BLOQUEIOS_ENABLED = true;
    configMock.AGENDA_BLOQUEIOS_SLOTS = '*';
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/agenda/bloqueios' });

    expect(res.statusCode).toBe(200);
    expect(agendaList).toHaveBeenCalled();
    await app.close();
  });

  it('global OFF + slot permitido -> 404 feature_off', async () => {
    configMock.AGENDA_BLOQUEIOS_ENABLED = false;
    configMock.AGENDA_BLOQUEIOS_SLOTS = 'clone_owner';
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/agenda/bloqueios' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'feature_off' });
    expect(agendaList).not.toHaveBeenCalled();
    await app.close();
  });

  it('COLABORADOR_PORTAL_ENABLED OFF -> 404 no colaborador sem tocar DB/GCal', async () => {
    configMock.COLABORADOR_PORTAL_ENABLED = false;
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/colaborador/bloqueios',
      payload: { ...BASE_BODY },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'feature_off' });
    expect(agendaCreate).not.toHaveBeenCalled();
    expect(getGcalsForSlot).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('POST /portal/agenda/bloqueios — dono', () => {
  it("cria no colaborador do tenant e envia marker privado kind='bloqueio' ao GCal", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios',
      payload: { ...BASE_BODY, colaborador_id: 8 },
    });

    expect(res.statusCode).toBe(201);
    const created = agendaCreate.mock.calls[0][0];
    const expectedEventId = `bloq${String(created.id).replaceAll('-', '')}`;
    expect(agendaCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: created.id,
        tenantId: '00000000-0000-4000-8000-000000000001',
        slot: 'clone_owner',
        colaboradorId: 8,
        gcalEventId: expectedEventId,
        createdByRole: 'owner',
        createdByUserId: 22,
      }),
    );
    const colab8 = (await getGcalsForSlot.mock.results[0].value)[1];
    expect(colab8.client.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: expectedEventId,
        summary: 'Bloqueio: Almoço - intervalo',
        extendedPropertiesPrivate: {
          kind: 'bloqueio',
          bloqueioId: created.id,
          colaboradorId: '8',
        },
      }),
    );
    expect(agendaAttach).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      'clone_owner',
      created.id,
      expectedEventId,
    );
    await app.close();
  });

  it('createEvent com timeout ambíguo tenta cleanup pelo eventId determinístico e soft-deleta quando cleanup passa', async () => {
    const createEvent = vi.fn().mockRejectedValue(new Error('network timeout after insert'));
    const deleteEvent = vi.fn().mockResolvedValue(undefined);
    getGcalsForSlot.mockResolvedValueOnce([
      {
        colaboradorId: 8,
        nome: 'Outro',
        calendarId: 'cal-8',
        client: { createEvent, deleteEvent },
        servicos: [],
      },
    ]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios',
      payload: { ...BASE_BODY, colaborador_id: 8 },
    });

    expect(res.statusCode).toBe(502);
    const created = agendaCreate.mock.calls[0][0];
    const expectedEventId = `bloq${String(created.id).replaceAll('-', '')}`;
    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({ eventId: expectedEventId }));
    expect(deleteEvent).toHaveBeenCalledWith(expectedEventId);
    expect(agendaMarkFailed).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      'clone_owner',
      created.id,
    );
    expect(agendaMarkCleanupFailed).not.toHaveBeenCalled();
    await app.close();
  });

  it('attach local falha após createEvent e faz cleanup pelo mesmo eventId determinístico', async () => {
    agendaAttach.mockResolvedValueOnce(null);
    const deleteEvent = vi.fn().mockResolvedValue(undefined);
    getGcalsForSlot.mockResolvedValueOnce([
      {
        colaboradorId: 8,
        nome: 'Outro',
        calendarId: 'cal-8',
        client: {
          createEvent: vi.fn().mockResolvedValue({ id: 'ignored-by-route' }),
          deleteEvent,
        },
        servicos: [],
      },
    ]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios',
      payload: { ...BASE_BODY, colaborador_id: 8 },
    });

    expect(res.statusCode).toBe(502);
    const created = agendaCreate.mock.calls[0][0];
    const expectedEventId = `bloq${String(created.id).replaceAll('-', '')}`;
    expect(deleteEvent).toHaveBeenCalledWith(expectedEventId);
    expect(agendaMarkFailed).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      'clone_owner',
      created.id,
    );
    expect(agendaMarkCleanupFailed).not.toHaveBeenCalled();
    await app.close();
  });

  it('quando cleanup GCal falha, persiste gcal_cleanup_failed listável/removível', async () => {
    agendaAttach.mockResolvedValueOnce(null);
    const deleteEvent = vi.fn().mockRejectedValue(new Error('HTTP 503'));
    getGcalsForSlot.mockResolvedValueOnce([
      {
        colaboradorId: 8,
        nome: 'Outro',
        calendarId: 'cal-8',
        client: {
          createEvent: vi.fn().mockResolvedValue({ id: 'ignored-by-route' }),
          deleteEvent,
        },
        servicos: [],
      },
    ]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios',
      payload: { ...BASE_BODY, colaborador_id: 8 },
    });

    expect(res.statusCode).toBe(502);
    const created = agendaCreate.mock.calls[0][0];
    expect(agendaMarkCleanupFailed).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      'clone_owner',
      created.id,
    );
    expect(agendaMarkFailed).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('recorrência de bloqueios', () => {
  it('preview diaria recalcula dias corridos consecutivos e consulta o GCal por ocorrência', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios/recorrencia/preview',
      payload: {
        ...BASE_BODY,
        colaborador_id: 8,
        periodicidade: 'diaria',
        ocorrencias: 3,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.previews).toEqual([
      expect.objectContaining({ inicio_at: '2026-08-21T15:00:00.000Z', status: 'livre' }),
      expect.objectContaining({ inicio_at: '2026-08-22T15:00:00.000Z', status: 'livre' }),
      expect.objectContaining({ inicio_at: '2026-08-23T15:00:00.000Z', status: 'livre' }),
    ]);
    const colab8 = (await getGcalsForSlot.mock.results[0].value)[1];
    expect(colab8.client.listEvents).toHaveBeenCalledTimes(3);
    expect(colab8.client.createEvent).not.toHaveBeenCalled();
    await app.close();
  });

  it('preview expande datas, marca ocorrência livre e respeita cap de 24', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios/recorrencia/preview',
      payload: {
        ...BASE_BODY,
        colaborador_id: 8,
        periodicidade: 'semanal',
        ocorrencias: 3,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.previews).toEqual([
      expect.objectContaining({ inicio_at: '2026-08-21T15:00:00.000Z', status: 'livre' }),
      expect.objectContaining({ inicio_at: '2026-08-28T15:00:00.000Z', status: 'livre' }),
      expect.objectContaining({ inicio_at: '2026-09-04T15:00:00.000Z', status: 'livre' }),
    ]);
    const colab8 = (await getGcalsForSlot.mock.results[0].value)[1];
    expect(colab8.client.createEvent).not.toHaveBeenCalled();
    expect(colab8.client.listEvents).toHaveBeenCalledTimes(3);

    const invalid = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios/recorrencia/preview',
      payload: {
        ...BASE_BODY,
        periodicidade: 'semanal',
        ocorrencias: 25,
      },
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it('preview marca ocorrência ocupada e expõe só inicio/fim do conflito', async () => {
    const listEvents = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'evt-ocupado',
          summary: 'Nao deve vazar',
          start: { dateTime: '2026-08-28T15:15:00.000Z' },
          end: { dateTime: '2026-08-28T15:45:00.000Z' },
        },
      ])
      .mockResolvedValueOnce([]);
    getGcalsForSlot.mockResolvedValueOnce([
      {
        colaboradorId: 8,
        nome: 'Outro',
        calendarId: 'cal-8',
        client: {
          createEvent: vi.fn().mockResolvedValue({ id: 'gcal-block-1' }),
          deleteEvent: vi.fn().mockResolvedValue(undefined),
          listEvents,
        },
        servicos: [],
      },
    ]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios/recorrencia/preview',
      payload: {
        ...BASE_BODY,
        colaborador_id: 8,
        periodicidade: 'semanal',
        ocorrencias: 3,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.previews[0]).toEqual(expect.objectContaining({ status: 'livre' }));
    expect(body.previews[1]).toEqual({
      inicio_at: '2026-08-28T15:00:00.000Z',
      fim_at: '2026-08-28T16:00:00.000Z',
      timezone: 'America/Sao_Paulo',
      tipo: 'almoco',
      motivo: 'intervalo',
      colaborador_id: 8,
      status: 'ocupado',
      conflito: {
        inicio: '2026-08-28T15:15:00.000Z',
        fim: '2026-08-28T15:45:00.000Z',
      },
    });
    expect(body.previews[1].conflito.summary).toBeUndefined();
    await app.close();
  });

  it('POST /portal/agenda/bloqueios/serie retorna 207 parcial e carimba o mesmo serie_id nas ocorrências criadas', async () => {
    agendaCreate
      .mockResolvedValueOnce({
        id: '11111111-1111-4111-8111-111111111111',
        slot: 'clone_owner',
        tenant_id: '00000000-0000-4000-8000-000000000001',
        colaborador_id: 8,
        serie_id: null,
        gcal_event_id: null,
        status: 'creating',
      })
      .mockResolvedValueOnce({
        id: '22222222-2222-4222-8222-222222222222',
        slot: 'clone_owner',
        tenant_id: '00000000-0000-4000-8000-000000000001',
        colaborador_id: 8,
        serie_id: null,
        gcal_event_id: null,
        status: 'creating',
      })
      .mockResolvedValueOnce({
        id: '33333333-3333-4333-8333-333333333333',
        slot: 'clone_owner',
        tenant_id: '00000000-0000-4000-8000-000000000001',
        colaborador_id: 8,
        serie_id: null,
        gcal_event_id: null,
        status: 'creating',
      });
    agendaAttach
      .mockResolvedValueOnce({
        id: '11111111-1111-4111-8111-111111111111',
        slot: 'clone_owner',
        tenant_id: '00000000-0000-4000-8000-000000000001',
        colaborador_id: 8,
        serie_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        gcal_event_id: 'bloq11111111111141118111111111111111',
        status: 'active',
        inicio_at: '2026-08-21T15:00:00.000Z',
        fim_at: '2026-08-21T16:00:00.000Z',
      })
      .mockResolvedValueOnce({
        id: '33333333-3333-4333-8333-333333333333',
        slot: 'clone_owner',
        tenant_id: '00000000-0000-4000-8000-000000000001',
        colaborador_id: 8,
        serie_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        gcal_event_id: 'bloq33333333333343338333333333333333',
        status: 'active',
        inicio_at: '2026-09-04T15:00:00.000Z',
        fim_at: '2026-09-04T16:00:00.000Z',
      });
    const createEvent = vi
      .fn()
      .mockResolvedValueOnce({ id: 'evt-1' })
      .mockRejectedValueOnce(new Error('HTTP 503: downstream'))
      .mockResolvedValueOnce({ id: 'evt-3' });
    const deleteEvent = vi.fn().mockRejectedValue(new Error('HTTP 404'));
    getGcalsForSlot.mockResolvedValueOnce([
      {
        colaboradorId: 8,
        nome: 'Outro',
        calendarId: 'cal-8',
        client: { createEvent, deleteEvent },
        servicos: [],
      },
    ]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios/serie',
      payload: {
        ...BASE_SERIE_BODY,
        colaborador_id: 8,
        ocorrencias: 3,
      },
    });

    expect(res.statusCode).toBe(207);
    const body = res.json();
    expect(body.criados).toHaveLength(1);
    expect(body.falhas).toEqual([
      expect.objectContaining({
        inicio_at: '2026-08-28T15:00:00.000Z',
        error: 'gcal_falhou',
        reason: 'erro_gcal',
      }),
    ]);
    expect(body.serie_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    for (const call of agendaCreate.mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({ serieId: body.serie_id }));
    }
    expect(createEvent).toHaveBeenCalledTimes(2);
    for (const [index, call] of createEvent.mock.calls.entries()) {
      const bloqueioId = agendaCreate.mock.calls[index]?.[0]?.id;
      expect(call[0]).toEqual(
        expect.objectContaining({
          eventId: expect.stringMatching(/^bloqop[0-9a-f]{33,}$/),
          extendedPropertiesPrivate: {
            kind: 'bloqueio',
            bloqueioId,
            colaboradorId: '8',
            serie_id: body.serie_id,
          },
        }),
      );
    }
    expect(createEvent.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        startISO: '2026-08-21T15:00:00.000Z',
        endISO: '2026-08-21T16:00:00.000Z',
      }),
    );
    expect(createEvent.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        startISO: '2026-08-28T15:00:00.000Z',
        endISO: '2026-08-28T16:00:00.000Z',
      }),
    );
    expect(agendaOperationMarkOccurrence).toHaveBeenCalledWith(
      expect.objectContaining({ ordinal: 2, status: 'recovery_required' }),
    );
    await app.close();
  });

  it('POST /portal/agenda/bloqueios/serie com periodicidade diaria cria evento GCal para cada dia corrido', async () => {
    agendaCreate
      .mockResolvedValueOnce({
        id: 'aaaaaaa1-1111-4111-8111-111111111111',
        slot: 'clone_owner',
        tenant_id: '00000000-0000-4000-8000-000000000001',
        colaborador_id: 8,
        serie_id: null,
        gcal_event_id: null,
        status: 'creating',
      })
      .mockResolvedValueOnce({
        id: 'aaaaaaa2-2222-4222-8222-222222222222',
        slot: 'clone_owner',
        tenant_id: '00000000-0000-4000-8000-000000000001',
        colaborador_id: 8,
        serie_id: null,
        gcal_event_id: null,
        status: 'creating',
      })
      .mockResolvedValueOnce({
        id: 'aaaaaaa3-3333-4333-8333-333333333333',
        slot: 'clone_owner',
        tenant_id: '00000000-0000-4000-8000-000000000001',
        colaborador_id: 8,
        serie_id: null,
        gcal_event_id: null,
        status: 'creating',
      });
    agendaAttach
      .mockResolvedValueOnce({
        id: 'aaaaaaa1-1111-4111-8111-111111111111',
        slot: 'clone_owner',
        tenant_id: '00000000-0000-4000-8000-000000000001',
        colaborador_id: 8,
        serie_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        gcal_event_id: 'bloqaaaaaaa1111141118111111111111111',
        status: 'active',
        inicio_at: '2026-08-21T15:00:00.000Z',
        fim_at: '2026-08-21T16:00:00.000Z',
      })
      .mockResolvedValueOnce({
        id: 'aaaaaaa2-2222-4222-8222-222222222222',
        slot: 'clone_owner',
        tenant_id: '00000000-0000-4000-8000-000000000001',
        colaborador_id: 8,
        serie_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        gcal_event_id: 'bloqaaaaaaa2222242228222222222222222',
        status: 'active',
        inicio_at: '2026-08-22T15:00:00.000Z',
        fim_at: '2026-08-22T16:00:00.000Z',
      })
      .mockResolvedValueOnce({
        id: 'aaaaaaa3-3333-4333-8333-333333333333',
        slot: 'clone_owner',
        tenant_id: '00000000-0000-4000-8000-000000000001',
        colaborador_id: 8,
        serie_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        gcal_event_id: 'bloqaaaaaaa3333343338333333333333333',
        status: 'active',
        inicio_at: '2026-08-23T15:00:00.000Z',
        fim_at: '2026-08-23T16:00:00.000Z',
      });
    const createEvent = vi
      .fn()
      .mockResolvedValueOnce({ id: 'evt-1' })
      .mockResolvedValueOnce({ id: 'evt-2' })
      .mockResolvedValueOnce({ id: 'evt-3' });
    getGcalsForSlot.mockResolvedValueOnce([
      {
        colaboradorId: 8,
        nome: 'Outro',
        calendarId: 'cal-8',
        client: { createEvent, deleteEvent: vi.fn().mockResolvedValue(undefined) },
        servicos: [],
      },
    ]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios/serie',
      payload: {
        ...BASE_SERIE_BODY,
        colaborador_id: 8,
        periodicidade: 'diaria',
        ocorrencias: 3,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(createEvent).toHaveBeenCalledTimes(3);
    expect(createEvent.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        startISO: '2026-08-21T15:00:00.000Z',
        endISO: '2026-08-21T16:00:00.000Z',
      }),
    );
    expect(createEvent.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        startISO: '2026-08-22T15:00:00.000Z',
        endISO: '2026-08-22T16:00:00.000Z',
      }),
    );
    expect(createEvent.mock.calls[2][0]).toEqual(
      expect.objectContaining({
        startISO: '2026-08-23T15:00:00.000Z',
        endISO: '2026-08-23T16:00:00.000Z',
      }),
    );
    await app.close();
  });

  it('POST /portal/agenda/bloqueios/serie rejeita payload legado com datas arbitrárias e não cria nada', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios/serie',
      payload: {
        timezone: 'America/Sao_Paulo',
        tipo: 'almoco',
        motivo: 'intervalo',
        colaborador_id: 8,
        periodicidade: 'semanal',
        inicio_at: '2026-08-21T12:00:00-03:00',
        fim_at: '2026-08-21T13:00:00-03:00',
        ocorrencias: [
          {
            inicio_at: '2027-12-01T08:00:00-03:00',
            fim_at: '2027-12-01T10:00:00-03:00',
          },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(agendaCreate).not.toHaveBeenCalled();
    expect(agendaAttach).not.toHaveBeenCalled();
    expect(getGcalsForSlot).not.toHaveBeenCalled();
    await app.close();
  });

  it.skip('legado: claim da série anterior não duplica GCal', async () => {
    agendaSeriesClaim.mockResolvedValueOnce({
      claimed: false,
      serie: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        status: 'creating',
        response_status: null,
        response_body: null,
      },
    });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios/serie',
      payload: { ...BASE_SERIE_BODY, colaborador_id: 8 },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'serie_em_processamento' });
    expect(agendaCreate).not.toHaveBeenCalled();
    const claim = agendaSeriesClaim.mock.calls[0][0];
    expect(claim).toEqual(
      expect.objectContaining({
        tenantId: '00000000-0000-4000-8000-000000000001',
        slot: 'clone_owner',
        colaboradorId: 8,
      }),
    );
    expect(claim.sessionHash).not.toBe('sid-owner');
    await app.close();
  });

  it.skip('legado: claim creating fail-closed', async () => {
    const createEvent = vi.fn();
    getGcalsForSlot.mockResolvedValueOnce([
      {
        colaboradorId: 8,
        nome: 'Outro',
        calendarId: 'cal-8',
        client: { createEvent, deleteEvent: vi.fn() },
        servicos: [],
      },
    ]);
    agendaSeriesClaim.mockResolvedValueOnce({
      claimed: false,
      serie: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        status: 'creating',
        response_status: null,
        response_body: null,
      },
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios/serie',
      payload: { ...BASE_SERIE_BODY, colaborador_id: 8 },
    });
    expect(res.statusCode).toBe(409);
    expect(createEvent).not.toHaveBeenCalled();
    await app.close();
  });

  it.skip('legado: replay concluído da tabela agenda_bloqueio_series', async () => {
    agendaSeriesClaim.mockResolvedValueOnce({
      claimed: false,
      serie: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        status: 'complete',
        response_status: 201,
        response_body: {
          ok: true,
          serie_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          criados: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              inicio_at: '2026-08-21T15:00:00.000Z',
              fim_at: '2026-08-21T16:00:00.000Z',
            },
          ],
          falhas: [],
        },
      },
    });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios/serie',
      payload: { ...BASE_SERIE_BODY, colaborador_id: 8 },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      ok: true,
      idempotent: true,
      serie_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      criados: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          inicio_at: '2026-08-21T15:00:00.000Z',
          fim_at: '2026-08-21T16:00:00.000Z',
        },
      ],
      falhas: [],
    });
    expect(agendaCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it.skip('legado: replay partial da tabela agenda_bloqueio_series', async () => {
    const body = {
      ok: true,
      serie_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      criados: [{ id: '11111111-1111-4111-8111-111111111111', inicio_at: 'a', fim_at: 'b' }],
      falhas: [{ inicio_at: 'c', fim_at: 'd', error: 'gcal_falhou', reason: 'erro_gcal' }],
    };
    agendaSeriesClaim.mockResolvedValueOnce({
      claimed: false,
      serie: {
        id: body.serie_id,
        status: 'partial',
        response_status: 207,
        response_body: body,
      },
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios/serie',
      payload: { ...BASE_SERIE_BODY, colaborador_id: 8 },
    });
    expect(res.statusCode).toBe(207);
    expect(res.json()).toEqual({ ...body, idempotent: true });
    expect(agendaCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it.skip('legado: replay failed da tabela agenda_bloqueio_series', async () => {
    const body = {
      ok: false,
      serie_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      criados: [],
      falhas: [{ inicio_at: 'a', fim_at: 'b', error: 'erro_interno', reason: 'erro_interno' }],
    };
    agendaSeriesClaim.mockResolvedValueOnce({
      claimed: false,
      serie: { id: body.serie_id, status: 'failed', response_status: 502, response_body: body },
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios/serie',
      payload: { ...BASE_SERIE_BODY, colaborador_id: 8 },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ ...body, idempotent: true });
    expect(agendaCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it.skip('legado: retry seguro da tabela agenda_bloqueio_series', async () => {
    agendaCreate.mockRejectedValueOnce(new Error('db unavailable'));
    const app = await buildApp();

    const first = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios/serie',
      payload: { ...BASE_SERIE_BODY, colaborador_id: 8 },
    });
    expect(first.statusCode).toBe(502);
    expect(first.json()).toMatchObject({ ok: false, falhas: [{ error: 'erro_interno' }] });
    expect(agendaSeriesMarkResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', responseStatus: 502 }),
    );

    agendaSeriesClaim.mockResolvedValueOnce({
      claimed: true,
      serie: {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        status: 'creating',
        response_status: null,
        response_body: null,
      },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios/serie',
      payload: { ...BASE_SERIE_BODY, colaborador_id: 8 },
    });
    expect(second.statusCode).toBe(201);
    // O 1º INSERT falhou antes do GCal; o retry seguro cria só as 2 ocorrências da série nova.
    expect(agendaCreate).toHaveBeenCalledTimes(3);
    await app.close();
  });

  it('DELETE /portal/colaborador/bloqueios/serie escopa por colaboradorId da sessão e remove só a série futura retornada pelo DB', async () => {
    agendaListFutureBySerieId.mockResolvedValueOnce([
      {
        id: '44444444-4444-4444-8444-444444444444',
        tenant_id: '00000000-0000-4000-8000-000000000001',
        slot: 'clone_owner',
        colaborador_id: 7,
        serie_id: '55555555-5555-4555-8555-555555555555',
        gcal_event_id: 'gcal-block-7',
        inicio_at: '2026-08-29T12:00:00.000Z',
        fim_at: '2026-08-29T13:00:00.000Z',
        timezone: 'America/Sao_Paulo',
        tipo: 'almoco',
        motivo: 'intervalo',
        status: 'active',
        created_by_role: 'colaborador',
        created_by_user_id: null,
        created_by_colaborador_id: 7,
        deleted_at: null,
        created_at: '2026-08-20T00:00:00.000Z',
        updated_at: '2026-08-20T00:00:00.000Z',
      },
    ]);
    agendaSoftDelete.mockResolvedValueOnce({
      id: '44444444-4444-4444-8444-444444444444',
      inicio_at: '2026-08-29T12:00:00.000Z',
      fim_at: '2026-08-29T13:00:00.000Z',
      colaborador_id: 7,
      serie_id: '55555555-5555-4555-8555-555555555555',
      gcal_event_id: 'gcal-block-7',
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/portal/colaborador/bloqueios/serie/55555555-5555-4555-8555-555555555555',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      serie_id: '55555555-5555-4555-8555-555555555555',
      removidos: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          inicio_at: '2026-08-29T12:00:00.000Z',
          fim_at: '2026-08-29T13:00:00.000Z',
        },
      ],
      falhas: [],
    });
    expect(agendaListFutureBySerieId).toHaveBeenCalledWith({
      tenantId: '00000000-0000-4000-8000-000000000001',
      slot: 'clone_owner',
      serieId: '55555555-5555-4555-8555-555555555555',
      colaboradorId: 7,
    });
    expect(agendaSoftDelete).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      'clone_owner',
      '44444444-4444-4444-8444-444444444444',
      7,
    );
    await app.close();
  });
});

describe('colaborador — anti-IDOR por sessão', () => {
  it('POST ignora colaborador_id do body e cria só para colaboradorId da sessão', async () => {
    agendaCreate.mockResolvedValueOnce({
      id: '22222222-2222-4222-8222-222222222222',
      slot: 'clone_owner',
      tenant_id: '00000000-0000-4000-8000-000000000001',
      colaborador_id: 7,
      gcal_event_id: null,
      status: 'creating',
    });
    agendaAttach.mockResolvedValueOnce({
      id: '22222222-2222-4222-8222-222222222222',
      colaborador_id: 7,
      gcal_event_id: 'gcal-block-7',
      status: 'active',
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/colaborador/bloqueios',
      payload: { ...BASE_BODY, colaborador_id: 8 },
    });

    expect(res.statusCode).toBe(201);
    expect(agendaCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        colaboradorId: 7,
        createdByRole: 'colaborador',
        createdByColaboradorId: 7,
        createdByUserId: null,
      }),
    );
    const colab7 = (await getGcalsForSlot.mock.results[0].value)[0];
    const colab8 = (await getGcalsForSlot.mock.results[0].value)[1];
    expect(colab7.client.createEvent).toHaveBeenCalledTimes(1);
    expect(colab8.client.createEvent).not.toHaveBeenCalled();
    await app.close();
  });

  it('DELETE escopa por colaboradorId da sessão', async () => {
    agendaGetActive.mockResolvedValueOnce({
      id: '33333333-3333-4333-8333-333333333333',
      colaborador_id: 7,
      gcal_event_id: 'gcal-block-7',
    });
    agendaSoftDelete.mockResolvedValueOnce({ id: '33333333-3333-4333-8333-333333333333' });

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/portal/colaborador/bloqueios/33333333-3333-4333-8333-333333333333',
    });

    expect(res.statusCode).toBe(200);
    expect(agendaGetActive).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      'clone_owner',
      '33333333-3333-4333-8333-333333333333',
      7,
    );
    expect(agendaSoftDelete).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      'clone_owner',
      '33333333-3333-4333-8333-333333333333',
      7,
    );
    await app.close();
  });
});

describe('ADR 0044 — operação durável de bloqueios recorrentes', () => {
  it('commita operação e plano antes da primeira chamada ao GCal', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios/serie',
      payload: { ...BASE_SERIE_BODY, colaborador_id: 8 },
    });

    expect(res.statusCode).toBe(201);
    const planCall = agendaOperationCreatePlan.mock.calls[0]?.[0];
    expect(planCall).toEqual(
      expect.objectContaining({
        tenantId: '00000000-0000-4000-8000-000000000001',
        slot: 'clone_owner',
        colaboradorId: 8,
        actorRole: 'owner',
        occurrences: expect.arrayContaining([
          expect.objectContaining({ ordinal: 1, gcalEventId: expect.stringMatching(/^bloqop/) }),
        ]),
      }),
    );
    const colab8 = (await getGcalsForSlot.mock.results[0].value)[1];
    expect(agendaOperationCreatePlan.mock.invocationCallOrder[0]).toBeLessThan(
      colab8.client.createEvent.mock.invocationCallOrder[0],
    );
    await app.close();
  });

  it('timeout após dispatch marca recovery_required e replay HTTP não reenvia o GCal', async () => {
    const createEvent = vi.fn().mockRejectedValue(new Error('network timeout'));
    getGcalsForSlot.mockResolvedValueOnce([
      {
        colaboradorId: 8,
        nome: 'Outro',
        calendarId: 'cal-8',
        client: { createEvent },
        servicos: [],
      },
    ]);
    const app = await buildApp();
    const first = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios/serie',
      payload: { ...BASE_SERIE_BODY, colaborador_id: 8 },
    });

    expect(first.statusCode).toBe(207);
    expect(agendaOperationMarkOccurrence).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'recovery_required', errorCode: 'gcal_ambiguous' }),
    );
    expect(agendaOperationMarkResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'recovery_required', responseStatus: 207 }),
    );

    agendaOperationCreatePlan.mockResolvedValueOnce({
      created: false,
      operation: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'recovery_required' },
    });
    agendaOperationGet.mockResolvedValueOnce({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'recovery_required',
      actor_role: 'owner',
      actor_user_id: 22,
      actor_colaborador_id: null,
      timezone: 'America/Sao_Paulo',
      tipo: 'almoco',
      motivo: 'intervalo',
      response_status: 207,
      response_body: {
        ok: false,
        serie_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        criados: [],
        falhas: [],
      },
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios/serie',
      payload: { ...BASE_SERIE_BODY, colaborador_id: 8 },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toEqual({
      error: 'serie_recovery_necessaria',
      serie_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(createEvent).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('interrompe a série no primeiro timeout e mantém as próximas ocorrências planejadas', async () => {
    const createEvent = vi.fn().mockRejectedValueOnce(new Error('network timeout'));
    getGcalsForSlot.mockResolvedValueOnce([
      {
        colaboradorId: 8,
        nome: 'Outro',
        calendarId: 'cal-8',
        client: { createEvent },
        servicos: [],
      },
    ]);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios/serie',
      payload: { ...BASE_SERIE_BODY, colaborador_id: 8 },
    });

    expect(res.statusCode).toBe(207);
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(agendaOperationClaimDispatch).toHaveBeenCalledTimes(1);
    expect(durablePlan[1]?.status).toBe('planned');
    await app.close();
  });

  it('recovery consulta evento determinístico e só reenvia após 404 confirmado', async () => {
    const eventId = 'bloqopaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
    const getEvent = vi.fn().mockRejectedValue(new Error('HTTP 404'));
    const createEvent = vi.fn().mockResolvedValue({ id: eventId });
    getGcalsForSlot.mockResolvedValueOnce([
      {
        colaboradorId: 8,
        nome: 'Outro',
        calendarId: 'cal-8',
        client: { getEvent, createEvent },
        servicos: [],
      },
    ]);
    agendaOperationGet.mockResolvedValueOnce({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'recovery_required',
      actor_role: 'owner',
      actor_user_id: 22,
      actor_colaborador_id: null,
      timezone: 'America/Sao_Paulo',
      tipo: 'almoco',
      motivo: 'intervalo',
      response_status: 207,
      response_body: null,
    });
    agendaOperationList.mockResolvedValueOnce([
      {
        operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        ordinal: 1,
        inicio_at: '2026-08-21T15:00:00.000Z',
        fim_at: '2026-08-21T16:00:00.000Z',
        bloqueio_id: '11111111-1111-4111-8111-111111111111',
        gcal_event_id: eventId,
        status: 'recovery_required',
        error_code: 'gcal_ambiguous',
      },
    ]);
    agendaOperationClaimRecovery.mockResolvedValueOnce({
      operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ordinal: 1,
      inicio_at: '2026-08-21T15:00:00.000Z',
      fim_at: '2026-08-21T16:00:00.000Z',
      bloqueio_id: '11111111-1111-4111-8111-111111111111',
      gcal_event_id: eventId,
      status: 'gcal_dispatch_started',
      error_code: 'gcal_ambiguous',
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios/serie/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/recovery',
      payload: { colaborador_id: 8 },
    });

    expect(res.statusCode).toBe(201);
    expect(getEvent).toHaveBeenCalledTimes(2);
    expect(getEvent).toHaveBeenCalledWith(eventId);
    expect(agendaCreate.mock.invocationCallOrder[0]).toBeLessThan(
      createEvent.mock.invocationCallOrder[0],
    );
    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({ eventId }));
    expect(agendaOperationMarkOccurrence).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', ordinal: 1 }),
    );
    await app.close();
  });

  it('não chama o GCal quando a reconstrução local da recovery falha', async () => {
    const eventId = 'bloqopaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
    const getEvent = vi.fn().mockRejectedValue(new Error('HTTP 404'));
    const createEvent = vi.fn().mockResolvedValue({ id: eventId });
    getGcalsForSlot.mockResolvedValueOnce([
      {
        colaboradorId: 8,
        nome: 'Outro',
        calendarId: 'cal-8',
        client: { getEvent, createEvent },
        servicos: [],
      },
    ]);
    agendaOperationGet.mockResolvedValueOnce({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'recovery_required',
      actor_role: 'owner',
      actor_user_id: 22,
      actor_colaborador_id: null,
      timezone: 'America/Sao_Paulo',
      tipo: 'almoco',
      motivo: 'intervalo',
      response_status: 207,
      response_body: null,
    });
    const occurrence = {
      operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ordinal: 1,
      inicio_at: '2026-08-21T15:00:00.000Z',
      fim_at: '2026-08-21T16:00:00.000Z',
      bloqueio_id: '11111111-1111-4111-8111-111111111111',
      gcal_event_id: eventId,
      status: 'recovery_required' as const,
      error_code: 'gcal_ambiguous',
    };
    agendaOperationList.mockResolvedValueOnce([occurrence]);
    agendaOperationClaimRecovery.mockResolvedValueOnce({
      ...occurrence,
      status: 'gcal_dispatch_started',
    });
    agendaCreate.mockRejectedValueOnce(new Error('db unavailable'));
    agendaGetForRecovery.mockResolvedValueOnce(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios/serie/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/recovery',
      payload: { colaborador_id: 8 },
    });

    expect(res.statusCode).toBe(207);
    expect(getEvent).toHaveBeenCalledTimes(2);
    expect(createEvent).not.toHaveBeenCalled();
    expect(agendaOperationMarkOccurrence).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'recovery_required', errorCode: 'local_write_failed' }),
    );
    await app.close();
  });

  it('só processa a próxima ocorrência após reconciliar a anterior na recovery', async () => {
    const firstEventId = 'bloqopaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
    const secondEventId = 'bloqopaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2';
    const getEvent = vi.fn().mockResolvedValue({ id: firstEventId });
    const createEvent = vi.fn().mockResolvedValue({ id: secondEventId });
    getGcalsForSlot.mockResolvedValueOnce([
      {
        colaboradorId: 8,
        nome: 'Outro',
        calendarId: 'cal-8',
        client: { getEvent, createEvent },
        servicos: [],
      },
    ]);
    agendaOperationGet.mockResolvedValueOnce({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'recovery_required',
      actor_role: 'owner',
      actor_user_id: 22,
      actor_colaborador_id: null,
      timezone: 'America/Sao_Paulo',
      tipo: 'almoco',
      motivo: 'intervalo',
      response_status: 207,
      response_body: null,
    });
    const first = {
      operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ordinal: 1,
      inicio_at: '2026-08-21T15:00:00.000Z',
      fim_at: '2026-08-21T16:00:00.000Z',
      bloqueio_id: '11111111-1111-4111-8111-111111111111',
      gcal_event_id: firstEventId,
      status: 'recovery_required' as const,
      error_code: 'gcal_ambiguous',
    };
    const second = {
      ...first,
      ordinal: 2,
      bloqueio_id: '22222222-2222-4222-8222-222222222222',
      gcal_event_id: secondEventId,
      inicio_at: '2026-08-28T15:00:00.000Z',
      fim_at: '2026-08-28T16:00:00.000Z',
      status: 'planned' as const,
      error_code: null,
    };
    agendaOperationList.mockResolvedValueOnce([first, second]);
    agendaOperationClaimRecovery.mockResolvedValueOnce({
      ...first,
      status: 'gcal_dispatch_started',
    });
    agendaOperationClaimDispatch.mockResolvedValueOnce({
      ...second,
      status: 'gcal_dispatch_started',
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios/serie/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/recovery',
      payload: { colaborador_id: 8 },
    });

    expect(res.statusCode).toBe(201);
    expect(getEvent.mock.invocationCallOrder[0]).toBeLessThan(
      createEvent.mock.invocationCallOrder[0],
    );
    expect(agendaOperationClaimDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ ordinal: 2 }),
    );
    await app.close();
  });

  it('recovery concorrente reivindica a ocorrência antes de consultar ou postar no GCal', async () => {
    const eventId = 'bloqopaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
    const getEvent = vi.fn().mockRejectedValue(new Error('HTTP 404'));
    const createEvent = vi.fn().mockResolvedValue({ id: eventId });
    getGcalsForSlot.mockResolvedValue([
      {
        colaboradorId: 8,
        nome: 'Outro',
        calendarId: 'cal-8',
        client: { getEvent, createEvent },
        servicos: [],
      },
    ]);
    const occurrence = {
      operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ordinal: 1,
      inicio_at: '2026-08-21T15:00:00.000Z',
      fim_at: '2026-08-21T16:00:00.000Z',
      bloqueio_id: '11111111-1111-4111-8111-111111111111',
      gcal_event_id: eventId,
      status: 'recovery_required' as const,
      error_code: 'gcal_ambiguous',
    };
    durablePlan = [occurrence];
    agendaOperationGet.mockResolvedValue({
      id: occurrence.operation_id,
      status: 'recovery_required',
      actor_role: 'owner',
      actor_user_id: 22,
      actor_colaborador_id: null,
      timezone: 'America/Sao_Paulo',
      tipo: 'almoco',
      motivo: 'intervalo',
      response_status: 207,
      response_body: null,
    });
    agendaOperationList.mockImplementation(async () => durablePlan);
    agendaOperationMarkOccurrence.mockImplementation(
      async (input: { ordinal: number; status: 'active' | 'recovery_required' }) => {
        const current = durablePlan.find((candidate) => candidate.ordinal === input.ordinal);
        if (current) current.status = input.status;
        return Boolean(current);
      },
    );
    const app = await buildApp();
    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/portal/agenda/bloqueios/serie/${occurrence.operation_id}/recovery`,
        payload: { colaborador_id: 8 },
      }),
      app.inject({
        method: 'POST',
        url: `/portal/agenda/bloqueios/serie/${occurrence.operation_id}/recovery`,
        payload: { colaborador_id: 8 },
      }),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(agendaOperationMarkOccurrence).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', expectedStatus: 'gcal_dispatch_started' }),
    );
    expect(durablePlan[0]?.status).toBe('active');
    await app.close();
  });

  it('recusa recovery de serie_id legada sem chamar o GCal', async () => {
    agendaOperationGet.mockResolvedValueOnce(null);
    agendaHasSerieForRecovery.mockResolvedValueOnce(true);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agenda/bloqueios/serie/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/recovery',
      payload: { colaborador_id: 8 },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'serie_legada_sem_recovery',
      serie_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(getGcalsForSlot).not.toHaveBeenCalled();
    await app.close();
  });
});
