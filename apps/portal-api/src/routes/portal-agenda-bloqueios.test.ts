import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  configMock,
  agendaCreate,
  agendaAttach,
  agendaMarkFailed,
  agendaMarkCleanupFailed,
  agendaList,
  agendaListFutureBySerieId,
  agendaGetActive,
  agendaSoftDelete,
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
  agendaMarkFailed: vi.fn(),
  agendaMarkCleanupFailed: vi.fn(),
  agendaList: vi.fn(),
  agendaListFutureBySerieId: vi.fn(),
  agendaGetActive: vi.fn(),
  agendaSoftDelete: vi.fn(),
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
    markCreateFailed: agendaMarkFailed,
    markCreateCleanupFailed: agendaMarkCleanupFailed,
    list: agendaList,
    listFutureActiveBySerieId: agendaListFutureBySerieId,
    getActiveById: agendaGetActive,
    softDeleteById: agendaSoftDelete,
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
  agendaList.mockResolvedValue([]);
  agendaListFutureBySerieId.mockResolvedValue([]);
  agendaGetActive.mockResolvedValue(null);
  agendaSoftDelete.mockResolvedValue(null);
  getGcalForSlot.mockResolvedValue({
    createEvent: vi.fn().mockResolvedValue({ id: 'gcal-block-single' }),
    deleteEvent: vi.fn().mockResolvedValue(undefined),
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
    expect(agendaList).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'clone_owner' }),
    );
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
    expect(body.criados).toHaveLength(2);
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
    expect(createEvent).toHaveBeenCalledTimes(3);
    for (const [index, call] of createEvent.mock.calls.entries()) {
      const bloqueioId = agendaCreate.mock.calls[index]?.[0]?.id;
      expect(call[0]).toEqual(
        expect.objectContaining({
          eventId: `bloq${String(bloqueioId).replaceAll('-', '')}`,
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
      expect.objectContaining({ startISO: '2026-08-21T15:00:00.000Z', endISO: '2026-08-21T16:00:00.000Z' }),
    );
    expect(createEvent.mock.calls[1][0]).toEqual(
      expect.objectContaining({ startISO: '2026-08-28T15:00:00.000Z', endISO: '2026-08-28T16:00:00.000Z' }),
    );
    expect(createEvent.mock.calls[2][0]).toEqual(
      expect.objectContaining({ startISO: '2026-09-04T15:00:00.000Z', endISO: '2026-09-04T16:00:00.000Z' }),
    );
    expect(agendaMarkFailed).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      'clone_owner',
      agendaCreate.mock.calls[1][0].id,
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
      expect.objectContaining({ startISO: '2026-08-21T15:00:00.000Z', endISO: '2026-08-21T16:00:00.000Z' }),
    );
    expect(createEvent.mock.calls[1][0]).toEqual(
      expect.objectContaining({ startISO: '2026-08-22T15:00:00.000Z', endISO: '2026-08-22T16:00:00.000Z' }),
    );
    expect(createEvent.mock.calls[2][0]).toEqual(
      expect.objectContaining({ startISO: '2026-08-23T15:00:00.000Z', endISO: '2026-08-23T16:00:00.000Z' }),
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
