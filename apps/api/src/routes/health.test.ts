/**
 * Testa a rota GET /health em isolamento.
 *
 * Strategy:
 * - Mocka `@startap/db` (pool) para evitar conexao real com Postgres.
 * - Mocka `node:net` para controlar o resultado do tcpPing sem socket real.
 * - Mocka `../config.js` para evitar que o IIFE do config singleton lance
 *   ZodError por falta de envs obrigatórias no ambiente de testes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// Mock do modulo net para controlar tcpPing sem socket real
vi.mock('node:net', () => ({
  createConnection: vi.fn(),
}));

import * as net from 'node:net';
import { pool } from '@startap/db';
import Fastify from 'fastify';
import { healthRoute } from './health.js';

type MockFn = ReturnType<typeof vi.fn>;

/** Helper: cria um socket fake que dispara evento 'connect' no próximo tick. */
function makeSocketOk() {
  const socket = {
    once: (event: string, cb: () => void) => {
      if (event === 'connect') {
        setTimeout(() => cb(), 0);
      }
    },
    destroy: vi.fn(),
  };
  return socket;
}

/** Helper: cria um socket fake que dispara evento 'error' no próximo tick. */
function makeSocketError() {
  const socket = {
    once: (event: string, cb: () => void) => {
      if (event === 'error') {
        setTimeout(() => cb(), 0);
      }
    },
    destroy: vi.fn(),
  };
  return socket;
}

/** Helper: cria um mock de client pg que executa SELECT 1 com sucesso. */
function makePgClientOk() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    release: vi.fn(),
  };
}

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

  it('retorna 200 com status ok quando DB e Redis estao saudaveis', async () => {
    (pool.connect as MockFn).mockResolvedValue(makePgClientOk());
    (net.createConnection as MockFn).mockReturnValue(makeSocketOk());

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    type HealthBody = {
      status: string;
      uptime: number;
      version: string;
      checks: { db: string; redis: string };
    };
    const body = res.json() as HealthBody;
    expect(body.status).toBe('ok');
    expect(body.checks.db).toBe('ok');
    expect(body.checks.redis).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(typeof body.version).toBe('string');
  });

  it('retorna 200 com checks.db=degraded quando DB falha — processo nao cai', async () => {
    (pool.connect as MockFn).mockRejectedValue(new Error('connection refused'));
    (net.createConnection as MockFn).mockReturnValue(makeSocketOk());

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    type ChecksBody = { status: string; checks: { db: string; redis: string } };
    const body = res.json() as ChecksBody;
    expect(body.status).toBe('ok');
    expect(body.checks.db).toBe('degraded');
    expect(body.checks.redis).toBe('ok');
  });

  it('retorna 200 com checks.redis=degraded quando Redis falha — processo nao cai', async () => {
    (pool.connect as MockFn).mockResolvedValue(makePgClientOk());
    (net.createConnection as MockFn).mockReturnValue(makeSocketError());

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    type ChecksBody = { status: string; checks: { db: string; redis: string } };
    const body = res.json() as ChecksBody;
    expect(body.status).toBe('ok');
    expect(body.checks.db).toBe('ok');
    expect(body.checks.redis).toBe('degraded');
  });
});
