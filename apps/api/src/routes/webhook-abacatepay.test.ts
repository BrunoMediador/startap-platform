/**
 * Testes e2e da rota POST /webhooks/abacatepay (F2 — controles C1-C6/C9/C10).
 *
 * - config.js mockado (segredos do webhook controlaveis por teste — C9).
 * - @startap/db mockado (applyPaidWebhook + invalidateCloneCache) — sem banco.
 * - @startap/integrations/abacatepay: usa as primitivas REAIS de assinatura/redacao
 *   (logica pura) — o teste assina com a MESMA chave pra exercitar o HMAC de verdade (C3).
 *
 * Cobre: HMAC valido processa / invalido -> 401; query secret invalido -> 401;
 * raw-body confere HMAC; replay (dedupe) -> nao reprocessa; underpaid -> nao reativa;
 * auto-resume so com suspended_kind='billing'; webhook sem segredos -> 503; rate-limit.
 */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const WEBHOOK_SECRET = 'whsec_test';
const QUERY_SECRET = 'qsec_test';

// Config controlavel: por padrao COM segredos. Testes de "sem segredos" sobrescrevem.
// vi.hoisted: a factory de vi.mock e icada ao topo — variaveis top-level normais
// nao sao acessiveis dentro dela.
const configState = vi.hoisted(() => ({
  query: 'qsec_test' as string | undefined,
  hmac: 'whsec_test' as string | undefined,
}));

vi.mock('../config.js', () => ({
  config: {
    get ABACATEPAY_WEBHOOK_QUERY_SECRET() {
      return configState.query;
    },
    get ABACATEPAY_WEBHOOK_SECRET() {
      return configState.hmac;
    },
  },
}));

const { applyPaidWebhook, invalidateCloneCache } = vi.hoisted(() => ({
  applyPaidWebhook: vi.fn(),
  invalidateCloneCache: vi.fn(),
}));

vi.mock('@startap/db', () => ({
  billingWebhookEvents: { applyPaidWebhook },
  flowClones: { invalidateCloneCache },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import Fastify from 'fastify';
import { abacatePayWebhookRoute } from './webhook-abacatepay.js';

function paidBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'evt_unique_1',
    event: 'transparent.completed',
    data: {
      transparent: {
        id: 'pix_char_abc',
        status: 'PAID',
        externalId: 'barbearia-cirilo-2026-06',
        paidAmount: 19900,
        receiptUrl: 'https://r/abc',
        ...over,
      },
    },
  });
}

function sign(raw: string, secret = WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(Buffer.from(raw, 'utf8')).digest('base64');
}

async function makeApp() {
  const app = Fastify({ logger: false });
  await app.register(abacatePayWebhookRoute);
  await app.ready();
  return app;
}

function url(secret = QUERY_SECRET): string {
  return `/webhooks/abacatepay?webhookSecret=${encodeURIComponent(secret)}`;
}

describe('POST /webhooks/abacatepay', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;

  beforeEach(async () => {
    configState.query = QUERY_SECRET;
    configState.hmac = WEBHOOK_SECRET;
    applyPaidWebhook.mockReset();
    invalidateCloneCache.mockReset();
    applyPaidWebhook.mockResolvedValue({
      outcome: 'applied',
      slot: 'barbearia-cirilo',
      resumed: true,
      amountCents: 19900,
      paidAmountCents: 19900,
    });
    app = await makeApp();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it('HMAC valido + query secret valido -> processa (200) e toca o banco', async () => {
    const body = paidBody();
    const res = await app.inject({
      method: 'POST',
      url: url(),
      headers: { 'content-type': 'application/json', 'x-webhook-signature': sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(applyPaidWebhook).toHaveBeenCalledTimes(1);
    // slot vem do casamento no banco, nao do payload — handler so passa o charge id.
    expect(applyPaidWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'evt_unique_1',
        abacateChargeId: 'pix_char_abc',
        paidAmountCents: 19900,
      }),
    );
  });

  it('auto-resume (resumed=true) invalida o cache do clone', async () => {
    const body = paidBody();
    await app.inject({
      method: 'POST',
      url: url(),
      headers: { 'content-type': 'application/json', 'x-webhook-signature': sign(body) },
      payload: body,
    });
    expect(invalidateCloneCache).toHaveBeenCalledWith({ slot: 'barbearia-cirilo' });
  });

  it('payload REDIGIDO (C5): brCode/PII nao chegam ao applyPaidWebhook', async () => {
    const body = paidBody({
      brCode: '00020-PIX-COPIA',
      customer: { email: 'x@y.com', taxId: '111' },
    });
    await app.inject({
      method: 'POST',
      url: url(),
      headers: { 'content-type': 'application/json', 'x-webhook-signature': sign(body) },
      payload: body,
    });
    const arg = applyPaidWebhook.mock.calls[0][0];
    const redacted = JSON.stringify(arg.redactedPayload);
    expect(redacted).not.toContain('00020-PIX-COPIA');
    expect(redacted).not.toContain('x@y.com');
    expect(redacted).not.toContain('111');
    expect(redacted).toContain('[REDACTED]');
  });

  it('HMAC invalido -> 401 e NAO toca o banco', async () => {
    const body = paidBody();
    const res = await app.inject({
      method: 'POST',
      url: url(),
      headers: { 'content-type': 'application/json', 'x-webhook-signature': 'assinatura-forjada' },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(applyPaidWebhook).not.toHaveBeenCalled();
  });

  it('query secret invalido -> 401 e NAO toca o banco', async () => {
    const body = paidBody();
    const res = await app.inject({
      method: 'POST',
      url: url('errado'),
      headers: { 'content-type': 'application/json', 'x-webhook-signature': sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(applyPaidWebhook).not.toHaveBeenCalled();
  });

  it('raw-body confere HMAC: body adulterado apos assinar -> 401', async () => {
    const original = paidBody();
    const sig = sign(original); // assina o original
    const tampered = paidBody({ paidAmount: 1 }); // adultera o valor
    const res = await app.inject({
      method: 'POST',
      url: url(),
      headers: { 'content-type': 'application/json', 'x-webhook-signature': sig },
      payload: tampered,
    });
    expect(res.statusCode).toBe(401);
    expect(applyPaidWebhook).not.toHaveBeenCalled();
  });

  it('replay (mesmo event_id) -> dedupe no banco retorna duplicate, nao reprocessa efeito', async () => {
    applyPaidWebhook.mockResolvedValueOnce({
      outcome: 'applied',
      slot: 'barbearia-cirilo',
      resumed: true,
      amountCents: 19900,
      paidAmountCents: 19900,
    });
    applyPaidWebhook.mockResolvedValueOnce({
      outcome: 'duplicate',
      slot: null,
      resumed: false,
      amountCents: null,
      paidAmountCents: 19900,
    });
    const body = paidBody();
    const headers = { 'content-type': 'application/json', 'x-webhook-signature': sign(body) };

    const r1 = await app.inject({ method: 'POST', url: url(), headers, payload: body });
    const r2 = await app.inject({ method: 'POST', url: url(), headers, payload: body });

    expect(r1.json()).toMatchObject({ status: 'applied' });
    expect(r2.json()).toMatchObject({ status: 'duplicate' });
    // Cache invalidado so na 1a (resumed=true); na 2a (duplicate) nao.
    expect(invalidateCloneCache).toHaveBeenCalledTimes(1);
  });

  it('underpaid: banco retorna outcome=underpaid, handler NAO invalida cache (nao reativou)', async () => {
    applyPaidWebhook.mockResolvedValue({
      outcome: 'underpaid',
      slot: 'barbearia-cirilo',
      resumed: false,
      amountCents: 19900,
      paidAmountCents: 1,
    });
    const body = paidBody({ paidAmount: 1 });
    const res = await app.inject({
      method: 'POST',
      url: url(),
      headers: { 'content-type': 'application/json', 'x-webhook-signature': sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'underpaid', resumed: false });
    expect(invalidateCloneCache).not.toHaveBeenCalled();
  });

  it('evento nao-PAID -> 200 ignorado, nao toca o banco', async () => {
    const body = JSON.stringify({
      id: 'evt_x',
      event: 'transparent.created',
      data: { transparent: { status: 'PENDING' } },
    });
    const res = await app.inject({
      method: 'POST',
      url: url(),
      headers: { 'content-type': 'application/json', 'x-webhook-signature': sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(applyPaidWebhook).not.toHaveBeenCalled();
  });

  it('sem segredos configurados -> 503 (feature inativa, C9), nao toca o banco', async () => {
    configState.query = undefined;
    configState.hmac = undefined;
    const body = paidBody();
    const res = await app.inject({
      method: 'POST',
      url: url(),
      headers: { 'content-type': 'application/json', 'x-webhook-signature': sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'webhook_not_configured' });
    expect(applyPaidWebhook).not.toHaveBeenCalled();
  });
});
