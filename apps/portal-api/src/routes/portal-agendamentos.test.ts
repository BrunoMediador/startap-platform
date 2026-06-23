/**
 * Testes do POST /portal/agendamentos (Missão 020 F4 — agendamento manual).
 *
 * DB e GCal MOCKADOS. Foco: caminho feliz (evento criado com o MESMO formato
 * de título do bot), 409 estruturado em conflito (anti-corrida), validação de
 * payload e invariante anti-IDOR (slot SEMPRE da sessão).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// config.js valida process.env no import (cadeia tenant.js -> session.js) — mockamos.
// estabelecimentoConfig é mutável: cada teste de estabelecimento liga a flag.
const { estabelecimentoConfig } = vi.hoisted(() => ({
  estabelecimentoConfig: { ESTABELECIMENTO_ENABLED: false },
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
  },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { getScopeBySlotMock } = vi.hoisted(() => ({ getScopeBySlotMock: vi.fn() }));
vi.mock('@startap/db', () => ({
  flowClones: { getCloneBySlot: vi.fn() },
  query: vi.fn(),
  portalUsers: { getSlotForActivePortalUser: vi.fn() },
  cloneColaboradores: { getScopeBySlot: (...a: unknown[]) => getScopeBySlotMock(...a) },
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

// O mock acima só troca loadScheduleConfig — estas helpers são as REAIS.
import { nowPartsInTz, zonedWallTimeToUtc } from '@startap/integrations/scheduling';
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
  services: [
    { name: 'Corte', min: 30 },
    { name: 'Corte + barba', min: 45 },
  ],
  source: 'flow_clones' as const,
};

const FUTURO = nowPartsInTz(new Date(Date.now() + 3 * 86_400_000)).dateKey;
const PASSADO = nowPartsInTz(new Date(Date.now() - 2 * 86_400_000)).dateKey;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalAgendamentosRoutes);
  await app.ready();
  return app;
}

function gcalClientLivre() {
  return {
    listEvents: vi.fn().mockResolvedValue([]),
    createEvent: vi.fn().mockImplementation((opts: { summary: string }) =>
      Promise.resolve({
        id: 'evt_novo',
        summary: opts.summary,
        start: { dateTime: `${FUTURO}T10:00:00-03:00` },
        end: { dateTime: `${FUTURO}T10:30:00-03:00` },
      }),
    ),
  };
}

const PAYLOAD_OK = {
  servico: 'Corte',
  data: FUTURO,
  hora: '10:00',
  cliente_nome: 'João Pedro',
  cliente_telefone: '+55 (11) 99999-8888',
};

beforeEach(() => {
  vi.clearAllMocks();
  loadScheduleConfigMock.mockResolvedValue(CONFIG_OK);
  // Default: flag OFF + clone individual — caminho INDIVIDUAL (como hoje).
  estabelecimentoConfig.ESTABELECIMENTO_ENABLED = false;
  getScopeBySlotMock.mockResolvedValue({
    product_type: 'individual',
    seat_cap: null,
    tenant_id: null,
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /portal/agendamentos — INDIVIDUAL (single-agenda, inalterado)
// ════════════════════════════════════════════════════════════════════════════
describe('GET /portal/agendamentos — individual (single-agenda)', () => {
  it('200: lista os eventos da agenda única, SEM marcar profissional', async () => {
    const client = {
      listEvents: vi.fn().mockResolvedValue([
        {
          id: 'evt_1',
          summary: 'João - Corte | WhatsApp: 5511999998888',
          start: { dateTime: `${FUTURO}T10:00:00-03:00` },
          end: { dateTime: `${FUTURO}T10:30:00-03:00` },
        },
      ]),
    };
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/agendamentos' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gcal_configured).toBe(true);
    expect(body.agendamentos).toHaveLength(1);
    // INDIVIDUAL: nenhum campo de profissional no DTO.
    expect(body.agendamentos[0].colaborador_id).toBeUndefined();
    expect(body.agendamentos[0].profissional_nome).toBeUndefined();
    // NÃO entrou no caminho de estabelecimento (flag OFF).
    expect(getGcalsForSlotMock).not.toHaveBeenCalled();
  });

  it('200 gcal_configured:false quando a flag está OFF mesmo sendo estabelecimento (cai no individual)', async () => {
    // Flag OFF → product_type nem é consultado; vai direto pro individual.
    estabelecimentoConfig.ESTABELECIMENTO_ENABLED = false;
    getGcalForSlotMock.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/agendamentos' });

    expect(res.statusCode).toBe(200);
    expect(res.json().gcal_configured).toBe(false);
    expect(getGcalsForSlotMock).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /portal/agendamentos — ESTABELECIMENTO (multi-profissional, agregação)
// ════════════════════════════════════════════════════════════════════════════
describe('GET /portal/agendamentos — estabelecimento (multi-profissional)', () => {
  beforeEach(() => {
    estabelecimentoConfig.ESTABELECIMENTO_ENABLED = true;
    getScopeBySlotMock.mockResolvedValue({
      product_type: 'estabelecimento',
      seat_cap: 5,
      tenant_id: 'tenant-xyz',
    });
  });

  function colab(colaboradorId: number, nome: string, eventos: unknown[]) {
    return {
      colaboradorId,
      nome,
      calendarId: `cal-${colaboradorId}`,
      client: { listEvents: vi.fn().mockResolvedValue(eventos) },
      servicos: [],
    };
  }

  it('200: agrega eventos de TODAS as agendas marcando colaborador_id + profissional_nome', async () => {
    getGcalsForSlotMock.mockResolvedValue([
      colab(1, 'Bené', [
        {
          id: 'evt_a',
          summary: 'João - Corte',
          start: { dateTime: `${FUTURO}T09:00:00-03:00` },
          end: { dateTime: `${FUTURO}T09:30:00-03:00` },
        },
      ]),
      colab(2, 'Caly', [
        {
          id: 'evt_b',
          summary: 'Maria - Barba',
          // MESMO horário do evt_a, profissional diferente (paralelo).
          start: { dateTime: `${FUTURO}T09:00:00-03:00` },
          end: { dateTime: `${FUTURO}T09:20:00-03:00` },
        },
      ]),
    ]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/agendamentos' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gcal_configured).toBe(true);
    expect(body.agendamentos).toHaveLength(2);

    const byId = Object.fromEntries(body.agendamentos.map((a: { id: string }) => [a.id, a]));
    expect(byId.evt_a).toMatchObject({ colaborador_id: 1, profissional_nome: 'Bené' });
    expect(byId.evt_b).toMatchObject({ colaborador_id: 2, profissional_nome: 'Caly' });
    // Não usou o resolvedor single-agenda.
    expect(getGcalForSlotMock).not.toHaveBeenCalled();
  });

  it('200 gcal_configured:false quando NENHUM colaborador tem agenda (pré-setup)', async () => {
    getGcalsForSlotMock.mockResolvedValue([]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/agendamentos' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gcal_configured).toBe(false);
    expect(body.agendamentos).toHaveLength(0);
  });

  it('200: a falha de UMA agenda não derruba as outras (allSettled)', async () => {
    const bom = colab(1, 'Bené', [
      {
        id: 'evt_ok',
        summary: 'João - Corte',
        start: { dateTime: `${FUTURO}T09:00:00-03:00` },
        end: { dateTime: `${FUTURO}T09:30:00-03:00` },
      },
    ]);
    const ruim = {
      colaboradorId: 2,
      nome: 'Caly',
      calendarId: 'cal-2',
      client: { listEvents: vi.fn().mockRejectedValue(new Error('GCal /events -> HTTP 500')) },
      servicos: [],
    };
    getGcalsForSlotMock.mockResolvedValue([bom, ruim]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/agendamentos' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agendamentos).toHaveLength(1);
    expect(body.agendamentos[0]).toMatchObject({ id: 'evt_ok', profissional_nome: 'Bené' });
  });

  it('502 quando TODAS as agendas falham (e havia colaboradores)', async () => {
    const ruim1 = {
      colaboradorId: 1,
      nome: 'Bené',
      calendarId: 'cal-1',
      client: { listEvents: vi.fn().mockRejectedValue(new Error('boom1')) },
      servicos: [],
    };
    const ruim2 = {
      colaboradorId: 2,
      nome: 'Caly',
      calendarId: 'cal-2',
      client: { listEvents: vi.fn().mockRejectedValue(new Error('boom2')) },
      servicos: [],
    };
    getGcalsForSlotMock.mockResolvedValue([ruim1, ruim2]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/agendamentos' });

    expect(res.statusCode).toBe(502);
  });
});

describe('POST /portal/agendamentos — caminho feliz', () => {
  it('201: cria evento no GCal com o formato de título do bot (com telefone)', async () => {
    const client = gcalClientLivre();
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos',
      payload: PAYLOAD_OK,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.agendamento.id).toBe('evt_novo');
    // MESMO formato do bot: "Nome - Servico | WhatsApp: numero" (digitos).
    expect(body.agendamento.titulo).toBe('João Pedro - Corte | WhatsApp: 5511999998888');
    expect(body.agendamento.inicio).toBe(`${FUTURO}T10:00:00-03:00`);

    // Instantes corretos (10:00 BRT) e timezone canônica na criação.
    expect(client.createEvent).toHaveBeenCalledWith({
      summary: 'João Pedro - Corte | WhatsApp: 5511999998888',
      startISO: zonedWallTimeToUtc(FUTURO, 10 * 60).toISOString(),
      endISO: zonedWallTimeToUtc(FUTURO, 10 * 60 + 30).toISOString(),
      timeZone: 'America/Sao_Paulo',
    });
    // Anti-IDOR: GCal resolvido pelo slot da sessão.
    expect(getGcalForSlotMock).toHaveBeenCalledWith(injectedSlot);
    await app.close();
  });

  it('201: telefone ausente/vazio cria título sem sufixo de WhatsApp', async () => {
    const client = gcalClientLivre();
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos',
      payload: { ...PAYLOAD_OK, cliente_telefone: '' },
    });

    expect(res.statusCode).toBe(201);
    expect(client.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'João Pedro - Corte' }),
    );
    await app.close();
  });
});

describe('POST /portal/agendamentos — conflito (409 estruturado)', () => {
  it('409 ocupado: slot tomado entre a grade e o submit — NÃO cria evento', async () => {
    const client = gcalClientLivre();
    client.listEvents.mockResolvedValue([
      {
        id: 'ev_existente',
        summary: 'Outro - Corte | WhatsApp: 5511888880000',
        start: { dateTime: `${FUTURO}T10:00:00-03:00` },
        end: { dateTime: `${FUTURO}T10:30:00-03:00` },
      },
    ]);
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos',
      payload: PAYLOAD_OK,
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe('conflito');
    expect(body.reason).toBe('ocupado');
    // Não vaza título do evento existente — só o intervalo.
    expect(JSON.stringify(body)).not.toContain('Outro');
    expect(client.createEvent).not.toHaveBeenCalled();
    await app.close();
  });

  it('409 horario_passado: data no passado', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos',
      payload: { ...PAYLOAD_OK, data: PASSADO },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('horario_passado');
    expect(getGcalForSlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('409 fora_do_horario: slot fora da janela de funcionamento', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos',
      payload: { ...PAYLOAD_OK, hora: '08:00' }, // abre às 09:00
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('fora_do_horario');
    await app.close();
  });
});

describe('POST /portal/agendamentos — validação e erros', () => {
  it('400: nome do cliente obrigatório', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos',
      payload: { ...PAYLOAD_OK, cliente_nome: '  ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('payload_invalido');
    await app.close();
  });

  it('400: telefone curto demais (quando enviado)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos',
      payload: { ...PAYLOAD_OK, cliente_telefone: '12345' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400: serviço não cadastrado', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos',
      payload: { ...PAYLOAD_OK, servico: 'Luzes' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('servico_nao_encontrado');
    await app.close();
  });

  it('422: horários/serviços não configurados', async () => {
    loadScheduleConfigMock.mockRejectedValue(new Error('Configuração ausente'));
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos',
      payload: PAYLOAD_OK,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('config_ausente');
    await app.close();
  });

  it('422: GCal não configurado no tenant', async () => {
    getGcalForSlotMock.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos',
      payload: PAYLOAD_OK,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('gcal_nao_configurado');
    await app.close();
  });

  it('502: falha do GCal ao criar — e invalida cache em 401/403', async () => {
    const client = gcalClientLivre();
    client.createEvent.mockRejectedValue(new Error('GCal /events -> HTTP 403: forbidden'));
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos',
      payload: PAYLOAD_OK,
    });
    expect(res.statusCode).toBe(502);
    expect(invalidateGcalCacheMock).toHaveBeenCalledWith(injectedSlot);
    await app.close();
  });
});

// ---- DELETE /portal/agendamentos/:eventId (Missão 023 W10 — cancelar) --------
//
// Foco: caminho feliz (apaga só após confirmar pertencimento), guarda anti-IDOR
// (eventId fora da agenda do tenant -> 404, NÃO chama deleteEvent), e que o slot
// usado pra resolver a agenda vem SEMPRE da sessão (isolamento por tenant).

const EVT_DO_TENANT = {
  id: 'evt_do_tenant',
  summary: 'Cliente - Corte | WhatsApp: 5511999990000',
  start: { dateTime: `${FUTURO}T10:00:00-03:00` },
  end: { dateTime: `${FUTURO}T10:30:00-03:00` },
};

/** Client GCal cuja agenda contém apenas os eventos passados. */
function gcalClientComEventos(eventos: Array<{ id: string }>) {
  return {
    listEvents: vi.fn().mockResolvedValue(eventos),
    deleteEvent: vi.fn().mockResolvedValue(undefined),
  };
}

describe('DELETE /portal/agendamentos/:eventId — caminho feliz', () => {
  it('200: apaga o evento do PRÓPRIO tenant após confirmar pertencimento', async () => {
    const client = gcalClientComEventos([EVT_DO_TENANT]);
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/portal/agendamentos/${EVT_DO_TENANT.id}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(client.deleteEvent).toHaveBeenCalledWith(EVT_DO_TENANT.id);
    // Isolamento: a agenda foi resolvida pelo slot da SESSÃO, nunca por input.
    expect(getGcalForSlotMock).toHaveBeenCalledWith(injectedSlot);
    await app.close();
  });

  it('200 idempotente: evento já ausente no GCal (404/410) ainda responde ok', async () => {
    const client = gcalClientComEventos([EVT_DO_TENANT]);
    // Passou a guarda (estava na lista), mas sumiu antes do delete (race).
    client.deleteEvent.mockRejectedValue(new Error('GCal /events/x -> HTTP 410: deleted'));
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/portal/agendamentos/${EVT_DO_TENANT.id}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});

describe('DELETE /portal/agendamentos/:eventId — guarda de pertencimento (anti-IDOR)', () => {
  it('404: eventId que NÃO está na agenda do tenant — NÃO chama deleteEvent', async () => {
    // A agenda do tenant logado só tem EVT_DO_TENANT; o cliente tenta apagar um
    // eventId de OUTRA agenda (que jamais aparece na listagem deste tenant).
    const client = gcalClientComEventos([EVT_DO_TENANT]);
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/portal/agendamentos/evt_de_outro_tenant',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('evento_nao_encontrado');
    // CRÍTICO: nada é apagado quando o evento não pertence ao tenant.
    expect(client.deleteEvent).not.toHaveBeenCalled();
    await app.close();
  });

  it('404: agenda vazia — qualquer eventId é rejeitado sem deletar', async () => {
    const client = gcalClientComEventos([]);
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/portal/agendamentos/${EVT_DO_TENANT.id}`,
    });

    expect(res.statusCode).toBe(404);
    expect(client.deleteEvent).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('DELETE /portal/agendamentos/:eventId — erros', () => {
  it('422: GCal não configurado no tenant', async () => {
    getGcalForSlotMock.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/portal/agendamentos/${EVT_DO_TENANT.id}`,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('gcal_nao_configurado');
    await app.close();
  });

  it('400: eventId com caracteres inválidos', async () => {
    const client = gcalClientComEventos([EVT_DO_TENANT]);
    getGcalForSlotMock.mockResolvedValue(client);
    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/portal/agendamentos/evt%20com%20espaco%21',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('eventId_invalido');
    expect(getGcalForSlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('502: falha do GCal ao listar — e invalida cache em 401/403', async () => {
    const client = gcalClientComEventos([EVT_DO_TENANT]);
    client.listEvents.mockRejectedValue(new Error('GCal /events -> HTTP 403: forbidden'));
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/portal/agendamentos/${EVT_DO_TENANT.id}`,
    });
    expect(res.statusCode).toBe(502);
    expect(invalidateGcalCacheMock).toHaveBeenCalledWith(injectedSlot);
    expect(client.deleteEvent).not.toHaveBeenCalled();
    await app.close();
  });
});

// ---- PATCH /portal/agendamentos/:eventId (editar/remarcar) -------------------
//
// Foco: caminho feliz (remarca via patchEvent no MESMO eventId, sem delete+create),
// guarda anti-IDOR (eventId fora da agenda do tenant -> 404, NÃO chama patchEvent),
// e anti-corrida (409 ignorando o PRÓPRIO evento na nova janela).

/** Evento atual do tenant: 10:00-10:30, serviço Corte (30min) no título do bot. */
function evtAtual(over: Record<string, unknown> = {}) {
  return {
    id: 'evt_atual',
    summary: 'João - Corte | WhatsApp: 5511999990000',
    start: { dateTime: `${FUTURO}T10:00:00-03:00` },
    end: { dateTime: `${FUTURO}T10:30:00-03:00` },
    ...over,
  };
}

/**
 * Client cuja agenda contém `eventos`. listEvents serve TANTO a guarda de
 * pertencimento (-7/+60d) QUANTO o recheck anti-corrida (janela estreita). Por
 * default devolve a mesma lista; pode-se sobrescrever via mockImplementationOnce.
 */
function gcalClientPatch(eventos: Array<{ id: string }>) {
  return {
    listEvents: vi.fn().mockResolvedValue(eventos),
    patchEvent: vi.fn().mockImplementation((eventId: string, fields: { summary?: string }) =>
      Promise.resolve({
        id: eventId,
        summary: fields.summary ?? 'João - Corte | WhatsApp: 5511999990000',
        start: { dateTime: `${FUTURO}T11:00:00-03:00` },
        end: { dateTime: `${FUTURO}T11:30:00-03:00` },
      }),
    ),
  };
}

describe('PATCH /portal/agendamentos/:eventId — caminho feliz', () => {
  it('200: remarca hora via patchEvent no MESMO eventId (não delete+create)', async () => {
    const client = gcalClientPatch([evtAtual()]);
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/agendamentos/evt_atual',
      payload: { hora: '11:00' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.agendamento.id).toBe('evt_atual'); // MESMO eventId preservado
    // patchEvent chamado com a nova janela (11:00 BRT, 30min) e MESMO eventId.
    expect(client.patchEvent).toHaveBeenCalledTimes(1);
    const [eventId, fields] = client.patchEvent.mock.calls[0];
    expect(eventId).toBe('evt_atual');
    expect(fields.startISO).toBe(zonedWallTimeToUtc(FUTURO, 11 * 60).toISOString());
    expect(fields.endISO).toBe(zonedWallTimeToUtc(FUTURO, 11 * 60 + 30).toISOString());
    // Só hora mudou → título NÃO é reescrito (preserva summary atual).
    expect(fields.summary).toBeUndefined();
    expect(getGcalForSlotMock).toHaveBeenCalledWith(injectedSlot);
    await app.close();
  });

  it('200: muda serviço recompõe o título preservando nome e telefone do título atual', async () => {
    const client = gcalClientPatch([evtAtual()]);
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/agendamentos/evt_atual',
      payload: { servico: 'Corte + barba' },
    });

    expect(res.statusCode).toBe(200);
    const [, fields] = client.patchEvent.mock.calls[0];
    // Recompõe: nome+telefone vêm do título atual, serviço é o novo.
    expect(fields.summary).toBe('João - Corte + barba | WhatsApp: 5511999990000');
    // Não mudou data/hora → sem start/end no patch.
    expect(fields.startISO).toBeUndefined();
    await app.close();
  });

  it('400: body sem nenhum campo → payload_invalido', async () => {
    const client = gcalClientPatch([evtAtual()]);
    getGcalForSlotMock.mockResolvedValue(client);
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/agendamentos/evt_atual',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('payload_invalido');
    expect(client.patchEvent).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('PATCH /portal/agendamentos/:eventId — guarda anti-IDOR', () => {
  it('404: eventId fora da agenda do tenant — NÃO chama patchEvent', async () => {
    // Agenda do tenant só tem evt_atual; cliente tenta editar evento de outro tenant.
    const client = gcalClientPatch([evtAtual()]);
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/agendamentos/evt_de_outro_tenant',
      payload: { hora: '11:00' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('evento_nao_encontrado');
    // CRÍTICO: nada é editado quando o evento não pertence ao tenant.
    expect(client.patchEvent).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('PATCH /portal/agendamentos/:eventId — anti-corrida (409)', () => {
  it('409 ocupado: novo horário tomado por OUTRO evento — ignora o próprio', async () => {
    const client = gcalClientPatch([evtAtual()]);
    // 1ª listEvents = guarda de pertencimento (encontra evt_atual).
    // 2ª listEvents = recheck da nova janela: além do PRÓPRIO evento (que deve ser
    // ignorado), há um OUTRO evento ocupando 11:00 → conflito.
    client.listEvents.mockResolvedValueOnce([evtAtual()]).mockResolvedValueOnce([
      evtAtual({
        start: { dateTime: `${FUTURO}T11:00:00-03:00` },
        end: { dateTime: `${FUTURO}T11:30:00-03:00` },
      }),
      {
        id: 'evt_outro',
        summary: 'Maria - Corte | WhatsApp: 5511888880000',
        start: { dateTime: `${FUTURO}T11:00:00-03:00` },
        end: { dateTime: `${FUTURO}T11:30:00-03:00` },
      },
    ]);
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/agendamentos/evt_atual',
      payload: { hora: '11:00' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('conflito');
    expect(res.json().reason).toBe('ocupado');
    expect(client.patchEvent).not.toHaveBeenCalled();
    await app.close();
  });

  it('200: nova janela contém SÓ o próprio evento (auto-overlap ignorado) → remarca', async () => {
    const client = gcalClientPatch([evtAtual()]);
    // 1ª = guarda; 2ª = recheck onde a janela contém apenas o próprio evento
    // (ex.: remarca dentro do mesmo bloco) → NÃO é conflito.
    client.listEvents.mockResolvedValueOnce([evtAtual()]).mockResolvedValueOnce([
      evtAtual({
        start: { dateTime: `${FUTURO}T11:00:00-03:00` },
        end: { dateTime: `${FUTURO}T11:30:00-03:00` },
      }),
    ]);
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/agendamentos/evt_atual',
      payload: { hora: '11:00' },
    });

    expect(res.statusCode).toBe(200);
    expect(client.patchEvent).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('409 fora_do_horario: nova hora fora da janela de funcionamento', async () => {
    const client = gcalClientPatch([evtAtual()]);
    getGcalForSlotMock.mockResolvedValue(client);
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/agendamentos/evt_atual',
      payload: { hora: '08:00' }, // abre 09:00
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('fora_do_horario');
    expect(client.patchEvent).not.toHaveBeenCalled();
    await app.close();
  });
});
