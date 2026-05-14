import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { logger } from '@startap/core/logger';
import { config } from './config.js';
import { healthRoute } from './routes/health.js';
import { wahaWebhookRoute } from './routes/webhook-waha.js';
import { registerBot } from './router.js';
import { EchoBot } from './bots/echo.js';
import { TesteBarbeariaBot } from './bots/teste_barbearia.js';
import { TesteVendasBot } from './bots/teste_vendas.js';
import { StartapBot } from './bots/startap.js';

const log = logger.child({ service: 'api' });

async function main() {
  const app = Fastify({
    logger: false,
    bodyLimit: 5 * 1024 * 1024,
  });

  await app.register(sensible);
  await app.register(healthRoute);
  await app.register(wahaWebhookRoute);

  // Bots — workflow_id eh a chave em routing_clientes (mantida estavel)
  registerBot('echo', new EchoBot());
  registerBot('0ni38aSspWwhooHd', new TesteBarbeariaBot()); // teste_barbearia
  registerBot('dlpKXM3gvX2joC1b', new TesteVendasBot());    // teste_vendas
  registerBot('uUS3Ux1cU2DquKxo', new StartapBot());        // startap

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
