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
import { closeRedis, getRedis } from './lib/session.js';
import { parseTrustProxy } from './lib/trust-proxy.js';
import { authRoutes } from './routes/auth.js';
import { healthRoute } from './routes/health.js';
import { portalAgendaSlotsRoutes } from './routes/portal-agenda-slots.js';
import { portalAgendamentosRoutes } from './routes/portal-agendamentos.js';
import { portalBillingRoutes } from './routes/portal-billing.js';
import { portalConexaoRoutes } from './routes/portal-conexao.js';
import { portalConfigRoutes } from './routes/portal-config.js';
import { portalPausasRoutes } from './routes/portal-pausas.js';
import { portalSignupRoutes } from './routes/portal-signup.js';
import { portalStatusRoutes } from './routes/portal-status.js';

const log = logger.child({ service: 'portal-api' });

async function main() {
  const app = Fastify({
    logger: false,
    bodyLimit: 1 * 1024 * 1024, // payloads do portal sao pequenos
    // SO confia em XFF anexado pelos hops reais (NPM/portal-web em faixa privada).
    // `true` deixava o cliente forjar o proprio req.ip e bypassar todo rate-limit
    // por IP (security review PR #268, P1 #3). Ver lib/trust-proxy.ts.
    trustProxy: parseTrustProxy(config.PORTAL_TRUST_PROXY),
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

  // Signup self-service (Missao 020 F1) — escopo proprio com rate-limit DIARIO
  // por IP (anti trial-farm, doc 020). Flag PORTAL_SIGNUP OFF -> rota responde 404.
  // Store no Redis (security review PR #268, item 3): janela de 1 DIA nao pode
  // resetar a cada restart do container nem divergir entre instancias. Redis ja
  // e dependencia dura do portal (sessoes); se cair, o limite degrada fail-closed.
  await app.register(async (instance) => {
    await instance.register(rateLimit, {
      max: config.PORTAL_SIGNUP_RATE_MAX,
      timeWindow: '1 day',
      keyGenerator: (req) => req.ip,
      redis: getRedis(),
      nameSpace: 'portal:rl:signup:',
    });
    await instance.register(portalSignupRoutes);
  });

  await app.register(portalConfigRoutes);
  await app.register(portalPausasRoutes);
  await app.register(portalStatusRoutes);
  await app.register(portalAgendamentosRoutes);
  // Grade de horarios livres pro agendamento manual (Missao 020 F4).
  await app.register(portalAgendaSlotsRoutes);
  await app.register(portalBillingRoutes);
  // Reconexão self-service da sessão WAHA (ADR 0015) — escopo encapsulado: tem o
  // próprio @fastify/rate-limit por user (keyGenerator por cookie de sessão).
  await app.register(portalConexaoRoutes);

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
