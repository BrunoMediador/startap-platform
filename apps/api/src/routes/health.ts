import type { FastifyPluginAsync } from 'fastify';
import { query } from '@startap/db';

export const healthRoute: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => {
    return { status: 'ok', service: 'api', time: new Date().toISOString() };
  });

  app.get('/health/db', async () => {
    const r = await query<{ ok: number }>('SELECT 1 AS ok');
    return { db: r.rows[0]?.ok === 1 ? 'ok' : 'fail' };
  });
};
