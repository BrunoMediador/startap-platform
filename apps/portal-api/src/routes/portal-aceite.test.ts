/**
 * Testes do gate de aceite pós-login (SCRUM-1, fluxo 2):
 *   GET  /portal/aceite/status  — precisa (re)aceitar a versão vigente?
 *   POST /portal/aceite         — grava a prova (slot + user da sessão, versões v1).
 *
 * DB mockado. withTenant é STUBADO (injeta slot/userId fixos da sessão) — auth real
 * vive em tenant.test.ts. Invariante: slot/user vêm SEMPRE da sessão, nunca do body.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: { NODE_ENV: 'test', REDIS_HOST: 'localhost', REDIS_PORT: 6379, REDIS_PASSWORD: '' },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const mocks = vi.hoisted(() => ({
  getLatestAcceptanceForSlot: vi.fn(),
  recordTermsAcceptance: vi.fn(),
  resolveTenantId: vi.fn(),
}));

vi.mock('@startap/db', () => ({
  termsAcceptance: {
    getLatestAcceptanceForSlot: mocks.getLatestAcceptanceForSlot,
    recordTermsAcceptance: mocks.recordTermsAcceptance,
  },
  tenant: { resolveTenantId: mocks.resolveTenantId },
  portalUsers: { getSlotForActivePortalUser: vi.fn() },
}));

const injectedSlot = 'clone_teste_a1b2c3';
vi.mock('../lib/tenant.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/tenant.js')>('../lib/tenant.js');
  return {
    ...actual,
    withTenant: vi.fn(async (req: { tenant?: unknown }) => {
      req.tenant = { slot: injectedSlot, userId: 7, username: 'dono', sid: 'sid-atual' };
    }),
  };
});

import Fastify, { type FastifyInstance } from 'fastify';
import { PRIVACY_HASH, TERMS_HASH } from '../lib/legal-version.js';
import { portalAceiteRoutes } from './portal-aceite.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalAceiteRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTenantId.mockResolvedValue('11111111-1111-1111-1111-111111111111');
  mocks.recordTermsAcceptance.mockResolvedValue({ id: 1, slot: injectedSlot });
});

describe('GET /portal/aceite/status', () => {
  it('needs_acceptance=true quando o tenant NUNCA aceitou (sem linha)', async () => {
    mocks.getLatestAcceptanceForSlot.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/aceite/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      needs_acceptance: true,
      terms_version: 'v1',
      privacy_version: 'v2',
    });
    expect(mocks.getLatestAcceptanceForSlot).toHaveBeenCalledWith(injectedSlot);
    await app.close();
  });

  it('needs_acceptance=false quando já aceitou a versão vigente (v1/v2)', async () => {
    mocks.getLatestAcceptanceForSlot.mockResolvedValue({
      terms_version: 'v1',
      privacy_version: 'v2',
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/aceite/status' });
    expect(res.json().needs_acceptance).toBe(false);
    await app.close();
  });

  it('needs_acceptance=true quando a versão aceita é antiga (termos mudaram)', async () => {
    mocks.getLatestAcceptanceForSlot.mockResolvedValue({
      terms_version: 'v0',
      privacy_version: 'v1',
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/aceite/status' });
    expect(res.json().needs_acceptance).toBe(true);
    await app.close();
  });

  it('needs_acceptance=true quando aceitou a Política v1 e a vigente é v2 (nosso cenário: bump SCRUM-59)', async () => {
    // Cirilo/Samuel/dragon aceitaram v1/v1; o bump da Política pra v2 dispara o
    // re-aceite de 1 clique (decisão Bruno 03/07). Termos seguem v1.
    mocks.getLatestAcceptanceForSlot.mockResolvedValue({
      terms_version: 'v1',
      privacy_version: 'v1',
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/aceite/status' });
    expect(res.json().needs_acceptance).toBe(true);
    await app.close();
  });
});

describe('POST /portal/aceite', () => {
  it('201 grava a prova com slot+user da sessão (Termos v1/Política v2), hashes vigentes e user-agent', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/aceite',
      headers: { 'user-agent': 'TestAgent/2.0' },
    });
    expect(res.statusCode).toBe(201);
    // Hashes vigentes server-authoritative (SCRUM-31) — vêm das constantes, nunca do body.
    expect(res.json()).toEqual({
      ok: true,
      terms_version: 'v1',
      privacy_version: 'v2',
      terms_hash: TERMS_HASH,
      privacy_hash: PRIVACY_HASH,
    });
    expect(mocks.recordTermsAcceptance).toHaveBeenCalledWith(
      expect.objectContaining({
        slot: injectedSlot,
        portalUserId: 7,
        termsVersion: 'v1',
        privacyVersion: 'v2',
        termsHash: TERMS_HASH,
        privacyHash: PRIVACY_HASH,
        tenantId: '11111111-1111-1111-1111-111111111111',
        userAgent: 'TestAgent/2.0',
      }),
    );
    await app.close();
  });

  it('IGNORA qualquer slot enviado no body (anti-IDOR: slot vem da sessão)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/aceite',
      payload: { slot: 'clone_de_outro_tenant', terms_version: 'v9' },
    });
    expect(res.statusCode).toBe(201);
    const arg = mocks.recordTermsAcceptance.mock.calls[0]?.[0] as {
      slot: string;
      termsVersion: string;
    };
    expect(arg.slot).toBe(injectedSlot);
    expect(arg.termsVersion).toBe('v1');
    await app.close();
  });
});
