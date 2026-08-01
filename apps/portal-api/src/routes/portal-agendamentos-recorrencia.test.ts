/**
 * Testes de POST /portal/agendamentos/recorrencia/preview e POST /portal/agendamentos/serie
 * (SCRUM — agenda recorrente). DB e GCal MOCKADOS, mesmo padrão de
 * portal-agendamentos.test.ts (arquivo dedicado para não inchar ainda mais o arquivo
 * principal, que já tem quase 1900 linhas).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { estabelecimentoConfig } = vi.hoisted(() => ({
  estabelecimentoConfig: { ESTABELECIMENTO_ENABLED: false, ATEND_FROM_AGENDA_SLOTS: '' },
}));
vi.mock('../config.js', () => ({
  config: {
    NODE_ENV: 'test',
    REDIS_HOST: 'localhost',
    REDIS_PORT: 6379,
    REDIS_PASSWORD: '',
    get ESTABELECIMENTO_ENABLED() {
      return estabelecimentoConfig.ESTABELECIMENTO_ENABLED;
    },
    get ATEND_FROM_AGENDA_SLOTS() {
      return estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS;
    },
  },
}));

const { logSpies } = vi.hoisted(() => ({
  logSpies: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@startap/core/logger', () => ({
  logger: { child: () => logSpies },
}));

const {
  getScopeBySlotMock,
  upsertAtendimentoFromEventMock,
  syncAtendimentoFromEventMock,
  softDeleteAtendimentoByEventMock,
  isAwaitingAgendaConnectionMock,
  csvGateMock,
} = vi.hoisted(() => ({
  getScopeBySlotMock: vi.fn(),
  upsertAtendimentoFromEventMock: vi.fn(),
  syncAtendimentoFromEventMock: vi.fn(),
  softDeleteAtendimentoByEventMock: vi.fn(),
  isAwaitingAgendaConnectionMock: vi.fn(),
  csvGateMock: (slot: string, csv?: string | null): boolean => {
    if (!csv) return false;
    const e = csv
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return e.includes('*') || e.includes(slot);
  },
}));
vi.mock('@startap/db', () => ({
  flowClones: {
    getCloneBySlot: vi.fn(),
    resolveAtendFromAgendaEnabledForSlot: (slot: string, csv?: string | null) =>
      csvGateMock(slot, csv),
    isAwaitingAgendaConnection: (...a: unknown[]) => isAwaitingAgendaConnectionMock(...a),
  },
  query: vi.fn(),
  portalUsers: { getSlotForActivePortalUser: vi.fn() },
  cloneColaboradores: { getScopeBySlot: (...a: unknown[]) => getScopeBySlotMock(...a) },
  atendimentos: {
    upsertAtendimentoFromEvent: (...a: unknown[]) => upsertAtendimentoFromEventMock(...a),
    syncAtendimentoFromEvent: (...a: unknown[]) => syncAtendimentoFromEventMock(...a),
    softDeleteAtendimentoByEvent: (...a: unknown[]) => softDeleteAtendimentoByEventMock(...a),
  },
}));

const { getGcalForSlotMock, getGcalsForSlotMock, invalidateGcalCacheMock } = vi.hoisted(() => ({
  getGcalForSlotMock: vi.fn(),
  getGcalsForSlotMock: vi.fn(),
  invalidateGcalCacheMock: vi.fn(),
}));
vi.mock('@startap/integrations', () => ({
  gcal: {
    getGcalForSlot: (...a: unknown[]) => getGcalForSlotMock(...a),
    getGcalsForSlot: (...a: unknown[]) => getGcalsForSlotMock(...a),
    invalidateGcalCache: (...a: unknown[]) => invalidateGcalCacheMock(...a),
  },
}));

const { loadScheduleConfigMock } = vi.hoisted(() => ({ loadScheduleConfigMock: vi.fn() }));
vi.mock('@startap/integrations/scheduling', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@startap/integrations/scheduling')>();
  return { ...actual, loadScheduleConfig: (...a: unknown[]) => loadScheduleConfigMock(...a) };
});

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

import { nowPartsInTz } from '@startap/integrations/scheduling';
import Fastify, { type FastifyInstance } from 'fastify';
import { portalAgendamentosRoutes } from './portal-agendamentos.js';

const WORK_ABERTO_TODOS: Record<number, [number, number] | null> = {
  0: [9 * 60, 19 * 60],
  1: [9 * 60, 19 * 60],
  2: [9 * 60, 19 * 60],
  3: [9 * 60, 19 * 60],
  4: [9 * 60, 19 * 60],
  5: [9 * 60, 19 * 60],
  6: [9 * 60, 19 * 60],
};

const CONFIG_OK = {
  work: WORK_ABERTO_TODOS,
  services: [{ name: 'Corte', min: 30 }],
  source: 'flow_clones' as const,
  timezone: 'America/Sao_Paulo',
};

// Quarta-feira daqui a 3 dias — sempre no futuro em relação ao "now" real do teste.
const FUTURO = nowPartsInTz(new Date(Date.now() + 10 * 86_400_000)).dateKey;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalAgendamentosRoutes);
  await app.ready();
  return app;
}

function gcalClientLivre() {
  let seq = 0;
  return {
    listEvents: vi.fn().mockResolvedValue([]),
    createEvent: vi.fn().mockImplementation((opts: { summary: string }) => {
      seq += 1;
      return Promise.resolve({
        id: `evt_serie_${seq}`,
        summary: opts.summary,
        start: { dateTime: `${FUTURO}T10:00:00-03:00` },
        end: { dateTime: `${FUTURO}T10:30:00-03:00` },
      });
    }),
  };
}

const PREVIEW_PAYLOAD_OK = {
  servico: 'Corte',
  data: FUTURO,
  hora: '10:00',
  cliente_nome: 'João Pedro',
  cliente_telefone: '+55 (11) 99999-8888',
  periodicidade: 'semanal',
  ocorrencias: 4,
};

beforeEach(() => {
  vi.clearAllMocks();
  loadScheduleConfigMock.mockResolvedValue(CONFIG_OK);
  estabelecimentoConfig.ESTABELECIMENTO_ENABLED = false;
  estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS = '';
  getScopeBySlotMock.mockResolvedValue({
    product_type: 'individual',
    seat_cap: null,
    tenant_id: null,
  });
  upsertAtendimentoFromEventMock.mockResolvedValue({ id: 101, dirty_fields: [] });
  syncAtendimentoFromEventMock.mockResolvedValue({ id: 101, dirty_fields: [] });
  softDeleteAtendimentoByEventMock.mockResolvedValue({ id: 101, dirty_fields: [] });
  isAwaitingAgendaConnectionMock.mockResolvedValue(false);
});

// ════════════════════════════════════════════════════════════════════════════
// POST /portal/agendamentos/recorrencia/preview
// ════════════════════════════════════════════════════════════════════════════
describe('POST /portal/agendamentos/recorrencia/preview', () => {
  it('200: NÃO grava nada — só lê (createEvent nunca chamado)', async () => {
    const client = gcalClientLivre();
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos/recorrencia/preview',
      payload: PREVIEW_PAYLOAD_OK,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.previews).toHaveLength(4);
    for (const p of body.previews) {
      expect(p.status).toBe('livre');
    }
    expect(client.createEvent).not.toHaveBeenCalled();
    await app.close();
  });

  it('200: marca ocorrência como ocupado quando bate com evento existente', async () => {
    // Avaliação é SEQUENCIAL (1 listEvents por ocorrência, na ordem) — a 2a chamada
    // (2a ocorrencia semanal) devolve conflito; as demais, livre.
    let chamada = 0;
    const client = {
      listEvents: vi.fn().mockImplementation((opts: { timeMin: string; timeMax: string }) => {
        chamada += 1;
        if (chamada !== 2) return Promise.resolve([]);
        return Promise.resolve([
          {
            id: 'evt_conflito',
            summary: 'Outro cliente',
            start: { dateTime: opts.timeMin },
            end: { dateTime: opts.timeMax },
          },
        ]);
      }),
      createEvent: vi.fn(),
    };
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos/recorrencia/preview',
      payload: PREVIEW_PAYLOAD_OK,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.previews[0].status).toBe('livre');
    expect(body.previews[1].status).toBe('ocupado');
    expect(body.previews[1].conflito).toBeDefined();
    await app.close();
  });

  it('400: ocorrencias fora do cap [2,24]', async () => {
    getGcalForSlotMock.mockResolvedValue(gcalClientLivre());
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos/recorrencia/preview',
      payload: { ...PREVIEW_PAYLOAD_OK, ocorrencias: 25 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400: periodicidade fora do enum', async () => {
    getGcalForSlotMock.mockResolvedValue(gcalClientLivre());
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos/recorrencia/preview',
      payload: { ...PREVIEW_PAYLOAD_OK, periodicidade: 'diaria' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('422: gcal_nao_configurado quando o clone não tem agenda', async () => {
    getGcalForSlotMock.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos/recorrencia/preview',
      payload: PREVIEW_PAYLOAD_OK,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('gcal_nao_configurado');
    await app.close();
  });

  it('sequencial: listEvents chamado em série, não em paralelo (proteção rate-limit)', async () => {
    const chamadas: number[] = [];
    let emVoo = 0;
    const client = {
      listEvents: vi.fn().mockImplementation(async () => {
        emVoo += 1;
        chamadas.push(emVoo);
        await new Promise((r) => setTimeout(r, 1));
        emVoo -= 1;
        return [];
      }),
      createEvent: vi.fn(),
    };
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/portal/agendamentos/recorrencia/preview',
      payload: PREVIEW_PAYLOAD_OK,
    });

    // Nunca mais de 1 chamada "em voo" simultaneamente.
    expect(Math.max(...chamadas)).toBe(1);
    await app.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /portal/agendamentos/serie
// ════════════════════════════════════════════════════════════════════════════
const SERIE_PAYLOAD_OK = {
  servico: 'Corte',
  cliente_nome: 'João Pedro',
  cliente_telefone: '+55 (11) 99999-8888',
  datas: [
    { data: FUTURO, hora: '10:00' },
    { data: FUTURO, hora: '11:00' },
    { data: FUTURO, hora: '12:00' },
  ],
};

describe('POST /portal/agendamentos/serie — grava exatamente o confirmado', () => {
  it('201: cria todas as ocorrências quando não há falha, um evento GCal por data', async () => {
    const client = gcalClientLivre();
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos/serie',
      payload: SERIE_PAYLOAD_OK,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.criados).toHaveLength(3);
    expect(body.falhas).toHaveLength(0);
    expect(body.serie_id).toBeTruthy();
    expect(client.createEvent).toHaveBeenCalledTimes(3);
    // Cada createEvent carrega o MESMO serieId em extendedProperties.private.
    for (const call of client.createEvent.mock.calls) {
      expect(call[0].extendedPropertiesPrivate).toEqual({ serieId: body.serie_id });
    }
    await app.close();
  });

  it('NÃO recalcula periodicidade — grava exatamente as datas do body (nenhuma chamada extra)', async () => {
    const client = gcalClientLivre();
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/portal/agendamentos/serie',
      payload: SERIE_PAYLOAD_OK,
    });

    const horasChamadas = client.createEvent.mock.calls.map(
      (c: unknown[]) => (c[0] as { startISO: string }).startISO,
    );
    expect(horasChamadas).toHaveLength(3);
    // 3 horas DIFERENTES no mesmo dia — não é um padrão de periodicidade recalculado.
    expect(new Set(horasChamadas).size).toBe(3);
    await app.close();
  });

  it('207: parcial quando uma ocorrência falha (conflito/erro) mas outras vingam — SEM rollback', async () => {
    const client = {
      listEvents: vi.fn().mockResolvedValue([]),
      createEvent: vi
        .fn()
        .mockResolvedValueOnce({
          id: 'evt_1',
          summary: 'x',
          start: { dateTime: `${FUTURO}T10:00:00-03:00` },
          end: { dateTime: `${FUTURO}T10:30:00-03:00` },
        })
        .mockRejectedValueOnce(new Error('GCal /events -> HTTP 500: backend error'))
        .mockResolvedValueOnce({
          id: 'evt_3',
          summary: 'x',
          start: { dateTime: `${FUTURO}T12:00:00-03:00` },
          end: { dateTime: `${FUTURO}T12:30:00-03:00` },
        }),
    };
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos/serie',
      payload: SERIE_PAYLOAD_OK,
    });

    expect(res.statusCode).toBe(207);
    const body = res.json();
    expect(body.criados).toHaveLength(2);
    expect(body.falhas).toHaveLength(1);
    // NUNCA desfaz o que já foi criado: 3 tentativas, nenhum deleteEvent.
    expect(client.createEvent).toHaveBeenCalledTimes(3);
    await app.close();
  });

  it('409: nenhuma ocorrência criada (todas falham)', async () => {
    const client = {
      listEvents: vi.fn().mockResolvedValue([]),
      createEvent: vi.fn().mockRejectedValue(new Error('GCal /events -> HTTP 500: backend error')),
    };
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos/serie',
      payload: SERIE_PAYLOAD_OK,
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.criados).toHaveLength(0);
    expect(body.falhas).toHaveLength(3);
    await app.close();
  });

  it('circuit-break: 403 rate-limit PARA o lote imediatamente (não tenta as próximas)', async () => {
    const client = {
      listEvents: vi.fn().mockResolvedValue([]),
      createEvent: vi
        .fn()
        .mockResolvedValueOnce({
          id: 'evt_1',
          summary: 'x',
          start: { dateTime: `${FUTURO}T10:00:00-03:00` },
          end: { dateTime: `${FUTURO}T10:30:00-03:00` },
        })
        .mockRejectedValueOnce(
          new Error(
            'GCal /events -> HTTP 403: {"error":{"errors":[{"reason":"rateLimitExceeded"}]}}',
          ),
        ),
    };
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos/serie',
      payload: SERIE_PAYLOAD_OK,
    });

    expect(res.statusCode).toBe(207);
    const body = res.json();
    expect(body.criados).toHaveLength(1);
    expect(body.falhas).toHaveLength(1);
    expect(body.falhas[0].error).toBe('rate_limit');
    // PAROU no 2º — nunca tentou a 3ª ocorrência.
    expect(client.createEvent).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('rate-limit NÃO invalida o cache de agenda (regra de negócio 20)', async () => {
    const client = {
      listEvents: vi.fn().mockResolvedValue([]),
      createEvent: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'GCal /events -> HTTP 403: {"error":{"errors":[{"reason":"rateLimitExceeded"}]}}',
          ),
        ),
    };
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/portal/agendamentos/serie',
      payload: SERIE_PAYLOAD_OK,
    });

    expect(invalidateGcalCacheMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('403 forbidden real (não rate-limit) invalida o cache', async () => {
    const client = {
      listEvents: vi.fn().mockResolvedValue([]),
      createEvent: vi
        .fn()
        .mockRejectedValue(
          new Error('GCal /events -> HTTP 403: {"error":{"errors":[{"reason":"forbidden"}]}}'),
        ),
    };
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/portal/agendamentos/serie',
      payload: SERIE_PAYLOAD_OK,
    });

    expect(invalidateGcalCacheMock).toHaveBeenCalledWith(injectedSlot);
    await app.close();
  });

  it('400: menos de 2 datas é rejeitado pelo schema', async () => {
    getGcalForSlotMock.mockResolvedValue(gcalClientLivre());
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos/serie',
      payload: { ...SERIE_PAYLOAD_OK, datas: [{ data: FUTURO, hora: '10:00' }] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400: mais de 24 datas é rejeitado pelo schema', async () => {
    getGcalForSlotMock.mockResolvedValue(gcalClientLivre());
    const app = await buildApp();
    const muitas = Array.from({ length: 25 }, (_, i) => ({
      data: FUTURO,
      hora: `${String(8 + (i % 10)).padStart(2, '0')}:00`,
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos/serie',
      payload: { ...SERIE_PAYLOAD_OK, datas: muitas },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('gancho de billing (ATEND_FROM_AGENDA_SLOTS ON): upsert chamado por ocorrência criada', async () => {
    estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS = '*';
    getScopeBySlotMock.mockResolvedValue({
      product_type: 'individual',
      seat_cap: null,
      tenant_id: 'tenant-1',
      timezone: 'America/Sao_Paulo',
    });
    const client = gcalClientLivre();
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos/serie',
      payload: SERIE_PAYLOAD_OK,
    });

    expect(res.statusCode).toBe(201);
    expect(upsertAtendimentoFromEventMock).toHaveBeenCalledTimes(3);
    await app.close();
  });

  it('422: gcal_nao_configurado quando o clone não tem agenda', async () => {
    getGcalForSlotMock.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos/serie',
      payload: SERIE_PAYLOAD_OK,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('gcal_nao_configurado');
    await app.close();
  });

  it('anti-IDOR (estabelecimento): colaborador fora do tenant -> 404, nada criado', async () => {
    estabelecimentoConfig.ESTABELECIMENTO_ENABLED = true;
    getScopeBySlotMock.mockResolvedValue({
      product_type: 'estabelecimento',
      seat_cap: 3,
      tenant_id: 'tenant-1',
    });
    getGcalsForSlotMock.mockResolvedValue([
      { colaboradorId: 1, nome: 'Ana', client: gcalClientLivre() },
    ]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos/serie',
      payload: { ...SERIE_PAYLOAD_OK, colaborador_id: 999 },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('colaborador_nao_encontrado');
    await app.close();
  });
});
