import sensible from '@fastify/sensible';
import { logger } from '@startap/core/logger';
import Fastify from 'fastify';
import { EchoBot } from './bots/echo.js';
// Importar startap.ts dispara registerBotEntry no módulo (efeito colateral de init).
import './bots/startap.js';
import { TesteBarbeariaBot } from './bots/teste_barbearia.js';
import { config } from './config.js';
import { registerBot, registerCloneFactory } from './router.js';
import { healthRoute } from './routes/health.js';
import { abacatePayWebhookRoute } from './routes/webhook-abacatepay.js';
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
  // Webhook AbacatePay (F2): plugin encapsulado — seu content-type parser raw fica
  // ESCOPADO a ele (C3), nao afeta o JSON parser global nem o webhook-waha.
  await app.register(abacatePayWebhookRoute);

  // Bots sem sessão própria — lookup via routing_clientes.
  // Startap já está registrado via import './bots/startap.js' acima (registerBotEntry no init).
  registerBot('echo', new EchoBot());
  registerBot('0ni38aSspWwhooHd', new TesteBarbeariaBot(), 'pausa_cirilo'); // teste_barbearia

  // Factories de clones — uma por matriz. O dispatcher instancia dinamicamente com slotOverride.
  registerCloneFactory(
    'teste_barbearia',
    (slotOverride) => new TesteBarbeariaBot({ slotOverride }),
  );

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
