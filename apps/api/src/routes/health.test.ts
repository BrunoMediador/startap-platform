/**
 * Testa a rota GET /health em isolamento (SCRUM-131).
 *
 * O /health deve refletir o estado REAL de Postgres (SELECT 1) e Redis (PING):
 *  - tudo up   → HTTP 200 + status 'ok';
 *  - algo down → HTTP 503 + status 'degraded', com detalhe por componente.
 *
 * Strategy:
 * - Mocka `@startap/db` (pool) para evitar conexao real com Postgres.
 * - Mocka `ioredis` para controlar o resultado do PING sem Redis real.
 * - Mocka `../config.js` para evitar que o IIFE do config singleton lance
 *   ZodError por falta de envs obrigatórias no ambiente de testes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks hoisted — referenciáveis dentro da factory de vi.mock('ioredis').
const { redisConnectMock, redisPingMock, redisDisconnectMock, redisCtorMock } = vi.hoisted(() => ({
  redisConnectMock: vi.fn(),
  redisPingMock: vi.fn(),
  redisDisconnectMock: vi.fn(),
  redisCtorMock: vi.fn(),
}));

// Mock do config singleton — evita execucao do IIFE que valida envs obrigatórias
vi.mock('../config.js', () => ({
  config: {
    NODE_ENV: 'test',
    API_PORT: 3040,
    LOG_LEVEL: 'silent',
    PG_HOST: 'localhost',
    PG_PORT: 5432,
    PG_USER: 'user',
    PG_PASS: 'pass',
    PG_DB: 'db',
    WAHA_URL: 'http://waha:3000',
    WAHA_API_KEY: 'key',
    WHISPER_URL: 'http://whisper:9000',
    OPENAI_API_KEY: 'sk-test',
    OPENAI_MODEL: 'gpt-4o',
    REDIS_HOST: 'redis',
    REDIS_PORT: 6379,
    REDIS_PASSWORD: undefined,
    STARTAP_WAHA_SESSIONS: 'startap',
    AGENT_HISTORY_MAX_CHARS: 12000,
    AGENT_TOOL_RESULT_MAX_CHARS: 6000,
    CHAT_MEMORY_RETENTION: 30,
    CHAT_STALE_RUNNING_MAX_MINUTES: 30,
  },
}));

// Mock do pool do @startap/db (evita conexao real com Postgres)
vi.mock('@startap/db', () => ({
  pool: {
    connect: vi.fn(),
  },
  query: vi.fn(),
  closePool: vi.fn(),
  routing: {},
  pausa: {},
  chatMemory: {},
  antibot: {},
  leads: {},
  agendamento: {},
  botConfig: {},
  modelUsage: {},
  botPrompt: {},
  botMedia: {},
  flowExecutionLog: { logFlowEvent: vi.fn() },
  flowControl: {},
  flowClones: {},
  botCourses: {},
}));

// Mock do ioredis — o construtor devolve um client fake controlável.
vi.mock('ioredis', () => {
  redisCtorMock.mockImplementation(() => ({
    on: vi.fn(),
    connect: redisConnectMock,
    ping: redisPingMock,
    disconnect: redisDisconnectMock,
  }));
  return { Redis: redisCtorMock };
});

import { pool } from '@startap/db';
import Fastify from 'fastify';
import { healthRoute } from './health.js';

type MockFn = ReturnType<typeof vi.fn>;

/** Helper: cria um mock de client pg que executa SELECT 1 com sucesso. */
function makePgClientOk() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    release: vi.fn(),
  };
}

/** Deixa o Redis mock saudável (connect resolve, PING → PONG). */
function redisUp() {
  redisConnectMock.mockResolvedValue(undefined);
  redisPingMock.mockResolvedValue('PONG');
}

/** Deixa o Redis mock indisponível (connect rejeita, como Redis inacessível). */
function redisDown() {
  redisConnectMock.mockRejectedValue(new Error('ECONNREFUSED'));
  redisPingMock.mockResolvedValue('PONG');
}

type HealthBody = {
  status: string;
  uptime: number;
  version: string;
  checks: { db: string; redis: string };
};

describe('GET /health', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(healthRoute);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it('retorna 200 + status ok quando DB e Redis estao saudaveis', async () => {
    (pool.connect as MockFn).mockResolvedValue(makePgClientOk());
    redisUp();

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as HealthBody;
    expect(body.status).toBe('ok');
    expect(body.checks.db).toBe('up');
    expect(body.checks.redis).toBe('up');
    expect(typeof body.uptime).toBe('number');
    expect(typeof body.version).toBe('string');
  });

  it('retorna 503 + status degraded (db=down) quando o Postgres falha — processo nao cai', async () => {
    (pool.connect as MockFn).mockRejectedValue(new Error('connection refused'));
    redisUp();

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(503);
    const body = res.json() as HealthBody;
    expect(body.status).toBe('degraded');
    expect(body.checks.db).toBe('down');
    expect(body.checks.redis).toBe('up');
  });

  it('retorna 503 + status degraded (redis=down) quando o Redis falha — processo nao cai', async () => {
    (pool.connect as MockFn).mockResolvedValue(makePgClientOk());
    redisDown();

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(503);
    const body = res.json() as HealthBody;
    expect(body.status).toBe('degraded');
    expect(body.checks.db).toBe('up');
    expect(body.checks.redis).toBe('down');
  });

  it('retorna 503 + status degraded quando ambos falham', async () => {
    (pool.connect as MockFn).mockRejectedValue(new Error('pg down'));
    redisDown();

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(503);
    const body = res.json() as HealthBody;
    expect(body.status).toBe('degraded');
    expect(body.checks.db).toBe('down');
    expect(body.checks.redis).toBe('down');
  });
});
