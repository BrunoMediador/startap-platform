/**
 * Variante com chave de PROD (nao abc_dev_*) — config mockada separadamente.
 *
 * Cobre: dev_mode=false no GET e o guard 403 do /simular fora de Dev (ADR 0013, F3).
 * Em arquivo proprio porque o mock de config.js e por modulo (a chave nao muda em runtime).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    NODE_ENV: 'test',
    ABACATEPAY_API_KEY: 'abc_live_prod', // chave de PROD -> dev_mode false
    ABACATEPAY_BASE_URL: 'https://api.abacatepay.com',
  },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('@startap/db', () => ({
  clientBilling: { getBillingBySlot: vi.fn(), daysUntilDue: vi.fn() },
  billingCharges: { getCharge: vi.fn() },
}));

const { simulatePaymentMock } = vi.hoisted(() => ({ simulatePaymentMock: vi.fn() }));
vi.mock('@startap/integrations', () => ({
  abacatepay: {
    AbacatePayClient: class {
      simulatePayment(id: string) {
        return simulatePaymentMock(id);
      }
    },
    AbacatePayNotConfiguredError: class extends Error {},
    ensurePixChargeForCycle: vi.fn(),
  },
}));

vi.mock('../lib/tenant.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/tenant.js')>('../lib/tenant.js');
  return {
    ...actual,
    withTenant: vi.fn(async (req: { tenant?: unknown }) => {
      req.tenant = { slot: 'clone_x', userId: 7, username: 'cirilo', sid: 'sid-atual' };
    }),
  };
});

import { clientBilling } from '@startap/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { portalBillingRoutes } from './portal-billing.js';

const getBillingMock = vi.mocked(clientBilling.getBillingBySlot);

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalBillingRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('chave de Prod (nao abc_dev_*)', () => {
  it('GET /portal/mensalidade -> dev_mode false', async () => {
    getBillingMock.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/mensalidade' });

    expect(res.statusCode).toBe(200);
    expect(res.json().dev_mode).toBe(false);
    await app.close();
  });

  it('POST /portal/mensalidade/simular -> 403 simulacao_indisponivel (guard Dev-only)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/mensalidade/simular' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'simulacao_indisponivel' });
    expect(simulatePaymentMock).not.toHaveBeenCalled();
    await app.close();
  });
});
