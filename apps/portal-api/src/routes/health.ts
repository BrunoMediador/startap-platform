import * as net from 'node:net';
import { pool } from '@startap/db';
import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';

const CHECK_TIMEOUT_MS = 500;

/** TCP ping com timeout. 'ok' se conecta, 'degraded' se falha/timeout. */
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

/** SELECT 1 via pool com timeout. */
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

export const healthRoute: FastifyPluginAsync = async (app) => {
  app.get('/health', async (_req, reply) => {
    const [db, redis] = await Promise.all([
      dbPing(),
      tcpPing(config.REDIS_HOST, config.REDIS_PORT),
    ]);
    return reply.code(200).send({
      status: 'ok',
      service: 'portal-api',
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      checks: { db, redis },
    });
  });
};
