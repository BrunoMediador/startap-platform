import { randomUUID } from 'node:crypto';
import { logger } from '@startap/core/logger';
import { WahaWebhookBody } from '@startap/core/types';
import { flowExecutionLog } from '@startap/db';
import type { FastifyPluginAsync } from 'fastify';
import { handleWebhook } from '../router.js';

const log = logger.child({ module: 'webhook-waha' });

export const wahaWebhookRoute: FastifyPluginAsync = async (app) => {
  app.post('/webhooks/waha', async (req, reply) => {
    const executionId = randomUUID();
    const startedAt = Date.now();
    const parsed = WahaWebhookBody.safeParse(req.body);
    if (!parsed.success) {
      const flat = parsed.error.flatten();
      log.warn({ errors: flat }, 'Payload WAHA inválido');
      // Re-mapeia fieldErrors para chaves que nao caiam no redactor de
      // sensitive-keys (palavra "payload"/"body"/"raw" e redactada). Sem
      // isso vemos so [redacted] no painel e nao conseguimos diagnosticar.
      const fieldErrorsSafe: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(flat.fieldErrors ?? {})) {
        fieldErrorsSafe[`field_${key}`] = value;
      }
      await flowExecutionLog.logFlowEvent({
        executionId,
        eventType: 'webhook.invalid-payload',
        status: 'ignored',
        message: 'Payload WAHA inválido',
        metadata: {
          formErrors: flat.formErrors,
          ...fieldErrorsSafe,
        },
        durationMs: Date.now() - startedAt,
      });
      return reply.code(200).send({ status: 'ignored:invalid-payload' });
    }

    await flowExecutionLog.logFlowEvent({
      executionId,
      session: parsed.data.session,
      eventType: 'webhook.received',
      status: 'running',
      message: 'Webhook WAHA recebido',
      metadata: {
        event: parsed.data.event,
        hasPayload: !!parsed.data.payload,
        fromMe: !!parsed.data.payload?.fromMe,
        hasMedia: !!parsed.data.payload?.hasMedia,
        mediaType: parsed.data.payload?.media?.mimetype ?? null,
      },
    });

    // Processa de forma assíncrona, mas await o resultado pra responder com status
    // WAHA tem retries; importante retornar 2xx mesmo se ignorarmos a mensagem
    const result = await handleWebhook(parsed.data, { executionId, startedAt }).catch(async (e) => {
      log.error({ err: e }, 'Webhook handler crashed');
      await flowExecutionLog.logFlowEvent({
        executionId,
        session: parsed.data.session,
        eventType: 'webhook.crash',
        status: 'error',
        message: 'Webhook handler crashed',
        error: e,
        durationMs: Date.now() - startedAt,
      });
      return { status: 'error:crash' };
    });

    return reply.send(result);
  });
};
