import { readFileSync } from 'node:fs';
import * as net from 'node:net';
import { URL } from 'node:url';
import { pool } from '@startap/db';
import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';

const CHECK_TIMEOUT_MS = 500;

/** Tenta conectar via TCP num host:port dentro de CHECK_TIMEOUT_MS.
 * Resolve 'ok' se conectar, 'degraded' se timeout/erro. */
function tcpPing(host: string, port: number): Promise<'ok' | 'degraded'> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('degraded');
    }, CHECK_TIMEOUT_MS);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve('ok');
    });

    socket.once('error', () => {
      clearTimeout(timer);
      resolve('degraded');
    });
  });
}

/** Tenta executar SELECT 1 via pool com timeout de CHECK_TIMEOUT_MS. */
async function dbPing(): Promise<'ok' | 'degraded'> {
  try {
    const client = await Promise.race([
      pool.connect(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('db connect timeout')), CHECK_TIMEOUT_MS),
      ),
    ]);
    try {
      await client.query('SELECT 1');
      return 'ok';
    } finally {
      client.release();
    }
  } catch {
    return 'degraded';
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

export const healthRoute: FastifyPluginAsync = async (app) => {
  app.get('/health', async (_req, reply) => {
    const redisHost = config.REDIS_HOST;
    const redisPort = config.REDIS_PORT;

    const [db, redis] = await Promise.all([dbPing(), tcpPing(redisHost, redisPort)]);

    return reply.code(200).send({
      status: 'ok',
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      version: appVersion,
      checks: { db, redis },
    });
  });
};
