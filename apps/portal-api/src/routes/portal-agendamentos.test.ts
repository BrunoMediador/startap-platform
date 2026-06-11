/**
 * Testes do POST /portal/agendamentos (Missão 020 F4 — agendamento manual).
 *
 * DB e GCal MOCKADOS. Foco: caminho feliz (evento criado com o MESMO formato
 * de título do bot), 409 estruturado em conflito (anti-corrida), validação de
 * payload e invariante anti-IDOR (slot SEMPRE da sessão).
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
