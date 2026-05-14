import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { logger } from '@startap/core/logger';
import { config } from './config.js';
import { healthRoute } from './routes/health.js';
import { wahaWebhookRoute } from './routes/webhook-waha.js';
import { registerBot } from './router.js';
import { EchoBot } from './bots/echo.js';
import { BarbeariaCiriloBot } from './bots/barbearia.js';

const log = logger.child({ service: 'api' });

async function main() {
  const app = Fastify({
    logger: false, // usamos pino direto via child loggers
    bodyLimit: 5 * 1024 * 1024, // 5MB pra midia base64
  });

  await app.register(sensible);

  // Rotas
  await app.register(healthRoute);
  await app.register(wahaWebhookRoute);

  // Bots
  registerBot('echo', new EchoBot());
  registerBot('0ni38aSspWwhooHd', new BarbeariaCiriloBot()); // TESTE_BARBEARIAS_AGENDAMENTOS (Cirilo)

  app.setErrorHandler((err, req, reply) => {
    log.error({ err, url: req.url }, 'Request error');
    reply.code(500).send({ error: 'internal_error' });
  });

  const port = config.API_PORT;
  await app.listen({ host: '0.0.0.0', port });
  log.info({ port }, 'API rodando');

  // Graceful shutdown
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      log.info({ sig }, 'Shutdown iniciado');
      await app.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  log.error({ err }, 'Falha fatal');
  process.exit(1);
});
