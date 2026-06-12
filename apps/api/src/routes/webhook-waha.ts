import { randomUUID } from 'node:crypto';
import { logger } from '@startap/core/logger';
import { WahaWebhookBody } from '@startap/core/types';
import { flowExecutionLog } from '@startap/db';
import type { FastifyPluginAsync, onRequestHookHandler } from 'fastify';
import { config } from '../config.js';
import { WAHA_WEBHOOK_SECRET_HEADER, isWahaWebhookAuthorized } from '../lib/webhook-auth.js';
import { handleWebhook } from '../router.js';

const log = logger.child({ module: 'webhook-waha' });

/**
 * Auth ANTES de TUDO (P0 security — review do PR #268): hook onRequest roda antes
 * até do parse do body — um 401 não parseia payload de atacante, não grava em
 * flow_execution_log e não chega no router (nem no gancho trial-pairing de
 * session.status). Com WAHA_WEBHOOK_SECRET ausente o hook é no-op (retrocompat,
 * lição do incidente #247 — warn no boot em server.ts).
 *
 * LGPD: o log de rejeição NUNCA inclui payload, headers ou o valor do secret —
 * só ip e se o header veio.
 */
const wahaWebhookAuth: onRequestHookHandler = async (req, reply) => {
  const provided = req.headers[WAHA_WEBHOOK_SECRET_HEADER];
  if (isWahaWebhookAuthorized(provided, config.WAHA_WEBHOOK_SECRET)) return;
  log.warn(
    { ip: req.ip, hasHeader: provided !== undefined },
    'Webhook WAHA rejeitado: secret ausente/inválido (401)',
  );
  return reply.code(401).send({ error: 'unauthorized' });
};

export const wahaWebhookRoute: FastifyPluginAsync = async (app) => {
  app.post('/webhooks/waha', { onRequest: wahaWebhookAuth }, async (req, reply) => {
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
