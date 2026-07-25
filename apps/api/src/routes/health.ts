import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { pool } from '@startap/db';
import type { FastifyPluginAsync } from 'fastify';
import { Redis } from 'ioredis';
import { config } from '../config.js';

const CHECK_TIMEOUT_MS = 500;

type ComponentStatus = 'up' | 'down';

/**
 * Corre uma promise contra um timeout curto. Rejeita se estourar; sempre limpa
 * o timer (não vaza handle). Usado pra manter o /health rápido e não-bloqueante.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * SELECT 1 no Postgres via pool, com timeout curto.
 * 'up' se responde dentro da janela; 'down' em QUALQUER erro/timeout. Nunca lança.
 */
async function dbPing(): Promise<ComponentStatus> {
  try {
    const client = await withTimeout(pool.connect(), CHECK_TIMEOUT_MS, 'db connect');
    try {
      await withTimeout(client.query('SELECT 1'), CHECK_TIMEOUT_MS, 'db query');
      return 'up';
    } finally {
      client.release();
    }
  } catch {
    return 'down';
  }
}

/**
 * PING real no Redis via conexão EFÊMERA (connect → PING → disconnect).
 *
 * Deliberadamente NÃO reusa o singleton getRedis() (lib/redis.ts): aquele client
 * é lazy e só nasce quando a dedup liga. Um healthcheck não deve deixar a API com
 * uma conexão Redis permanente aberta como efeito colateral. A conexão aqui vive
 * só o tempo do PING e é sempre encerrada no finally.
 *
 * 'up' se recebe PONG dentro do timeout; 'down' em QUALQUER erro/timeout. Nunca lança.
 */
async function redisPing(): Promise<ComponentStatus> {
  const client = new Redis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    lazyConnect: true,
    connectTimeout: CHECK_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => null, // one-shot: se cair, não reconecta — o check falha rápido
  });
  // Absorve 'error' pra o Redis down não emitir 'unhandled error' no processo.
  client.on('error', () => {});
  try {
    await withTimeout(
      client.connect().then(() => client.ping()),
      CHECK_TIMEOUT_MS,
      'redis ping',
    );
    return 'up';
  } catch {
    return 'down';
  } finally {
    client.disconnect();
  }
}

const startedAt = Date.now();

/** Lê a versão do package.json em tempo de boot (sincrono, uma vez). */
function readVersion(): string {
  try {
    // Em dev (tsx): __dirname aponta para src/ → sobe dois níveis até apps/api/
    // Em prod (dist): __dirname aponta para dist/ → sobe dois níveis até app/
    const pkgPath = new URL('../../package.json', import.meta.url);
    const raw = readFileSync(pkgPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    // Fallback silencioso — versão desconhecida não deve derrubar o healthcheck
    return '0.0.0';
  }
}

const appVersion = readVersion();

/**
 * GET /health — reflete o estado REAL das dependências (Postgres + Redis).
 *
 * - Tudo up  → HTTP 200 + { status: 'ok', checks: { db: 'up', redis: 'up' } }
 * - Algo down → HTTP 503 + { status: 'degraded', checks: { db, redis } }
 *
 * Fail-safe: os checks nunca lançam; um catch externo de segurança garante que o
 * handler jamais derruba a request (fail-closed → 503 se algo inesperado quebrar).
 */
export const healthRoute: FastifyPluginAsync = async (app) => {
  app.get('/health', async (_req, reply) => {
    let db: ComponentStatus = 'down';
    let redis: ComponentStatus = 'down';
    try {
      [db, redis] = await Promise.all([dbPing(), redisPing()]);
    } catch {
      // Rede de segurança: dbPing/redisPing já são fail-safe. Se, ainda assim,
      // algo inesperado escapar, mantemos db/redis='down' → responde 503.
    }

    const healthy = db === 'up' && redis === 'up';
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      version: appVersion,
      checks: { db, redis },
    });
  });
};
