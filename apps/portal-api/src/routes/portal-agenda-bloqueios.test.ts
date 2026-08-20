import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  configMock,
  agendaCreate,
  agendaAttach,
  agendaMarkFailed,
  agendaMarkCleanupFailed,
  agendaList,
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
    gcal_event_id: 'gcal-block-1',
    status: 'active',
  });
  agendaList.mockResolvedValue([]);
  agendaGetActive.mockResolvedValue(null);
  agendaSoftDelete.mockResolvedValue(null);
  getGcalForSlot.mockResolvedValue({
    createEvent: vi.fn().mockResolvedValue({ id: 'gcal-block-single' }),
    deleteEvent: vi.fn().mockResolvedValue(undefined),
  });
  getGcalsForSlot.mockResolvedValue([
    {
      colaboradorId: 7,
      nome: 'Bene',
      calendarId: 'cal-7',
      client: {
        createEvent: vi.fn().mockResolvedValue({ id: 'gcal-block-7' }),
        deleteEvent: vi.fn().mockResolvedValue(undefined),
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
