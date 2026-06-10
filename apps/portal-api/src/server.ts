/**
 * portal-api — API Fastify do Portal do Cliente (ADR 0012). Porta 3051.
 *
 * Isolado do apps/api (webhooks) e do painel-admin (gestao interna). Exposto a
 * internet SO atraves do Next (portal-web); aqui fica na rede interna.
 *
 * Sessao em cookie httpOnly assinado + store no Redis (revogacao imediata).
 * Toda rota autenticada passa por withTenant — slot derivado da sessao, nunca
 * de input do cliente.
 */
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { logger } from '@startap/core/logger';
import Fastify from 'fastify';
import { config } from './config.js';
import { closeRedis } from './lib/session.js';
import { authRoutes } from './routes/auth.js';
import { healthRoute } from './routes/health.js';
import { portalAgendamentosRoutes } from './routes/portal-agendamentos.js';
import { portalBillingRoutes } from './routes/portal-billing.js';
import { portalConfigRoutes } from './routes/portal-config.js';
import { portalPausasRoutes } from './routes/portal-pausas.js';
import { portalStatusRoutes } from './routes/portal-status.js';

const log = logger.child({ service: 'portal-api' });

async function main() {
  const app = Fastify({
    logger: false,
    bodyLimit: 1 * 1024 * 1024, // payloads do portal sao pequenos
    trustProxy: true, // atras do Next/NPM
  });

  await app.register(sensible);
  await app.register(cookie, { secret: config.PORTAL_SESSION_SECRET });

  // Rate limit global moderado; o login tem limite proprio mais agressivo abaixo.
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: '1 minute',
  });

  await app.register(healthRoute);

  // Limite agressivo de login (brute-force) — alem do lockout por user no DB.
  await app.register(async (instance) => {
    await instance.register(rateLimit, {
      max: 10,
      timeWindow: '1 minute',
      keyGenerator: (req) => req.ip,
    });
    await instance.register(authRoutes);
  });

  await app.register(portalConfigRoutes);
  await app.register(portalPausasRoutes);
  await app.register(portalStatusRoutes);
  await app.register(portalAgendamentosRoutes);
  await app.register(portalBillingRoutes);

  app.setErrorHandler((err: unknown, req, reply) => {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, url: req.url }, 'Request error');
    reply.code(500).send({ error: 'internal_error' });
  });

  const port = config.PORTAL_API_PORT;
  await app.listen({ host: '0.0.0.0', port });
  log.info({ port }, 'portal-api rodando');

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      log.info({ sig }, 'Shutdown iniciado');
      await app.close();
      await closeRedis();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, 'Falha fatal');
  process.exit(1);
});
