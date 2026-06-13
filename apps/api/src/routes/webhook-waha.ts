import { randomUUID } from 'node:crypto';
import { logger } from '@startap/core/logger';
import { WahaWebhookBody } from '@startap/core/types';
import { flowExecutionLog } from '@startap/db';
import type { FastifyPluginAsync, onRequestHookHandler, preValidationHookHandler } from 'fastify';
import { config } from '../config.js';
import {
  WAHA_WEBHOOK_SECRET_HEADER,
  isWahaWebhookAuthorized,
  resolveWahaWebhookAuthMode,
  verifyWahaHmacSignature,
} from '../lib/webhook-auth.js';
import { handleWebhook } from '../router.js';

const log = logger.child({ module: 'webhook-waha' });

const MAX_BODY_BYTES = 5 * 1024 * 1024; // mesmo bodyLimit do app (server.ts)

/**
 * Auth em DUAS camadas, o máximo possível ANTES do parse (P0 security #268 +
 * spike 2026-06-11). Precedência: HMAC (plano A) > header estático (plano B) >
 * aberto (retrocompat #247, warn no boot em server.ts). Com HMAC configurado o
 * header estático é IGNORADO — HMAC sozinho basta (autentica + integridade).
 * Replay/duplicata de mensagem é tratado SEPARADAMENTE no router pelo dedup de
 * (sessao, messageId) no Redis (ADR 0019, flag IDEMPOTENCY_DEDUP) — NÃO aqui.
 *
 * Camada 1 — onRequest (roda ANTES do parse do body):
 *  - modo hmac: a assinatura é sobre o body, então só a PRESENÇA do header é
 *    verificável aqui — ausente -> 401 sem ler um byte do payload.
 *  - modo estático: validação COMPLETA (não depende do body) -> 401 pré-parse.
 *
 * Camada 2 — preValidation (modo hmac): o parser escopado deste plugin entrega o
 * body como Buffer CRU (zero processamento do conteúdo); aqui a assinatura é
 * verificada sobre os bytes exatos e, SÓ se válida, o JSON.parse acontece.
 * Atacante sem a key nunca tem o payload parseado.
 *
 * LGPD: logs de rejeição NUNCA incluem payload, headers ou segredos — só ip,
 * modo e se o header veio.
 */
const wahaWebhookAuth: onRequestHookHandler = async (req, reply) => {
  const mode = resolveWahaWebhookAuthMode(config.WAHA_WEBHOOK_HMAC_KEY, config.WAHA_WEBHOOK_SECRET);
  if (mode === 'hmac') {
    if (req.headers[config.WAHA_WEBHOOK_HMAC_HEADER] !== undefined) return;
    log.warn(
      { ip: req.ip, mode, hasHeader: false },
      'Webhook WAHA rejeitado: assinatura HMAC ausente (401)',
    );
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (mode === 'static-header') {
    const provided = req.headers[WAHA_WEBHOOK_SECRET_HEADER];
    if (isWahaWebhookAuthorized(provided, config.WAHA_WEBHOOK_SECRET)) return;
    log.warn(
      { ip: req.ip, mode, hasHeader: provided !== undefined },
      'Webhook WAHA rejeitado: secret ausente/inválido (401)',
    );
    return reply.code(401).send({ error: 'unauthorized' });
  }
  // mode === 'open': retrocompat, aceita tudo.
};

/**
 * Camada 2: verifica HMAC sobre o raw body (se modo hmac) e SÓ ENTÃO parseia o
 * JSON, repondo req.body com o objeto (o resto da rota segue igual). JSON
 * malformado -> 400 (mesmo status do parser default do Fastify; WAHA retenta,
 * comportamento preservado).
 */
const wahaWebhookParseAndVerify: preValidationHookHandler = async (req, reply) => {
  // O parser escopado abaixo entrega Buffer; text/plain (parser default do
  // Fastify) entregaria string — normaliza pros MESMOS bytes recebidos.
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body
    : typeof req.body === 'string'
      ? Buffer.from(req.body, 'utf8')
      : null;
  if (rawBody === null) {
    // Sem bytes crus não há o que validar/parsear (content-type exótico).
    return reply.code(400).send({ error: 'invalid_json' });
  }

  const hmacKey = config.WAHA_WEBHOOK_HMAC_KEY;
  if (hmacKey) {
    const provided = req.headers[config.WAHA_WEBHOOK_HMAC_HEADER];
    const valid = verifyWahaHmacSignature(
      rawBody,
      provided,
      hmacKey,
      config.WAHA_WEBHOOK_HMAC_ALGORITHM,
    );
    if (!valid) {
      log.warn(
        { ip: req.ip, mode: 'hmac', hasHeader: provided !== undefined },
        'Webhook WAHA rejeitado: assinatura HMAC inválida (401)',
      );
      return reply.code(401).send({ error: 'unauthorized' });
    }
  }

  try {
    req.body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    log.warn({ ip: req.ip }, 'Webhook WAHA com JSON malformado (400)');
    return reply.code(400).send({ error: 'invalid_json' });
  }
};

export const wahaWebhookRoute: FastifyPluginAsync = async (app) => {
  // Parser de content-type ESCOPADO a este plugin (mesmo padrão do
  // webhook-abacatepay): entrega o Buffer CRU sem parsear — o HMAC é calculado
  // sobre os bytes exatos e o JSON.parse só acontece APÓS a assinatura validar
  // (hook preValidation acima). addContentTypeParser dentro de plugin não vaza
  // pro contexto global (encapsulamento do Fastify) — as demais rotas seguem
  // com o JSON parser default.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: MAX_BODY_BYTES },
    (_req, body, done) => {
      done(null, body);
    },
  );

  app.post(
    '/webhooks/waha',
    { onRequest: wahaWebhookAuth, preValidation: wahaWebhookParseAndVerify },
    async (req, reply) => {
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
      const result = await handleWebhook(parsed.data, { executionId, startedAt }).catch(
        async (e) => {
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
        },
      );

      return reply.send(result);
    },
  );
};
