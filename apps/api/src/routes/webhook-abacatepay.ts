/**
 * POST /webhooks/abacatepay — confirmacao de pagamento PIX (ADR 0013, F2).
 *
 * Server-to-server (NAO portal-api — C10). Mora em apps/api porque o portal-api roda
 * withTenant global; aqui o slot vem SEMPRE do registro de billing_charges casado pelo
 * abacateChargeId do payload, nunca de input livre (anti-spoof do slot).
 *
 * Pipeline de validacao na ORDEM exigida (C6) — falha em QUALQUER etapa -> 401 generico,
 * sem revelar qual etapa, sem tocar o banco:
 *   0. Config presente? Senao 503 (segredos nao provisionados — feature inativa, C9).
 *   1. Rate-limit dedicado (C6) — martelar nao recomputa HMAC infinito.
 *   2. Query secret ?webhookSecret= (timingSafeEqual, C6).
 *   3. Header X-Webhook-Signature = HMAC-SHA256 base64 sobre o RAW BODY (C3/C6).
 *   4. SO ENTAO parseia e toca o banco (applyPaidWebhook — transacional, C1/C2/C4).
 *
 * Raw body ESCOPADO (C3): este plugin registra seu proprio content-type parser que
 * guarda o Buffer cru em req.rawBody. NAO afeta o JSON parser global nem o webhook-waha
 * (parser de Fastify e encapsulado por contexto de plugin).
 *
 * C5 (LGPD): o payload e REDIGIDO (redactWebhookPayload) antes de ir pra
 * billing_webhook_events; logs nunca imprimem brCode/CPF/email/telefone/receipt_url.
 */
import { logger } from '@startap/core/logger';
import { billingWebhookEvents, flowClones } from '@startap/db';
// Subpath dedicado (./abacatepay) — carrega SO o modulo de pagamento, sem puxar o
// barrel do integrations (openai/agent instancia o client no load e exige OPENAI_API_KEY).
// As primitivas de webhook (verify/redact/parse) sao logica pura em ./abacatepay/webhook.
import {
  parseWebhookEvent,
  redactWebhookPayload,
  verifyWebhookSecret,
  verifyWebhookSignature,
} from '@startap/integrations/abacatepay';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { config } from '../config.js';

const log = logger.child({ module: 'webhook-abacatepay' });

const SIGNATURE_HEADER = 'x-webhook-signature';
const MAX_BODY_BYTES = 256 * 1024; // payload de webhook e pequeno; limita superficie

// ── Rate-limit dedicado em memoria (C6) ─────────────────────────────────────────
// Sem dependencia nova: janela deslizante simples por origem. apps/api roda como
// instancia unica (server-to-server) — suficiente pra barrar martelada de HMAC.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60; // 60 req/min por origem
const rateBuckets = new Map<string, number[]>();

function rateLimited(key: string, now = Date.now()): boolean {
  const hits = (rateBuckets.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  rateBuckets.set(key, hits);
  // Limpeza preguicosa pra nao vazar memoria com chaves antigas.
  if (rateBuckets.size > 1000) {
    for (const [k, ts] of rateBuckets) {
      if (ts.every((t) => now - t >= RATE_WINDOW_MS)) rateBuckets.delete(k);
    }
  }
  return hits.length > RATE_MAX;
}

interface RawBodyRequest extends FastifyRequest {
  rawBody?: Buffer;
}

export const abacatePayWebhookRoute: FastifyPluginAsync = async (app) => {
  // Parser de content-type ESCOPADO a este plugin (C3). Guarda o buffer cru em
  // req.rawBody SEM parsear JSON — o HMAC e sobre o cru. addContentTypeParser num
  // plugin so afeta o contexto encapsulado deste plugin; o parser global do app e
  // o webhook-waha permanecem intactos.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: MAX_BODY_BYTES },
    (_req, body, done) => {
      // body ja vem como Buffer (parseAs: 'buffer'). Nao parseia JSON aqui —
      // a rota valida o HMAC sobre o cru e so depois faz JSON.parse.
      done(null, body);
    },
  );

  app.post('/webhooks/abacatepay', async (req: RawBodyRequest, reply) => {
    // ── (0) Config presente? Feature inativa sem segredos -> 503 claro (C9). ──────
    const querySecret = config.ABACATEPAY_WEBHOOK_QUERY_SECRET;
    const hmacSecret = config.ABACATEPAY_WEBHOOK_SECRET;
    if (!querySecret || !hmacSecret) {
      log.warn('webhook AbacatePay chamado sem segredos configurados — feature inativa');
      return reply.code(503).send({ error: 'webhook_not_configured' });
    }

    // ── (1) Rate-limit dedicado (C6). ────────────────────────────────────────────
    const origin = req.ip ?? 'unknown';
    if (rateLimited(origin)) {
      log.warn({ origin }, 'webhook AbacatePay rate-limited');
      return reply.code(429).send({ error: 'rate_limited' });
    }

    const rawBody = req.rawBody ?? (Buffer.isBuffer(req.body) ? (req.body as Buffer) : null);
    if (!rawBody || rawBody.length === 0) {
      // Sem corpo cru nao ha como validar HMAC. 401 generico (nao revela motivo).
      return reply.code(401).send({ error: 'unauthorized' });
    }

    // ── (2) Query secret (timing-safe). ──────────────────────────────────────────
    const provided =
      typeof (req.query as Record<string, unknown>)?.webhookSecret === 'string'
        ? (req.query as Record<string, string>).webhookSecret
        : undefined;
    const okQuery = verifyWebhookSecret(provided, querySecret);

    // ── (3) HMAC sobre o RAW BODY (timing-safe). ─────────────────────────────────
    const sigHeader = req.headers[SIGNATURE_HEADER];
    const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    const okSig = verifyWebhookSignature(rawBody, sig, hmacSecret);

    // 401 GENERICO se qualquer um falhar — nao distingue qual (C6). Nao toca o banco.
    if (!okQuery || !okSig) {
      log.warn({ origin }, 'webhook AbacatePay rejeitado (assinatura/secret invalido)');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    // ── (4) Assinatura OK. Agora parseia o corpo cru e processa. ─────────────────
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody.toString('utf8'));
    } catch {
      log.warn({ origin }, 'webhook AbacatePay com JSON invalido apos assinatura valida');
      return reply.code(400).send({ error: 'invalid_json' });
    }

    const evt = parseWebhookEvent(parsedJson);
    if (!evt) {
      // Sem event_id nao ha dedupe (C4). Aceita com 200 pra nao gerar retry infinito.
      log.warn({ origin }, 'webhook AbacatePay sem event_id — ignorado');
      return reply.code(200).send({ status: 'ignored:no-event-id' });
    }

    // So tratamos conclusao com PAID. Outros eventos sao reconhecidos (200) sem efeito.
    const isPaid = evt.event === 'transparent.completed' && evt.status === 'paid';
    if (!isPaid) {
      log.info(
        { event: evt.event, status: evt.status },
        'webhook AbacatePay nao-PAID — reconhecido',
      );
      return reply.code(200).send({ status: 'ignored:not-paid' });
    }

    if (!evt.abacateChargeId) {
      log.warn({ eventId: evt.eventId }, 'webhook PAID sem charge id — orfao');
      return reply.code(200).send({ status: 'ignored:no-charge-id' });
    }
    if (evt.paidAmountCents == null) {
      log.warn({ eventId: evt.eventId }, 'webhook PAID sem valor pago — ignorado');
      return reply.code(200).send({ status: 'ignored:no-amount' });
    }

    // C5: redige PII ANTES de mandar pro banco (billing_webhook_events.payload).
    const redactedPayload = redactWebhookPayload(parsedJson);

    try {
      const result = await billingWebhookEvents.applyPaidWebhook({
        eventId: evt.eventId,
        event: evt.event,
        abacateChargeId: evt.abacateChargeId,
        paidAmountCents: evt.paidAmountCents,
        receiptUrl: evt.receiptUrl,
        redactedPayload,
        actor: 'abacatepay-webhook',
      });

      if (result.resumed && result.slot) {
        // Invalida o cache in-process do router (TTL 60s) pro bot voltar a responder
        // imediatamente apos o auto-resume, sem esperar o TTL expirar.
        flowClones.invalidateCloneCache({ slot: result.slot });
      }

      if (result.outcome === 'underpaid') {
        // C2: pago a MENOS que o snapshot. Marcou pago mas NAO avancou/reativou.
        // Alerta pro Bruno tratar manual (NUNCA imprime PII).
        log.error(
          {
            alert: 'billing-underpaid',
            slot: result.slot,
            expectedCents: result.amountCents,
            paidCents: result.paidAmountCents,
            eventId: evt.eventId,
          },
          'PAGAMENTO PIX ABAIXO DO VALOR — vencimento NAO avancado, fluxo NAO reativado. Revisar manual.',
        );
      } else {
        log.info(
          {
            outcome: result.outcome,
            slot: result.slot,
            resumed: result.resumed,
            eventId: evt.eventId,
          },
          'webhook PAID processado',
        );
      }

      // 200 so apos sucesso. Retries do gateway sao cobertos pelo dedupe (C4).
      return reply.code(200).send({ status: result.outcome, resumed: result.resumed });
    } catch (err: unknown) {
      // Erro real (banco etc.): 500 pra o gateway RETENTAR (o dedupe garante que o
      // retry nao duplica efeito). Nunca loga PII.
      log.error({ err, eventId: evt.eventId }, 'falha ao processar webhook PAID');
      return reply.code(500).send({ error: 'processing_failed' });
    }
  });
};
