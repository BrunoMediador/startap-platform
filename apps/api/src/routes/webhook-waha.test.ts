/**
 * Testes da rota POST /webhooks/waha — auth por secret compartilhado +
 * HMAC nativo do WAHA (P0 security — review do PR #268 + spike 2026-06-11).
 *
 * - config.js mockado (WAHA_WEBHOOK_SECRET / WAHA_WEBHOOK_HMAC_* controláveis
 *   por teste).
 * - @startap/db mockado (flowExecutionLog) e ../router.js mockado (handleWebhook):
 *   um 401 NÃO pode gerar NENHUM processamento — nem log de execução, nem router
 *   (logo, nem o gancho trial-pairing de session.status quando entrar).
 *
 * Cobre: sem env -> aceita tudo (retrocompat); header estático -> 401 sem header,
 * 401 header errado (mesmo tamanho e tamanho diferente — sem throw do
 * timingSafeEqual), 200 header certo; HMAC -> 401 sem/inválida assinatura, 200
 * assinatura válida sobre o raw body, precedência sobre o header estático;
 * nenhum efeito colateral antes da validação.
 */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'whsec_waha_route_test';
const HMAC_KEY = 'hmac_waha_route_test';

// vi.hoisted: a factory de vi.mock é içada ao topo — variáveis top-level normais
// não são acessíveis dentro dela.
const configState = vi.hoisted(() => ({
  secret: undefined as string | undefined,
  hmacKey: undefined as string | undefined,
  hmacHeader: 'x-webhook-hmac',
  hmacAlgorithm: 'sha512' as 'sha256' | 'sha512',
  // ADR 0021 — webhook async. Default OFF = caminho síncrono atual.
  webhookAsync: false,
  maxInFlight: 4,
  taskTimeoutMs: 0,
}));

vi.mock('../config.js', () => ({
  config: {
    get WAHA_WEBHOOK_SECRET() {
      return configState.secret;
    },
    get WAHA_WEBHOOK_HMAC_KEY() {
      return configState.hmacKey;
    },
    get WAHA_WEBHOOK_HMAC_HEADER() {
      return configState.hmacHeader;
    },
    get WAHA_WEBHOOK_HMAC_ALGORITHM() {
      return configState.hmacAlgorithm;
    },
    get WEBHOOK_ASYNC() {
      return configState.webhookAsync;
    },
    get WEBHOOK_MAX_INFLIGHT() {
      return configState.maxInFlight;
    },
    get WEBHOOK_TASK_TIMEOUT_MS() {
      return configState.taskTimeoutMs;
    },
  },
}));

const { handleWebhook, logFlowEvent, checkAndMarkDuplicate } = vi.hoisted(() => ({
  handleWebhook: vi.fn(),
  logFlowEvent: vi.fn(),
  checkAndMarkDuplicate: vi.fn(),
}));

vi.mock('../router.js', () => ({ handleWebhook }));

// Dedup (ADR 0019): no caminho async (ADR 0021) a ROTA roda o dedup antes do ACK.
vi.mock('../lib/idempotency.js', () => ({ checkAndMarkDuplicate }));

vi.mock('@startap/db', () => ({
  flowExecutionLog: { logFlowEvent },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import Fastify from 'fastify';
import { wahaWebhookRoute } from './webhook-waha.js';

/** Promise controlável: segura o handler "em voo" sem assign-in-expression. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function wahaBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: 'message',
    session: 'clone_teste',
    payload: { id: 'msg1', from: '5535999998888@c.us', fromMe: false, body: 'oi' },
    ...over,
  };
}

async function makeApp() {
  const app = Fastify({ logger: false });
  await app.register(wahaWebhookRoute);
  await app.ready();
  return app;
}

describe('POST /webhooks/waha — auth por secret compartilhado', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;

  beforeEach(async () => {
    configState.secret = undefined;
    configState.hmacKey = undefined;
    configState.hmacHeader = 'x-webhook-hmac';
    configState.hmacAlgorithm = 'sha512';
    configState.webhookAsync = false;
    configState.maxInFlight = 4;
    configState.taskTimeoutMs = 0;
    handleWebhook.mockReset();
    logFlowEvent.mockReset();
    checkAndMarkDuplicate.mockReset();
    handleWebhook.mockResolvedValue({ status: 'ok' });
    logFlowEvent.mockResolvedValue(undefined);
    checkAndMarkDuplicate.mockResolvedValue({ duplicate: false, degraded: false });
    app = await makeApp();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  describe('sem WAHA_WEBHOOK_SECRET (retrocompat — comportamento atual)', () => {
    it('aceita POST sem header e processa normalmente', async () => {
      const res = await app.inject({ method: 'POST', url: '/webhooks/waha', payload: wahaBody() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
      expect(handleWebhook).toHaveBeenCalledTimes(1);
    });

    it('aceita POST com header qualquer (header é ignorado sem env)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/waha',
        headers: { 'x-webhook-secret': 'qualquer' },
        payload: wahaBody(),
      });
      expect(res.statusCode).toBe(200);
      expect(handleWebhook).toHaveBeenCalledTimes(1);
    });
  });

  describe('com WAHA_WEBHOOK_SECRET configurado', () => {
    beforeEach(() => {
      configState.secret = SECRET;
    });

    it('sem header -> 401 e NENHUM processamento (nem flow_execution_log, nem router)', async () => {
      const res = await app.inject({ method: 'POST', url: '/webhooks/waha', payload: wahaBody() });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthorized' });
      expect(handleWebhook).not.toHaveBeenCalled();
      expect(logFlowEvent).not.toHaveBeenCalled();
    });

    it('header errado (mesmo tamanho) -> 401 sem processar', async () => {
      const wrong = `${SECRET.slice(0, -1)}X`;
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/waha',
        headers: { 'x-webhook-secret': wrong },
        payload: wahaBody(),
      });
      expect(res.statusCode).toBe(401);
      expect(handleWebhook).not.toHaveBeenCalled();
      expect(logFlowEvent).not.toHaveBeenCalled();
    });

    it('header errado (tamanho diferente) -> 401 sem throw (timing-safe com length mismatch)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/waha',
        headers: { 'x-webhook-secret': 'curto' },
        payload: wahaBody(),
      });
      expect(res.statusCode).toBe(401);
      expect(handleWebhook).not.toHaveBeenCalled();
    });

    it('header certo -> 200 e processa (router chamado com o payload parseado)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/waha',
        headers: { 'x-webhook-secret': SECRET },
        payload: wahaBody(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
      expect(handleWebhook).toHaveBeenCalledTimes(1);
      expect(handleWebhook.mock.calls[0]?.[0]).toMatchObject({
        event: 'message',
        session: 'clone_teste',
      });
    });

    it('header certo + payload inválido -> 200 ignored (comportamento atual preservado pós-auth)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/waha',
        headers: { 'x-webhook-secret': SECRET },
        payload: { nada: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ignored:invalid-payload' });
      expect(handleWebhook).not.toHaveBeenCalled();
    });

    it('evento session.status sem header -> 401 (gancho trial-pairing nunca alcançável sem secret)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/waha',
        payload: wahaBody({ event: 'session.status', payload: { status: 'WORKING' } }),
      });
      expect(res.statusCode).toBe(401);
      expect(handleWebhook).not.toHaveBeenCalled();
      expect(logFlowEvent).not.toHaveBeenCalled();
    });
  });

  describe('com WAHA_WEBHOOK_HMAC_KEY configurada (plano A — spike 2026-06-11)', () => {
    /** Assinatura HMAC hex sobre os bytes EXATOS do body (como o WAHA faz). */
    const sign = (raw: string, key = HMAC_KEY, alg: 'sha256' | 'sha512' = 'sha512') =>
      createHmac(alg, key).update(Buffer.from(raw, 'utf8')).digest('hex');

    /** POST com body raw string (controle total dos bytes assinados). */
    const post = (raw: string, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: '/webhooks/waha',
        headers: { 'content-type': 'application/json', ...headers },
        payload: raw,
      });

    beforeEach(() => {
      configState.hmacKey = HMAC_KEY;
    });

    it('sem header de assinatura -> 401 e NENHUM processamento', async () => {
      const res = await post(JSON.stringify(wahaBody()));
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthorized' });
      expect(handleWebhook).not.toHaveBeenCalled();
      expect(logFlowEvent).not.toHaveBeenCalled();
    });

    it('assinatura inválida -> 401 sem processar', async () => {
      const raw = JSON.stringify(wahaBody());
      const res = await post(raw, { 'x-webhook-hmac': sign(raw, 'key-errada') });
      expect(res.statusCode).toBe(401);
      expect(handleWebhook).not.toHaveBeenCalled();
      expect(logFlowEvent).not.toHaveBeenCalled();
    });

    it('body adulterado após assinar -> 401 (integridade do raw body)', async () => {
      const raw = JSON.stringify(wahaBody());
      const signature = sign(raw);
      const tampered = raw.replace('"oi"', '"OI"');
      const res = await post(tampered, { 'x-webhook-hmac': signature });
      expect(res.statusCode).toBe(401);
      expect(handleWebhook).not.toHaveBeenCalled();
    });

    it('assinatura válida sobre o raw body -> 200 e processa (payload parseado chega no router)', async () => {
      const raw = JSON.stringify(wahaBody());
      const res = await post(raw, { 'x-webhook-hmac': sign(raw) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
      expect(handleWebhook).toHaveBeenCalledTimes(1);
      expect(handleWebhook.mock.calls[0]?.[0]).toMatchObject({
        event: 'message',
        session: 'clone_teste',
      });
    });

    it('HMAC governa SOZINHO: header estático correto NÃO substitui assinatura ausente', async () => {
      configState.secret = SECRET;
      const res = await post(JSON.stringify(wahaBody()), { 'x-webhook-secret': SECRET });
      expect(res.statusCode).toBe(401);
      expect(handleWebhook).not.toHaveBeenCalled();
    });

    it('assinatura válida + payload Zod-inválido -> 200 ignored (comportamento pós-auth preservado)', async () => {
      const raw = JSON.stringify({ nada: true });
      const res = await post(raw, { 'x-webhook-hmac': sign(raw) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ignored:invalid-payload' });
      expect(handleWebhook).not.toHaveBeenCalled();
    });

    it('assinatura válida + JSON malformado -> 400 invalid_json (mesmo status do parser default)', async () => {
      const raw = '{"quebrado":';
      const res = await post(raw, { 'x-webhook-hmac': sign(raw) });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_json' });
      expect(handleWebhook).not.toHaveBeenCalled();
    });

    it('header/algoritmo configuráveis (contingência se a cobaia revelar nomes diferentes)', async () => {
      configState.hmacHeader = 'x-hub-signature';
      configState.hmacAlgorithm = 'sha256';
      const raw = JSON.stringify(wahaBody());
      const res = await post(raw, { 'x-hub-signature': sign(raw, HMAC_KEY, 'sha256') });
      expect(res.statusCode).toBe(200);
      expect(handleWebhook).toHaveBeenCalledTimes(1);
    });
  });

  describe('JSON malformado sem auth configurada (parser escopado em Buffer)', () => {
    it('-> 400 (mesmo status do parser JSON default do Fastify; WAHA retenta igual)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/waha',
        headers: { 'content-type': 'application/json' },
        payload: '{"quebrado":',
      });
      expect(res.statusCode).toBe(400);
      expect(handleWebhook).not.toHaveBeenCalled();
    });
  });

  // ── WEBHOOK_ASYNC (ADR 0021) ───────────────────────────────────────────────
  describe('WEBHOOK_ASYNC OFF (default) — caminho síncrono idêntico ao atual', () => {
    it('aguarda handleWebhook e responde com o status dele (200 {status:ok})', async () => {
      handleWebhook.mockResolvedValue({ status: 'ok' });
      const res = await app.inject({ method: 'POST', url: '/webhooks/waha', payload: wahaBody() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
      expect(handleWebhook).toHaveBeenCalledTimes(1);
      // No síncrono a rota NÃO roda dedup (corre dentro do router) nem passa skipDedup.
      expect(checkAndMarkDuplicate).not.toHaveBeenCalled();
      expect(handleWebhook.mock.calls[0]?.[1]).not.toHaveProperty('skipDedup');
    });

    it('crash do handler -> 200 {status:error:crash} (comportamento atual)', async () => {
      handleWebhook.mockRejectedValue(new Error('boom'));
      const res = await app.inject({ method: 'POST', url: '/webhooks/waha', payload: wahaBody() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'error:crash' });
    });
  });

  describe('WEBHOOK_ASYNC ON — ACK-early + processamento em background', () => {
    beforeEach(() => {
      configState.webhookAsync = true;
    });

    it('responde 200 {status:accepted} imediatamente e processa em background com skipDedup', async () => {
      // handleWebhook segura: o ACK não pode esperar por ele.
      const handler = deferred<{ status: string }>();
      handleWebhook.mockReturnValue(handler.promise);

      const res = await app.inject({ method: 'POST', url: '/webhooks/waha', payload: wahaBody() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'accepted' });
      // Dedup rodou ANTES do ACK; o background recebeu skipDedup=true.
      expect(checkAndMarkDuplicate).toHaveBeenCalledTimes(1);
      expect(handleWebhook).toHaveBeenCalledTimes(1);
      expect(handleWebhook.mock.calls[0]?.[1]).toMatchObject({ skipDedup: true });

      handler.resolve({ status: 'ok' }); // libera a tarefa em voo
    });

    it('dedup ANTES do ACK: evento duplicado -> 200 {status:ignored:dedup} sem chamar o router', async () => {
      checkAndMarkDuplicate.mockResolvedValue({ duplicate: true, degraded: false });
      const res = await app.inject({ method: 'POST', url: '/webhooks/waha', payload: wahaBody() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ignored:dedup' });
      expect(handleWebhook).not.toHaveBeenCalled();
    });

    it('semáforo cheio -> 503 {status:busy:retry} (política retry-503; WAHA retenta)', async () => {
      configState.maxInFlight = 1;
      const app1 = await makeApp(); // app com maxInFlight=1
      try {
        // 1ª mensagem segura o único slot.
        const slot = deferred<{ status: string }>();
        handleWebhook.mockReturnValue(slot.promise);
        const first = await app1.inject({
          method: 'POST',
          url: '/webhooks/waha',
          payload: wahaBody({ payload: { id: 'm1', from: '5535999998888@c.us', body: 'a' } }),
        });
        expect(first.statusCode).toBe(200);
        expect(first.json()).toEqual({ status: 'accepted' });

        // 2ª mensagem (id diferente p/ não cair no dedup) — slot cheio -> 503.
        const second = await app1.inject({
          method: 'POST',
          url: '/webhooks/waha',
          payload: wahaBody({ payload: { id: 'm2', from: '5535999998888@c.us', body: 'b' } }),
        });
        expect(second.statusCode).toBe(503);
        expect(second.json()).toEqual({ status: 'busy:retry' });

        slot.resolve({ status: 'ok' });
      } finally {
        await app1.close();
      }
    });

    it('503 por saturação não consome o dedup: retry do mesmo messageId processa exatamente uma vez', async () => {
      configState.maxInFlight = 4;
      const app1 = await makeApp();
      const blockers = Array.from({ length: 4 }, () => deferred<{ status: string }>());
      const seen = new Set<string>();

      checkAndMarkDuplicate.mockImplementation(async (session: string, messageId: string) => {
        const key = `${session}:${messageId}`;
        if (seen.has(key)) return { duplicate: true, degraded: false };
        seen.add(key);
        return { duplicate: false, degraded: false };
      });
      handleWebhook.mockImplementation(async (body: { payload?: { id?: string } }) => {
        const id = body.payload?.id ?? '';
        const blockerIndex = Number(id.slice(1)) - 1;
        if (blockerIndex >= 0 && blockerIndex < blockers.length) {
          return blockers[blockerIndex].promise;
        }
        return { status: 'ok' };
      });

      try {
        for (let index = 1; index <= 4; index += 1) {
          const accepted = await app1.inject({
            method: 'POST',
            url: '/webhooks/waha',
            payload: wahaBody({
              payload: { id: `m${index}`, from: '5535999998888@c.us', body: `${index}` },
            }),
          });
          expect(accepted.statusCode).toBe(200);
        }

        const saturated = await app1.inject({
          method: 'POST',
          url: '/webhooks/waha',
          payload: wahaBody({ payload: { id: 'm5', from: '5535999998888@c.us', body: '5' } }),
        });
        expect(saturated.statusCode).toBe(503);
        expect(saturated.json()).toEqual({ status: 'busy:retry' });

        blockers[0].resolve({ status: 'ok' });
        await new Promise<void>((resolve) => setImmediate(resolve));

        const retry = await app1.inject({
          method: 'POST',
          url: '/webhooks/waha',
          payload: wahaBody({ payload: { id: 'm5', from: '5535999998888@c.us', body: '5' } }),
        });
        expect(retry.statusCode).toBe(200);
        expect(retry.json()).toEqual({ status: 'accepted' });
        // 4 admitidas + retry admitido; a tentativa que recebeu 503 não tocou no Redis.
        expect(checkAndMarkDuplicate).toHaveBeenCalledTimes(5);
        await vi.waitFor(() => {
          expect(
            handleWebhook.mock.calls.filter(([body]) => body.payload?.id === 'm5'),
          ).toHaveLength(1);
        });
      } finally {
        for (const blocker of blockers) blocker.resolve({ status: 'ok' });
        await app1.close();
      }
    });

    it('graceful drain: app.close() espera a tarefa em voo terminar', async () => {
      let release!: () => void;
      const handled = new Promise<void>((r) => {
        release = r;
      });
      handleWebhook.mockImplementation(async () => {
        await handled;
        return { status: 'ok' };
      });

      const app2 = await makeApp();
      const res = await app2.inject({ method: 'POST', url: '/webhooks/waha', payload: wahaBody() });
      expect(res.statusCode).toBe(200);

      // close() dispara o onClose hook (drain). Liberamos a tarefa logo depois.
      const closing = app2.close();
      release();
      await closing; // não deve travar — drena dentro do teto
      expect(handleWebhook).toHaveBeenCalledTimes(1);
    });
  });
});
