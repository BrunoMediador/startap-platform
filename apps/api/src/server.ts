import sensible from '@fastify/sensible';
import { logger } from '@startap/core/logger';
import Fastify from 'fastify';
import { BarbeariaCiriloBot } from './bots/barbearia.js';
import { EchoBot } from './bots/echo.js';
import { RicardoBot } from './bots/ricardo.js';
import { StartapAiBot } from './bots/startap.js';
import { config } from './config.js';
import { registerBot } from './router.js';
import { healthRoute } from './routes/health.js';
import { wahaWebhookRoute } from './routes/webhook-waha.js';

const log = logger.child({ service: 'api' });

async function main() {
  const app = Fastify({
    logger: false,
    bodyLimit: 5 * 1024 * 1024,
  });

  await app.register(sensible);

  await app.register(healthRoute);
  await app.register(wahaWebhookRoute);

  // Bots
  registerBot('echo', new EchoBot());
  registerBot('0ni38aSspWwhooHd', new BarbeariaCiriloBot());
  registerBot('dlpKXM3gvX2joC1b', new RicardoBot());
  registerBot('uUS3Ux1cU2DquKxo', new StartapAiBot());

  app.setErrorHandler((err, req, reply) => {
    log.error({ err, url: req.url }, 'Request error');
    reply.code(500).send({ error: 'internal_error' });
  });

  const port = config.API_PORT;
  await app.listen({ host: '0.0.0.0', port });
  log.info({ port }, 'API rodando');

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
