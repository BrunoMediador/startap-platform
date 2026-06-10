/**
 * Testes das rotas de mensalidade do portal (ADR 0013, F3).
 *
 * DB e o client AbacatePay sao MOCKADOS — nada bate em banco/gateway real.
 * Foco: shape do GET, valor do banco no POST /pix (e 409 sem valor), guard Dev-only
 * do /simular, e o invariante anti-IDOR (slot SEMPRE da sessao, controle C8).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// config.js valida process.env no import — mockamos. dev_mode = chave abc_dev_*.
vi.mock('../config.js', () => ({
  config: {
    NODE_ENV: 'test',
    ABACATEPAY_API_KEY: 'abc_dev_xyz',
    ABACATEPAY_BASE_URL: 'https://api.abacatepay.com',
  },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('@startap/db', () => ({
  clientBilling: {
    getBillingBySlot: vi.fn(),
    daysUntilDue: vi.fn(),
  },
  billingCharges: {
    getCharge: vi.fn(),
  },
}));

// Client AbacatePay + service mockados. vi.hoisted leva os mocks pro topo junto com
// vi.mock (que e hoisted) — evita "cannot access before initialization".
const { simulatePaymentMock, ensureMock } = vi.hoisted(() => ({
  simulatePaymentMock: vi.fn(),
  ensureMock: vi.fn(),
}));
vi.mock('@startap/integrations', () => {
  class FakeNotConfigured extends Error {}
  return {
    abacatepay: {
      AbacatePayClient: class {
        apiKey: string | undefined;
        constructor(cfg: { apiKey: string | undefined }) {
          if (!cfg.apiKey) throw new FakeNotConfigured('sem key');
          this.apiKey = cfg.apiKey;
        }
        simulatePayment(id: string) {
          return simulatePaymentMock(id);
        }
      },
      AbacatePayNotConfiguredError: FakeNotConfigured,
      ensurePixChargeForCycle: (...args: unknown[]) => ensureMock(...args),
    },
  };
});

// withTenant stub: injeta tenant fixo (slot da sessao). A auth real vive em tenant.test.ts.
let injectedSlot = 'clone_x';
vi.mock('../lib/tenant.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/tenant.js')>('../lib/tenant.js');
  return {
    ...actual,
    withTenant: vi.fn(async (req: { tenant?: unknown }) => {
      req.tenant = { slot: injectedSlot, userId: 7, username: 'cirilo', sid: 'sid-atual' };
    }),
  };
});

import { billingCharges, clientBilling } from '@startap/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { cicloAtual, portalBillingRoutes } from './portal-billing.js';

const getBillingMock = vi.mocked(clientBilling.getBillingBySlot);
const daysUntilDueMock = vi.mocked(clientBilling.daysUntilDue);
const getChargeMock = vi.mocked(billingCharges.getCharge);

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalBillingRoutes);
  await app.ready();
  return app;
}

function makeBilling(over: Partial<Record<string, unknown>> = {}) {
  return {
    slot: 'clone_x',
    next_due_date: '2026-07-10',
    amount_cents: 19900,
    last_payment_at: null,
    status: 'active',
    notes: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
    // biome-ignore lint/suspicious/noExplicitAny: fixture de teste
  } as any;
}

function makeCharge(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: '1',
    slot: 'clone_x',
    cycle: cicloAtual(),
    external_id: `clone_x-${cicloAtual()}`,
    abacate_charge_id: 'pix_char_abc',
    amount_cents: 19900,
    paid_amount_cents: null,
    status: 'pending',
    br_code: '00020126...PIX',
    br_code_base64: 'data:image/png;base64,AAAA',
    expires_at: new Date('2026-07-13T10:00:00.000Z'),
    paid_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
    // biome-ignore lint/suspicious/noExplicitAny: fixture de teste
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  injectedSlot = 'clone_x';
});

// ── cicloAtual (helper puro) ──────────────────────────────────────────────────
describe('cicloAtual', () => {
  it('formata YYYY-MM no fuso America/Sao_Paulo', () => {
    // 2026-07-01 02:00 UTC = 2026-06-30 23:00 BRT -> ciclo do mes de junho.
    expect(cicloAtual(new Date('2026-07-01T02:00:00.000Z'))).toBe('2026-06');
    // 2026-07-01 12:00 UTC = 2026-07-01 09:00 BRT -> julho.
    expect(cicloAtual(new Date('2026-07-01T12:00:00.000Z'))).toBe('2026-07');
  });
});

// ── GET /portal/mensalidade ───────────────────────────────────────────────────
describe('GET /portal/mensalidade', () => {
  it('200 com o shape completo (billing + charge do ciclo + dev_mode)', async () => {
    getBillingMock.mockResolvedValue(makeBilling());
    daysUntilDueMock.mockReturnValue(12);
    getChargeMock.mockResolvedValue(makeCharge());

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/mensalidade' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      amount_cents: 19900,
      next_due_date: '2026-07-10',
      dias_restantes: 12,
      billing_status: 'active',
      charge: {
        cycle: cicloAtual(),
        status: 'pending',
        br_code: '00020126...PIX',
        br_code_base64: 'data:image/png;base64,AAAA',
        expires_at: '2026-07-13T10:00:00.000Z',
        paid_at: null,
      },
      dev_mode: true, // chave abc_dev_* no mock
    });
    // ISOLAMENTO: a query usa o slot da sessao, nunca input.
    expect(getBillingMock).toHaveBeenCalledWith('clone_x');
    expect(getChargeMock).toHaveBeenCalledWith('clone_x', cicloAtual());
    await app.close();
  });

  it('200 com nulls quando nao ha billing nem cobranca', async () => {
    getBillingMock.mockResolvedValue(null);
    getChargeMock.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/mensalidade' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      amount_cents: null,
      next_due_date: null,
      dias_restantes: null,
      billing_status: null,
      charge: null,
      dev_mode: true,
    });
    expect(daysUntilDueMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('isolamento: usa o slot do tenant da sessao (outro slot -> outra query)', async () => {
    injectedSlot = 'clone_outro';
    getBillingMock.mockResolvedValue(null);
    getChargeMock.mockResolvedValue(null);

    const app = await buildApp();
    await app.inject({ method: 'GET', url: '/portal/mensalidade' });

    expect(getBillingMock).toHaveBeenCalledWith('clone_outro');
    expect(getChargeMock).toHaveBeenCalledWith('clone_outro', cicloAtual());
    await app.close();
  });
});

// ── POST /portal/mensalidade/pix ──────────────────────────────────────────────
describe('POST /portal/mensalidade/pix', () => {
  it('200: gera a cobranca usando o amount do BANCO (nunca de input)', async () => {
    getBillingMock.mockResolvedValue(makeBilling({ amount_cents: 25000 }));
    ensureMock.mockResolvedValue({ charge: makeCharge({ amount_cents: 25000 }), created: true });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/mensalidade/pix',
      // Tentativa de injetar amount/slot pelo body — deve ser IGNORADA.
      payload: { amount_cents: 1, slot: 'clone_hacker' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ cycle: cicloAtual(), status: 'pending' });
    // amountCents veio do banco (25000), slot da sessao (clone_x).
    const callArgs = ensureMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(callArgs).toMatchObject({ slot: 'clone_x', cycle: cicloAtual(), amountCents: 25000 });
    await app.close();
  });

  it('409 sem_valor_configurado quando amount_cents e null', async () => {
    getBillingMock.mockResolvedValue(makeBilling({ amount_cents: null }));

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/mensalidade/pix' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'sem_valor_configurado' });
    expect(ensureMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('409 sem_valor_configurado quando amount_cents e 0', async () => {
    getBillingMock.mockResolvedValue(makeBilling({ amount_cents: 0 }));

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/mensalidade/pix' });

    expect(res.statusCode).toBe(409);
    expect(ensureMock).not.toHaveBeenCalled();
    await app.close();
  });
});

// ── POST /portal/mensalidade/simular (Dev-only) ───────────────────────────────
describe('POST /portal/mensalidade/simular', () => {
  it('200 simulated quando ha cobranca com abacate_charge_id (Dev)', async () => {
    getChargeMock.mockResolvedValue(makeCharge({ abacate_charge_id: 'pix_char_xyz' }));
    simulatePaymentMock.mockResolvedValue({ id: 'pix_char_xyz', status: 'paid' });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/mensalidade/simular' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ simulated: true });
    // chargeId veio do slot da sessao, nao de input.
    expect(simulatePaymentMock).toHaveBeenCalledWith('pix_char_xyz');
    await app.close();
  });

  it('409 sem_cobranca quando nao ha cobranca com abacate_charge_id', async () => {
    getChargeMock.mockResolvedValue(makeCharge({ abacate_charge_id: null }));

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/mensalidade/simular' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'sem_cobranca' });
    expect(simulatePaymentMock).not.toHaveBeenCalled();
    await app.close();
  });
});
