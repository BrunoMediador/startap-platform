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
// ATEND_FROM_AGENDA_SLOTS também é mutável: default '' (gancho de billing OFF pra todos).
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

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const {
  getScopeBySlotMock,
  upsertAtendimentoFromEventMock,
  syncAtendimentoFromEventMock,
  softDeleteAtendimentoByEventMock,
  csvGateMock,
} = vi.hoisted(() => ({
  getScopeBySlotMock: vi.fn(),
  upsertAtendimentoFromEventMock: vi.fn(),
  syncAtendimentoFromEventMock: vi.fn(),
  softDeleteAtendimentoByEventMock: vi.fn(),
  // Resolver env→coluna (ADR 0030 D1) mockado como env-only — os testes exercitam o gate por env
  // (estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS); byte-idêntico ao gate de antes.
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
  timezone: 'America/Sao_Paulo',
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
  // Default: flags OFF + clone individual — caminho INDIVIDUAL (como hoje), gancho de
  // billing derivado DESLIGADO (lista de slots vazia = OFF pra todos, byte-a-byte produção).
  estabelecimentoConfig.ESTABELECIMENTO_ENABLED = false;
  estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS = '';
  getScopeBySlotMock.mockResolvedValue({
    product_type: 'individual',
    seat_cap: null,
    tenant_id: null,
  });
  // Defaults benignos dos helpers de atendimento (só usados quando o slot está na lista).
  upsertAtendimentoFromEventMock.mockResolvedValue({ id: 101, dirty_fields: [] });
  syncAtendimentoFromEventMock.mockResolvedValue({ id: 101, dirty_fields: [] });
  softDeleteAtendimentoByEventMock.mockResolvedValue({ id: 101, dirty_fields: [] });
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

// ════════════════════════════════════════════════════════════════════════════
// POST /portal/agendamentos — ESTABELECIMENTO (multi-profissional)
//
// O clone NÃO tem agenda própria; o evento nasce na agenda de UM colaborador. O POST
// aceita `colaborador_id` no body, resolve a agenda DESSE colaborador via
// getGcalsForSlot (escopado por slot+tenant), cria o evento NELA e carimba o
// colaboradorId no gancho de billing. getGcalForSlot (singular) NÃO é usado neste modo.
// ════════════════════════════════════════════════════════════════════════════

/** Agenda de colaborador cujo client cria/lista eventos (estabelecimento). */
function colabAgendaCriar(colaboradorId: number, nome: string) {
  return {
    colaboradorId,
    nome,
    calendarId: `cal-${colaboradorId}`,
    servicos: [],
    client: {
      listEvents: vi.fn().mockResolvedValue([]),
      createEvent: vi.fn().mockImplementation((opts: { summary: string }) =>
        Promise.resolve({
          id: `evt_${colaboradorId}`,
          summary: opts.summary,
          start: { dateTime: `${FUTURO}T10:00:00-03:00` },
          end: { dateTime: `${FUTURO}T10:30:00-03:00` },
        }),
      ),
    },
  };
}

describe('POST /portal/agendamentos — estabelecimento (multi-profissional)', () => {
  beforeEach(() => {
    estabelecimentoConfig.ESTABELECIMENTO_ENABLED = true;
    getScopeBySlotMock.mockResolvedValue({
      product_type: 'estabelecimento',
      seat_cap: 5,
      tenant_id: 'tenant-xyz',
    });
  });

  it('201: cria o evento na agenda do colaborador escolhido (e SÓ nela)', async () => {
    const bene = colabAgendaCriar(1, 'Bené');
    const caly = colabAgendaCriar(2, 'Caly');
    getGcalsForSlotMock.mockResolvedValue([bene, caly]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos',
      payload: { ...PAYLOAD_OK, colaborador_id: 2 },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.agendamento.id).toBe('evt_2');
    // Eco do colaborador dono pro front renderizar na coluna certa.
    expect(body.agendamento.colaborador_id).toBe(2);
    // Criou na agenda do Caly (id 2); a do Bené não foi tocada.
    expect(caly.client.createEvent).toHaveBeenCalledTimes(1);
    expect(bene.client.createEvent).not.toHaveBeenCalled();
    // Modo estabelecimento: o resolvedor singular NÃO é consultado.
    expect(getGcalForSlotMock).not.toHaveBeenCalled();
    expect(getGcalsForSlotMock).toHaveBeenCalledWith(injectedSlot);
    await app.close();
  });

  it('422 colaborador_obrigatorio: estabelecimento sem colaborador_id no body', async () => {
    const bene = colabAgendaCriar(1, 'Bené');
    getGcalsForSlotMock.mockResolvedValue([bene]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos',
      payload: PAYLOAD_OK, // sem colaborador_id
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('colaborador_obrigatorio');
    expect(bene.client.createEvent).not.toHaveBeenCalled();
    await app.close();
  });

  it('404 anti-IDOR: colaborador_id de outro tenant NÃO está na lista → recusa, sem criar', async () => {
    // getGcalsForSlot já é escopado por slot+tenant: só devolve colaboradores DESTE
    // tenant. Um colaborador_id alheio jamais aparece → recusa (404) sem tocar nada.
    const bene = colabAgendaCriar(1, 'Bené');
    getGcalsForSlotMock.mockResolvedValue([bene]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos',
      payload: { ...PAYLOAD_OK, colaborador_id: 999 },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('colaborador_nao_encontrado');
    expect(bene.client.createEvent).not.toHaveBeenCalled();
    // A resolução foi escopada pelo slot da SESSÃO, nunca por input.
    expect(getGcalsForSlotMock).toHaveBeenCalledWith(injectedSlot);
    await app.close();
  });

  it('422 gcal_nao_configurado: nenhum colaborador com agenda ativa (pré-setup)', async () => {
    getGcalsForSlotMock.mockResolvedValue([]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos',
      payload: { ...PAYLOAD_OK, colaborador_id: 1 },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('gcal_nao_configurado');
    await app.close();
  });

  it('flag ON: gancho de billing nasce com o colaborador escolhido (relatório de comissão)', async () => {
    estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS = injectedSlot;
    const bene = colabAgendaCriar(1, 'Bené');
    const caly = colabAgendaCriar(2, 'Caly');
    getGcalsForSlotMock.mockResolvedValue([bene, caly]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos',
      payload: { ...PAYLOAD_OK, colaborador_id: 1 },
    });

    expect(res.statusCode).toBe(201);
    expect(upsertAtendimentoFromEventMock).toHaveBeenCalledTimes(1);
    const arg = upsertAtendimentoFromEventMock.mock.calls[0][0];
    // A linha de previsão nasce com o colaborador dono do evento (não null).
    expect(arg).toMatchObject({
      slot: injectedSlot,
      tenantId: 'tenant-xyz',
      gcalEventId: 'evt_1',
      colaboradorId: 1,
    });
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
    // MUDANÇA 3 (revalida ao trocar serviço): "Corte+barba" (45min) é mais longo que o "Corte"
    // atual (30min) → recalcula a janela A PARTIR DO MESMO INÍCIO (10:00 BRT) e estende o fim
    // pra 10:45. O start é PRESERVADO; só o end muda. (Sem troca de duração, start/end ficam undefined.)
    expect(fields.startISO).toBe(zonedWallTimeToUtc(FUTURO, 10 * 60).toISOString());
    expect(fields.endISO).toBe(zonedWallTimeToUtc(FUTURO, 10 * 60 + 45).toISOString());
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

// ════════════════════════════════════════════════════════════════════════════
// DELETE/PATCH — ESTABELECIMENTO (multi-profissional)
//
// O clone NÃO tem agenda própria; o evento vive no calendarId de UM colaborador.
// DELETE/PATCH têm que resolver QUAL agenda de colaborador contém o eventId e operar
// NELA — varrendo só agendas DESTE slot/tenant (anti-IDOR). getGcalForSlot (singular)
// NÃO deve ser consultado neste modo.
// ════════════════════════════════════════════════════════════════════════════

/** Agenda de colaborador cujo client contém os eventos passados (com delete+patch). */
function colabAgenda(colaboradorId: number, nome: string, eventos: Array<{ id: string }>) {
  return {
    colaboradorId,
    nome,
    calendarId: `cal-${colaboradorId}`,
    servicos: [],
    client: {
      listEvents: vi.fn().mockResolvedValue(eventos),
      deleteEvent: vi.fn().mockResolvedValue(undefined),
      patchEvent: vi.fn().mockImplementation((eventId: string, fields: { summary?: string }) =>
        Promise.resolve({
          id: eventId,
          summary: fields.summary ?? 'João - Corte | WhatsApp: 5511999990000',
          start: { dateTime: `${FUTURO}T11:00:00-03:00` },
          end: { dateTime: `${FUTURO}T11:30:00-03:00` },
        }),
      ),
    },
  };
}

describe('DELETE /portal/agendamentos/:eventId — estabelecimento', () => {
  beforeEach(() => {
    estabelecimentoConfig.ESTABELECIMENTO_ENABLED = true;
    getScopeBySlotMock.mockResolvedValue({
      product_type: 'estabelecimento',
      seat_cap: 5,
      tenant_id: 'tenant-xyz',
    });
  });

  it('200: acha o evento na agenda do colaborador certo e apaga SÓ nela', async () => {
    // evt_do_bene está na agenda do colaborador 1 (Bené); a do 2 (Caly) está vazia.
    const bene = colabAgenda(1, 'Bené', [EVT_DO_TENANT]);
    const caly = colabAgenda(2, 'Caly', []);
    getGcalsForSlotMock.mockResolvedValue([bene, caly]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/portal/agendamentos/${EVT_DO_TENANT.id}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    // Apagou na agenda do DONO do evento; a do outro colaborador não foi tocada.
    expect(bene.client.deleteEvent).toHaveBeenCalledWith(EVT_DO_TENANT.id);
    expect(caly.client.deleteEvent).not.toHaveBeenCalled();
    // Modo estabelecimento: o resolvedor singular NÃO é usado.
    expect(getGcalForSlotMock).not.toHaveBeenCalled();
    expect(getGcalsForSlotMock).toHaveBeenCalledWith(injectedSlot);
    await app.close();
  });

  it('404: eventId não está em NENHUMA agenda de colaborador — nada é apagado', async () => {
    const bene = colabAgenda(1, 'Bené', [EVT_DO_TENANT]);
    const caly = colabAgenda(2, 'Caly', []);
    getGcalsForSlotMock.mockResolvedValue([bene, caly]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/portal/agendamentos/evt_inexistente',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('evento_nao_encontrado');
    expect(bene.client.deleteEvent).not.toHaveBeenCalled();
    expect(caly.client.deleteEvent).not.toHaveBeenCalled();
    await app.close();
  });

  it('anti-IDOR: só varre as agendas DESTE slot/tenant — evento alheio não aparece, 404', async () => {
    // getGcalsForSlot já é escopado por slot+tenant na integração: só devolve as
    // agendas dos colaboradores deste tenant. Um eventId de outro tenant jamais
    // estará nessas listagens → 404, sem deletar nada.
    const bene = colabAgenda(1, 'Bené', [EVT_DO_TENANT]);
    getGcalsForSlotMock.mockResolvedValue([bene]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/portal/agendamentos/evt_de_outro_tenant',
    });

    expect(res.statusCode).toBe(404);
    expect(bene.client.deleteEvent).not.toHaveBeenCalled();
    // A resolução foi escopada pelo slot da SESSÃO, nunca por input.
    expect(getGcalsForSlotMock).toHaveBeenCalledWith(injectedSlot);
    await app.close();
  });

  it('422: nenhum colaborador com agenda ativa (pré-setup) — gcal_nao_configurado', async () => {
    getGcalsForSlotMock.mockResolvedValue([]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/portal/agendamentos/${EVT_DO_TENANT.id}`,
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('gcal_nao_configurado');
    await app.close();
  });

  it('502: TODAS as agendas de colaboradores falham ao listar', async () => {
    const ruim1 = colabAgenda(1, 'Bené', []);
    ruim1.client.listEvents.mockRejectedValue(new Error('GCal /events -> HTTP 500'));
    const ruim2 = colabAgenda(2, 'Caly', []);
    ruim2.client.listEvents.mockRejectedValue(new Error('GCal /events -> HTTP 500'));
    getGcalsForSlotMock.mockResolvedValue([ruim1, ruim2]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/portal/agendamentos/${EVT_DO_TENANT.id}`,
    });

    expect(res.statusCode).toBe(502);
    expect(ruim1.client.deleteEvent).not.toHaveBeenCalled();
    await app.close();
  });

  it('404 (não 502): UMA agenda falha mas a outra responde e não tem o evento', async () => {
    // Pelo menos uma listagem deu certo → o evento realmente não existe = 404 real,
    // não erro transitório (não dá pra apagar evento que pode estar na agenda quebrada,
    // mas tampouco mascarar 502; aqui a regra é: houve sucesso ⇒ 404).
    const ruim = colabAgenda(1, 'Bené', []);
    ruim.client.listEvents.mockRejectedValue(new Error('GCal /events -> HTTP 500'));
    const bom = colabAgenda(2, 'Caly', []); // responde, sem o evento
    getGcalsForSlotMock.mockResolvedValue([ruim, bom]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/portal/agendamentos/evt_inexistente',
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('PATCH /portal/agendamentos/:eventId — estabelecimento', () => {
  beforeEach(() => {
    estabelecimentoConfig.ESTABELECIMENTO_ENABLED = true;
    getScopeBySlotMock.mockResolvedValue({
      product_type: 'estabelecimento',
      seat_cap: 5,
      tenant_id: 'tenant-xyz',
    });
  });

  it('200: remarca via patchEvent no MESMO eventId, na agenda do colaborador dono', async () => {
    const bene = colabAgenda(1, 'Bené', [evtAtual()]);
    const caly = colabAgenda(2, 'Caly', []);
    getGcalsForSlotMock.mockResolvedValue([bene, caly]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/agendamentos/evt_atual',
      payload: { hora: '11:00' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    // event_id PRESERVADO (ADR 0025: sem dupla-baixa de pacote).
    expect(body.agendamento.id).toBe('evt_atual');
    // Patch ocorreu na agenda do DONO (Bené), nunca na do outro colaborador.
    expect(bene.client.patchEvent).toHaveBeenCalledTimes(1);
    expect(caly.client.patchEvent).not.toHaveBeenCalled();
    const [eventId, fields] = bene.client.patchEvent.mock.calls[0];
    expect(eventId).toBe('evt_atual');
    expect(fields.startISO).toBe(zonedWallTimeToUtc(FUTURO, 11 * 60).toISOString());
    // Modo estabelecimento: resolvedor singular não é usado.
    expect(getGcalForSlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('404 anti-IDOR: eventId fora de TODAS as agendas de colaborador — NÃO patcheia', async () => {
    const bene = colabAgenda(1, 'Bené', [evtAtual()]);
    getGcalsForSlotMock.mockResolvedValue([bene]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/agendamentos/evt_de_outro_tenant',
      payload: { hora: '11:00' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('evento_nao_encontrado');
    expect(bene.client.patchEvent).not.toHaveBeenCalled();
    await app.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Fase B2 (ADR 0027) — gancho de billing DERIVADO DA AGENDA
//
// POST cria a linha de PREVISÃO; PATCH sincroniza (sync, respeita dirty_fields no
// helper); DELETE faz soft-delete. TUDO gated POR-CLONE por ATEND_FROM_AGENDA_SLOTS
// (slot fora da lista = nenhum helper chamado). E o INVARIANTE CRÍTICO: falha do helper
// NUNCA derruba o agendamento (a operação ainda retorna sucesso pro cliente).
// ════════════════════════════════════════════════════════════════════════════
describe('Fase B2 — gancho de atendimento (ATEND_FROM_AGENDA_SLOTS, gate por-clone)', () => {
  // tenant_id presente é pré-condição do gancho (sem ele = no-op silencioso).
  beforeEach(() => {
    getScopeBySlotMock.mockResolvedValue({
      product_type: 'individual',
      seat_cap: null,
      tenant_id: 'tenant-xyz',
    });
  });

  // ── GATING ──────────────────────────────────────────────────────────────────
  it('flag OFF: POST cria o evento mas NÃO toca a camada de atendimentos', async () => {
    estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS = '';
    const client = gcalClientLivre();
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos',
      payload: PAYLOAD_OK,
    });

    expect(res.statusCode).toBe(201);
    // Flag OFF = byte-a-byte como hoje: helper nem é chamado.
    expect(upsertAtendimentoFromEventMock).not.toHaveBeenCalled();
    expect(getScopeBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('gate POR-CLONE: slot da sessão FORA da lista (Cirilo/Samuel) = OFF byte-a-byte', async () => {
    // SLOTS liga SÓ o dragon; a sessão deste teste é clone_teste_a1b2c3 -> deve ficar OFF.
    estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS = 'clone_barber_dragon_caly8b';
    const client = gcalClientLivre();
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos',
      payload: PAYLOAD_OK,
    });

    expect(res.statusCode).toBe(201);
    expect(upsertAtendimentoFromEventMock).not.toHaveBeenCalled();
    expect(getScopeBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('flag ON: POST cria a linha de PREVISÃO (origem agenda) com slot/tenant da sessão', async () => {
    estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS = injectedSlot;
    const client = gcalClientLivre();
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos',
      payload: PAYLOAD_OK,
    });

    expect(res.statusCode).toBe(201);
    expect(upsertAtendimentoFromEventMock).toHaveBeenCalledTimes(1);
    const arg = upsertAtendimentoFromEventMock.mock.calls[0][0];
    // Isolamento: slot da SESSÃO, tenant resolvido do clone (nunca de input). SOLO -> colaboradorId null.
    expect(arg).toMatchObject({
      slot: injectedSlot,
      tenantId: 'tenant-xyz',
      gcalEventId: 'evt_novo',
      servicoNome: 'Corte',
      colaboradorId: null,
    });
    // Não passa preço explícito: o helper resolve do catálogo (valorCents ausente).
    expect(arg.valorCents).toBeUndefined();
    expect(getScopeBySlotMock).toHaveBeenCalledWith(injectedSlot);
    await app.close();
  });

  it('flag ON + clone sem tenant_id: POST ainda cria o evento, mas o gancho é no-op', async () => {
    estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS = injectedSlot;
    getScopeBySlotMock.mockResolvedValue({
      product_type: 'individual',
      seat_cap: null,
      tenant_id: null,
    });
    const client = gcalClientLivre();
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos',
      payload: PAYLOAD_OK,
    });

    expect(res.statusCode).toBe(201);
    // Sem tenant_id não há como carimbar a linha → helper não é chamado, mas o POST passa.
    expect(upsertAtendimentoFromEventMock).not.toHaveBeenCalled();
    await app.close();
  });

  // ── INVARIANTE CRÍTICO: billing NUNCA derruba o agendamento ──────────────────
  it('CRÍTICO: falha do upsert NÃO derruba o POST (ainda 201)', async () => {
    estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS = injectedSlot;
    upsertAtendimentoFromEventMock.mockRejectedValue(new Error('DB down'));
    const client = gcalClientLivre();
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos',
      payload: PAYLOAD_OK,
    });

    // O evento foi criado no GCal; o billing falhou em silêncio → 201 mesmo assim.
    expect(res.statusCode).toBe(201);
    expect(res.json().ok).toBe(true);
    expect(client.createEvent).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('CRÍTICO: falha do getScopeBySlot NÃO derruba o POST (ainda 201)', async () => {
    estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS = injectedSlot;
    getScopeBySlotMock.mockRejectedValue(new Error('scope lookup falhou'));
    const client = gcalClientLivre();
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/agendamentos',
      payload: PAYLOAD_OK,
    });

    expect(res.statusCode).toBe(201);
    expect(upsertAtendimentoFromEventMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('IDEMPOTÊNCIA: rebook do mesmo serviço chama o upsert (unique parcial dedup no helper)', async () => {
    estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS = injectedSlot;
    const client = gcalClientLivre();
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    // Dois POSTs (rebook/retry): o helper é idempotente pelo unique parcial — não duplica.
    await app.inject({ method: 'POST', url: '/portal/agendamentos', payload: PAYLOAD_OK });
    await app.inject({ method: 'POST', url: '/portal/agendamentos', payload: PAYLOAD_OK });
    // Cada POST chama o upsert; a dedup é no banco (ON CONFLICT), testada em packages/db.
    expect(upsertAtendimentoFromEventMock).toHaveBeenCalledTimes(2);
    await app.close();
  });

  // ── PATCH sincroniza (sync, respeita dirty_fields no helper) ─────────────────
  it('flag OFF: PATCH remarca o evento mas NÃO sincroniza atendimento', async () => {
    estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS = '';
    const client = gcalClientPatch([evtAtual()]);
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/agendamentos/evt_atual',
      payload: { hora: '11:00' },
    });

    expect(res.statusCode).toBe(200);
    expect(syncAtendimentoFromEventMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('flag ON: PATCH chama SYNC com o MESMO eventId preservado (janela nova)', async () => {
    estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS = injectedSlot;
    const client = gcalClientPatch([evtAtual()]);
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/agendamentos/evt_atual',
      payload: { hora: '11:00' },
    });

    expect(res.statusCode).toBe(200);
    expect(syncAtendimentoFromEventMock).toHaveBeenCalledTimes(1);
    // Upsert (create) NÃO é usado no PATCH — só o alias sync (intenção explícita).
    expect(upsertAtendimentoFromEventMock).not.toHaveBeenCalled();
    const arg = syncAtendimentoFromEventMock.mock.calls[0][0];
    expect(arg.gcalEventId).toBe('evt_atual'); // event_id preservado (ADR 0025 dívida 5)
    expect(arg.slot).toBe(injectedSlot);
    expect(arg.tenantId).toBe('tenant-xyz');
    // Nova janela (11:00 BRT) propagada pro helper — quem respeita dirty_fields é o helper.
    expect(arg.inicioAt).toBe(`${FUTURO}T11:00:00-03:00`);
    await app.close();
  });

  it('CRÍTICO: falha do sync NÃO derruba o PATCH (ainda 200)', async () => {
    estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS = injectedSlot;
    syncAtendimentoFromEventMock.mockRejectedValue(new Error('sync explodiu'));
    const client = gcalClientPatch([evtAtual()]);
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/agendamentos/evt_atual',
      payload: { hora: '11:00' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(client.patchEvent).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('estabelecimento: PATCH propaga o colaborador dono do evento pro sync', async () => {
    estabelecimentoConfig.ESTABELECIMENTO_ENABLED = true;
    estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS = injectedSlot;
    getScopeBySlotMock.mockResolvedValue({
      product_type: 'estabelecimento',
      seat_cap: 5,
      tenant_id: 'tenant-xyz',
    });
    const bene = colabAgenda(1, 'Bené', [evtAtual()]);
    const caly = colabAgenda(2, 'Caly', []);
    getGcalsForSlotMock.mockResolvedValue([bene, caly]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/agendamentos/evt_atual',
      payload: { hora: '11:00' },
    });

    expect(res.statusCode).toBe(200);
    expect(syncAtendimentoFromEventMock).toHaveBeenCalledTimes(1);
    // colaboradorId = a agenda dona do evento (Bené=1), resolvida por resolveEventClient.
    expect(syncAtendimentoFromEventMock.mock.calls[0][0].colaboradorId).toBe(1);
    await app.close();
  });

  // ── DELETE faz soft-delete da previsão ───────────────────────────────────────
  it('flag OFF: DELETE apaga o evento mas NÃO faz soft-delete do atendimento', async () => {
    estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS = '';
    const client = gcalClientComEventos([EVT_DO_TENANT]);
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/portal/agendamentos/${EVT_DO_TENANT.id}`,
    });

    expect(res.statusCode).toBe(200);
    expect(softDeleteAtendimentoByEventMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('flag ON: DELETE faz soft-delete da previsão pelo eventId/slot da sessão', async () => {
    estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS = injectedSlot;
    const client = gcalClientComEventos([EVT_DO_TENANT]);
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/portal/agendamentos/${EVT_DO_TENANT.id}`,
    });

    expect(res.statusCode).toBe(200);
    expect(softDeleteAtendimentoByEventMock).toHaveBeenCalledWith(injectedSlot, EVT_DO_TENANT.id);
    await app.close();
  });

  it('CRÍTICO: falha do soft-delete NÃO derruba o DELETE (ainda 200)', async () => {
    estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS = injectedSlot;
    softDeleteAtendimentoByEventMock.mockRejectedValue(new Error('soft-delete falhou'));
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
    await app.close();
  });

  it('flag ON: cancelamento idempotente (evento já ausente) ainda soft-deleta a previsão', async () => {
    estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS = injectedSlot;
    const client = gcalClientComEventos([EVT_DO_TENANT]);
    client.deleteEvent.mockRejectedValue(new Error('GCal /events/x -> HTTP 410: deleted'));
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/portal/agendamentos/${EVT_DO_TENANT.id}`,
    });

    // Estado final = evento ausente → a previsão derivada também deve sumir.
    expect(res.statusCode).toBe(200);
    expect(softDeleteAtendimentoByEventMock).toHaveBeenCalledWith(injectedSlot, EVT_DO_TENANT.id);
    await app.close();
  });

  it('anti-IDOR mantido: DELETE de eventId fora da agenda → 404 e NÃO soft-deleta', async () => {
    estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS = injectedSlot;
    const client = gcalClientComEventos([EVT_DO_TENANT]);
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/portal/agendamentos/evt_de_outro_tenant',
    });

    expect(res.statusCode).toBe(404);
    // Evento alheio nunca passa a guarda → nada é apagado nem no GCal nem no atendimento.
    expect(client.deleteEvent).not.toHaveBeenCalled();
    expect(softDeleteAtendimentoByEventMock).not.toHaveBeenCalled();
    await app.close();
  });

  // ── MUDANÇA 1: PATCH propaga reprecificarServico ao SYNC quando troca o serviço ──────
  it('flag ON: trocar SÓ o serviço propaga reprecificarServico=true pro sync', async () => {
    estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS = injectedSlot;
    // Mesmo serviço de mesma duração (Corte 30min -> Corte 30min) não revalida janela, mas a troca
    // de serviço (servico no body) liga o reprice. Aqui trocamos pra "Corte" (igual) só pra isolar
    // o flag sem disparar revalidação por duração — o reprice é independente.
    const client = gcalClientPatch([evtAtual()]);
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/agendamentos/evt_atual',
      payload: { servico: 'Corte' },
    });

    expect(res.statusCode).toBe(200);
    expect(syncAtendimentoFromEventMock).toHaveBeenCalledTimes(1);
    // mudaServico -> reprice ligado (o helper reprecifica respeitando sticky/pacote).
    expect(syncAtendimentoFromEventMock.mock.calls[0][0].reprecificarServico).toBe(true);
    await app.close();
  });

  it('flag ON: remarcação PURA (só hora) NÃO liga reprice (preserva valor/marca de pacote)', async () => {
    estabelecimentoConfig.ATEND_FROM_AGENDA_SLOTS = injectedSlot;
    const client = gcalClientPatch([evtAtual()]);
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/agendamentos/evt_atual',
      payload: { hora: '11:00' }, // só remarca, não troca serviço
    });

    expect(res.statusCode).toBe(200);
    expect(syncAtendimentoFromEventMock).toHaveBeenCalledTimes(1);
    // Sem troca de serviço -> reprice OMITIDO no eventInput (undefined = sem reprice no helper).
    // Não reabre o bug DOBRA: remarcação pura preserva valor/marca de pacote.
    expect(syncAtendimentoFromEventMock.mock.calls[0][0].reprecificarServico).toBeUndefined();
    await app.close();
  });
});

// ── MUDANÇA 3: revalidar janela ao trocar SÓ o serviço (REVALIDA E AVISA) ────────────
// Quando vem só `servico` (sem data/hora) e o novo serviço é MAIS LONGO, recalculamos o fim a
// partir do início atual e revalidamos janela + conflito. Se bater com o próximo -> 409
// conflito_horario (mensagem tratável). Sem conflito, a troca segue (start preservado, fim estendido).
describe('PATCH /portal/agendamentos/:eventId — MUDANÇA 3: revalida ao trocar serviço mais longo', () => {
  it('200: serviço mais longo que CABE → remarca o fim preservando o início', async () => {
    // Evento atual: Corte 30min (10:00-10:30). Troca pra "Corte + barba" 45min: 10:00-10:45 cabe
    // (janela 09:00-19:00) e só o próprio evento está na agenda → sem conflito.
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
    // Início preservado (10:00), fim estendido pro novo serviço (10:45).
    expect(fields.startISO).toBe(zonedWallTimeToUtc(FUTURO, 10 * 60).toISOString());
    expect(fields.endISO).toBe(zonedWallTimeToUtc(FUTURO, 10 * 60 + 45).toISOString());
    await app.close();
  });

  it('409 conflito_horario: serviço mais longo bate com o PRÓXIMO agendamento', async () => {
    // Guarda (1ª listEvents) acha o evt_atual; recheck da nova janela (2ª) tem o próprio evento
    // (ignorado) + um OUTRO evento ocupando 10:30-11:00 → "Corte + barba" (10:00-10:45) colide.
    const client = gcalClientPatch([evtAtual()]);
    client.listEvents.mockResolvedValueOnce([evtAtual()]).mockResolvedValueOnce([
      evtAtual(),
      {
        id: 'evt_proximo',
        summary: 'Maria - Corte | WhatsApp: 5511888880000',
        start: { dateTime: `${FUTURO}T10:30:00-03:00` },
        end: { dateTime: `${FUTURO}T11:00:00-03:00` },
      },
    ]);
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/agendamentos/evt_atual',
      payload: { servico: 'Corte + barba' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('conflito_horario');
    expect(res.json().message).toContain('mais longo');
    // CRÍTICO: conflito -> NÃO patcheia o evento.
    expect(client.patchEvent).not.toHaveBeenCalled();
    await app.close();
  });

  it('409 conflito_horario: serviço mais longo ESTOURA a janela de funcionamento', async () => {
    // Evento perto do fechamento: 18:45-19:15 não cabe (fecha 19:00) ao virar 45min. Reusa a
    // janela do CONFIG_OK (fecha 19:00). Evento atual às 18:45 (Corte 30min cabe: 18:45-19:15?
    // não — 19:15 > 19:00). Usamos 18:30 (Corte 30min: 18:30-19:00 cabe). Troca p/ 45min: 19:15 estoura.
    const client = gcalClientPatch([
      evtAtual({
        start: { dateTime: `${FUTURO}T18:30:00-03:00` },
        end: { dateTime: `${FUTURO}T19:00:00-03:00` },
      }),
    ]);
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/agendamentos/evt_atual',
      payload: { servico: 'Corte + barba' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('conflito_horario');
    expect(client.patchEvent).not.toHaveBeenCalled();
    await app.close();
  });

  it('200: trocar p/ serviço de MESMA duração não revalida janela (não bloqueia à toa)', async () => {
    // Config tem 2 serviços de durações diferentes; pra mesma duração precisamos de outro caso.
    // Aqui trocamos Corte->Corte (mesma duração 30min) → revalidarPorServico=false, segue normal.
    const client = gcalClientPatch([evtAtual()]);
    getGcalForSlotMock.mockResolvedValue(client);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/agendamentos/evt_atual',
      payload: { servico: 'Corte' },
    });

    expect(res.statusCode).toBe(200);
    const [, fields] = client.patchEvent.mock.calls[0];
    // Mesma duração → NÃO recalcula janela (start/end ausentes no patch).
    expect(fields.startISO).toBeUndefined();
    expect(fields.endISO).toBeUndefined();
    await app.close();
  });
});
