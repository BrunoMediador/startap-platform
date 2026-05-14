import type { FastifyPluginAsync } from 'fastify';
import { logger } from '@startap/core/logger';
import { WahaWebhookBody } from '@startap/core/types';
import { handleWebhook } from '../router.js';

const log = logger.child({ module: 'webhook-waha' });

export const wahaWebhookRoute: FastifyPluginAsync = async (app) => {
  app.post('/webhooks/waha', async (req, reply) => {
    // Valida e parseia payload
    const parsed = WahaWebhookBody.safeParse(req.body);
    if (!parsed.success) {
      log.warn({ errors: parsed.error.flatten() }, 'Payload WAHA inválido');
      return reply.code(400).send({ error: 'invalid payload' });
    }

    // Processa de forma assíncrona, mas await o resultado pra responder com status
    // WAHA tem retries; importante retornar 2xx mesmo se ignorarmos a mensagem
    const result = await handleWebhook(parsed.data).catch((e) => {
      log.error({ err: e }, 'Webhook handler crashed');
      return { status: 'error:crash' };
    });

    return reply.send(result);
  });
};
