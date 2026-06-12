/**
 * Testes da rota POST /webhooks/waha — auth por secret compartilhado
 * (P0 security — review do PR #268).
 *
 * - config.js mockado (WAHA_WEBHOOK_SECRET controlável por teste).
 * - @startap/db mockado (flowExecutionLog) e ../router.js mockado (handleWebhook):
 *   um 401 NÃO pode gerar NENHUM processamento — nem log de execução, nem router
 *   (logo, nem o gancho trial-pairing de session.status quando entrar).
 *
 * Cobre: sem env -> aceita tudo (retrocompat); com env -> 401 sem header, 401
 * header errado (mesmo tamanho e tamanho diferente — sem throw do timingSafeEqual),
 * 200 header certo; nenhum efeito colateral antes da validação.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'whsec_waha_route_test';

// vi.hoisted: a factory de vi.mock é içada ao topo — variáveis top-level normais
// não são acessíveis dentro dela.
const configState = vi.hoisted(() => ({
  secret: undefined as string | undefined,
}));

vi.mock('../config.js', () => ({
  config: {
    get WAHA_WEBHOOK_SECRET() {
      return configState.secret;
    },
  },
}));

const { handleWebhook, logFlowEvent } = vi.hoisted(() => ({
  handleWebhook: vi.fn(),
  logFlowEvent: vi.fn(),
}));

vi.mock('../router.js', () => ({ handleWebhook }));

vi.mock('@startap/db', () => ({
  flowExecutionLog: { logFlowEvent },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import Fastify from 'fastify';
import { wahaWebhookRoute } from './webhook-waha.js';

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
    handleWebhook.mockReset();
    logFlowEvent.mockReset();
    handleWebhook.mockResolvedValue({ status: 'ok' });
    logFlowEvent.mockResolvedValue(undefined);
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
});
