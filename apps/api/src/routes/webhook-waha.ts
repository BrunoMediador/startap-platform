import { randomUUID } from 'node:crypto';
import { logger } from '@startap/core/logger';
import type { WahaWebhookBody as WahaWebhookBodyType } from '@startap/core/types';
import { WahaWebhookBody } from '@startap/core/types';
import { flowExecutionLog } from '@startap/db';
import type { FastifyPluginAsync, onRequestHookHandler, preValidationHookHandler } from 'fastify';
import { config } from '../config.js';
import { AsyncRunner } from '../lib/async-runner.js';
import { checkAndMarkDuplicate } from '../lib/idempotency.js';
import {
  WAHA_WEBHOOK_SECRET_HEADER,
  isWahaWebhookAuthorized,
  resolveWahaWebhookAuthMode,
  verifyWahaHmacSignature,
} from '../lib/webhook-auth.js';
import { handleWebhook } from '../router.js';

const log = logger.child({ module: 'webhook-waha' });

const MAX_BODY_BYTES = 5 * 1024 * 1024; // mesmo bodyLimit do app (server.ts)

// Teto de tempo do drain de tarefas in-flight no shutdown (ADR 0021). Mais
// generoso que o timeout por tarefa pra dar chance de a LLM em voo terminar; o
// que não drenar a tempo, a WAHA retenta (nada foi ACKeado lá).
const DRAIN_TIMEOUT_MS = 10_000;

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

/**
 * Loga o crash de um handleWebhook em flow_execution_logs (LGPD-safe — sem
 * payload) e devolve um status de erro. Compartilhado pelos caminhos síncrono e
 * assíncrono: no async, o crash NÃO derruba a request (já respondida), só é
 * registrado aqui.
 */
async function logWebhookCrash(
  err: unknown,
  body: WahaWebhookBodyType,
  ctx: { executionId: string; startedAt: number },
): Promise<{ status: string }> {
  log.error({ err }, 'Webhook handler crashed');
  await flowExecutionLog
    .logFlowEvent({
      executionId: ctx.executionId,
      session: body.session,
      eventType: 'webhook.crash',
      status: 'error',
      message: 'Webhook handler crashed',
      error: err,
      durationMs: Date.now() - ctx.startedAt,
    })
    .catch((logErr) => log.error({ err: logErr }, 'Falha ao logar webhook.crash'));
  return { status: 'error:crash' };
}

export const wahaWebhookRoute: FastifyPluginAsync = async (app) => {
  // Semáforo de concorrência do processamento ASSÍNCRONO (ADR 0021). Instanciado
  // SEMPRE (limites do config), mas só usado quando WEBHOOK_ASYNC=true. Com a flag
  // OFF é inerte. Escopado ao plugin — uma instância por processo da API.
  const asyncRunner = new AsyncRunner({
    maxInFlight: config.WEBHOOK_MAX_INFLIGHT,
    taskTimeoutMs: config.WEBHOOK_TASK_TIMEOUT_MS,
  });

  // Graceful shutdown (ADR 0021): no app.close() (SIGTERM/SIGINT em server.ts), o
  // runner para de aceitar e drena o in-flight com teto. O que não drenar a tempo,
  // a WAHA retenta. Com flag OFF não há in-flight → drain é no-op instantâneo.
  app.addHook('onClose', async () => {
    const remaining = await asyncRunner.drain(DRAIN_TIMEOUT_MS);
    log.info({ remaining }, 'Drain de tarefas async concluído');
  });

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

      // ── Caminho SÍNCRONO (WEBHOOK_ASYNC OFF, default) ──────────────────────
      // Comportamento ATUAL byte-a-byte: aguarda handleWebhook e responde com o
      // status. WAHA tem retries; retornamos 2xx mesmo se ignorarmos a mensagem.
      // O dedup roda DENTRO de handleWebhook (sem skipDedup), como hoje.
      if (!config.WEBHOOK_ASYNC) {
        const result = await handleWebhook(parsed.data, { executionId, startedAt }).catch((e) =>
          logWebhookCrash(e, parsed.data, { executionId, startedAt }),
        );
        return reply.send(result);
      }

      // ── Caminho ASSÍNCRONO (ADR 0021) ──────────────────────────────────────
      // ACK-early: responde 200 ao WAHA na hora e processa em background, fora do
      // ciclo HTTP, sob o semáforo. Sequência obrigatória (ADR 0021): HMAC →
      // parse → safeParse → DEDUP → ACK 200 → background.
      //
      // 1) DEDUP ANTES do ACK. Se a WAHA retentou (timeout/15×3s) e o evento já
      //    foi visto dentro do TTL, descartamos AQUI e respondemos 200 sem
      //    enfileirar de novo. É o que torna o ACK-early seguro: sem isto o ACK
      //    rápido amplia a janela em que o mesmo messageId entra 2x → 2 respostas
      //    / 2 eventos GCal. Fail-open: Redis down → degraded → processa mesmo
      //    assim (idempotência nunca cala o bot). O router recebe skipDedup=true
      //    pra não deduplicar de novo lá dentro.
      //    SCRUM-58: EXCEÇÃO pra `message.ack`. O dedup chaveia por (sessão, payload.id); num
      //    evento de ack o payload.id é o id da MENSAGEM ACKada — os vários acks do MESMO outbound
      //    (SERVER→DEVICE→READ) compartilham esse id e seriam colapsados pelo dedup (só o 1º
      //    passaria), matando o rastreio de entrega. Acks não geram resposta/efeito duplicável, então
      //    pulamos o dedup pra eles SÓ quando o rastreio está ON. Flag OFF = dedup roda como hoje
      //    (byte-idêntico) — de todo modo, com a flag OFF o router ignora o ack (ignored:event).
      const isAckDelivery =
        parsed.data.event === 'message.ack' && process.env.MESSAGE_ACK_TRACKING_ENABLED === 'true';
      const messageId = parsed.data.payload?.id ?? '';
      const dedup = isAckDelivery
        ? { duplicate: false as const, degraded: false as const }
        : await checkAndMarkDuplicate(parsed.data.session, messageId);
      if (dedup.duplicate) {
        log.info(
          { session: parsed.data.session },
          'Evento duplicado ignorado no ACK-early (dedup)',
        );
        await flowExecutionLog
          .logFlowEvent({
            executionId,
            session: parsed.data.session,
            eventType: 'router.ignored',
            status: 'ignored',
            message: 'Evento de mensagem duplicado ignorado (dedup ACK-early)',
            metadata: { reason: 'dedup', event: parsed.data.event },
            durationMs: Date.now() - startedAt,
          })
          .catch((e) => log.error({ err: e }, 'Falha ao logar dedup ACK-early'));
        return reply.code(200).send({ status: 'ignored:dedup' });
      }

      // 2) Tenta adquirir um slot no semáforo e agendar o processamento.
      //    skipDedup=true: o dedup acima já marcou o evento.
      const scheduled = asyncRunner.schedule(
        () =>
          handleWebhook(parsed.data, { executionId, startedAt, skipDedup: true }).then(
            () => undefined,
          ),
        (err) => {
          // Roda fora do ciclo HTTP (request já respondida); crash só é logado.
          if (err) void logWebhookCrash(err, parsed.data, { executionId, startedAt });
        },
      );

      // 3) SATURADO → política retry-503 (ADR 0021): responde 503 e a WAHA
      //    retenta (15×3s); a mensagem volta quando houver capacidade e o dedup
      //    evita duplicar. Nada se perde dentro da janela de retry. Se o pico
      //    durar mais que isso, é sinal de capacity planning (shard/2ª instância),
      //    não bug. NÃO enfileiramos em memória — o WAHA é a fila durável.
      if (!scheduled) {
        log.warn(
          { session: parsed.data.session, maxInFlight: config.WEBHOOK_MAX_INFLIGHT },
          'Webhook saturado — 503 (WAHA retenta)',
        );
        return reply.code(503).send({ status: 'busy:retry' });
      }

      // 4) ACK-early: 200 imediato. O processamento segue em background; bot.started
      //    /bot.finished e crash são logados de lá. ORDENAÇÃO POR CONVERSA: mensagens
      //    do mesmo cliente podem ser processadas em paralelo e responder fora de
      //    ordem (trade-off aceito, ADR 0021 §Risco 3 — raro no volume atual).
      return reply.code(200).send({ status: 'accepted' });
    },
  );
};
