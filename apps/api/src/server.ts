import sensible from '@fastify/sensible';
import { logger } from '@startap/core/logger';
import Fastify from 'fastify';
import { EchoBot } from './bots/echo.js';
// Importar startap.ts dispara registerBotEntry no módulo (efeito colateral de init).
import './bots/startap.js';
import { TesteBarbeariaBot } from './bots/teste_barbearia.js';
import { TesteVendasBot } from './bots/teste_vendas.js';
import {
  TESTE_VENDAS_BARBEARIA_WORKFLOW_ID,
  TesteVendasBarbeariaBot,
} from './bots/teste_vendas_barbearia.js';
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

  // Bots sem sessão própria — lookup via routing_clientes.
  // Startap já está registrado via import './bots/startap.js' acima (registerBotEntry no init).
  registerBot('echo', new EchoBot());
  registerBot('0ni38aSspWwhooHd', new TesteBarbeariaBot()); // teste_barbearia
  registerBot('dlpKXM3gvX2joC1b', new TesteVendasBot()); // teste_vendas
  registerBot(TESTE_VENDAS_BARBEARIA_WORKFLOW_ID, new TesteVendasBarbeariaBot()); // teste_vendas_barbearia

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
