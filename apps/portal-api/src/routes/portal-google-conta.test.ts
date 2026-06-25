/**
 * Testes do GET /portal/google-conta (migration 061 — entrega da credencial Google do
 * CLIENTE: login do Google Agenda no cel/PC; NÃO é a Service Account do bot).
 *
 * Invariantes cobertos:
 *   - flag GOOGLE_ACCOUNT_PORTAL_ENABLED OFF -> 404 e NEM consulta o banco;
 *   - flag ON: devolve e-mail + senha DECIFRADA, header cache-control: no-store;
 *   - anti-IDOR: o slot vem da SESSÃO (withTenant), nunca do body/query;
 *   - a SENHA do Google NUNCA aparece em log (nem cifrada nem em claro).
 *
 * DB (@startap/db) e crypto (@startap/core) mockados. config.js mockado (valida env no import).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Estado da flag controlado por teste (mutável entre casos).
const cfg: { GOOGLE_ACCOUNT_PORTAL_ENABLED: boolean } = { GOOGLE_ACCOUNT_PORTAL_ENABLED: true };
vi.mock('../config.js', () => ({
  config: new Proxy({} as Record<string, unknown>, {
    get: (_t, p) => {
      if (p === 'GOOGLE_ACCOUNT_PORTAL_ENABLED') return cfg.GOOGLE_ACCOUNT_PORTAL_ENABLED;
      if (p === 'NODE_ENV') return 'test';
      if (p === 'REDIS_HOST') return 'localhost';
      if (p === 'REDIS_PORT') return 6379;
      if (p === 'REDIS_PASSWORD') return '';
      return undefined;
    },
  }),
}));

// Captura TODAS as chamadas de log para asserir que a senha nunca vaza.
const logCalls: unknown[][] = [];
vi.mock('@startap/core/logger', () => ({
  logger: {
    child: () => ({
      info: (...a: unknown[]) => logCalls.push(a),
      warn: (...a: unknown[]) => logCalls.push(a),
      error: (...a: unknown[]) => logCalls.push(a),
    }),
  },
}));

// decryptSecret determinístico: "ENC(x)" -> "x" (prova que a rota decifra no ponto de uso).
const decryptSecretMock = vi.fn((stored: string) =>
  stored.startsWith('ENC(') && stored.endsWith(')') ? stored.slice(4, -1) : stored,
);
vi.mock('@startap/core', () => ({
  decryptSecret: (s: string) => decryptSecretMock(s),
}));

const { getGoogleAccountBySlotMock } = vi.hoisted(() => ({
  getGoogleAccountBySlotMock: vi.fn(),
}));
vi.mock('@startap/db', () => ({
  flowClones: { getGoogleAccountBySlot: (...a: unknown[]) => getGoogleAccountBySlotMock(...a) },
  portalUsers: { getSlotForActivePortalUser: vi.fn() },
}));

// withTenant stub: injeta o slot DA SESSÃO (auth real coberto em tenant.test.ts).
const injectedSlot = 'clone_seven_7_dqjzb4';
vi.mock('../lib/tenant.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/tenant.js')>('../lib/tenant.js');
  return {
    ...actual,
    withTenant: vi.fn(async (req: { tenant?: unknown }) => {
      req.tenant = { slot: injectedSlot, userId: 9, username: 'dono', sid: 'sid-atual' };
    }),
  };
});

import Fastify, { type FastifyInstance } from 'fastify';
import { portalGoogleContaRoutes } from './portal-google-conta.js';

const SENHA_PLAIN = 'GoogleP@ss-Sup3r-Secreta';
const SENHA_ENC = `ENC(${SENHA_PLAIN})`;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalGoogleContaRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  logCalls.length = 0;
  cfg.GOOGLE_ACCOUNT_PORTAL_ENABLED = true;
});

describe('GET /portal/google-conta', () => {
  it('200: devolve e-mail + senha DECIFRADA do slot da sessão + cache-control: no-store', async () => {
    getGoogleAccountBySlotMock.mockResolvedValue({
      google_account_email: 'cliente@gmail.com',
      google_account_password_enc: SENHA_ENC,
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/google-conta' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      google_account_email: 'cliente@gmail.com',
      google_account_password: SENHA_PLAIN, // já decifrada server-side
    });
    expect(res.headers['cache-control']).toBe('no-store');
    // Anti-IDOR: leitura escopada pelo slot da SESSÃO.
    expect(getGoogleAccountBySlotMock).toHaveBeenCalledWith(injectedSlot);
    expect(decryptSecretMock).toHaveBeenCalledWith(SENHA_ENC);
    await app.close();
  });

  it('200: credencial não configurada -> email/senha null (não chama decryptSecret)', async () => {
    getGoogleAccountBySlotMock.mockResolvedValue({
      google_account_email: null,
      google_account_password_enc: null,
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/google-conta' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ google_account_email: null, google_account_password: null });
    expect(decryptSecretMock).not.toHaveBeenCalled(); // não decifra NULL
    await app.close();
  });

  it('flag OFF -> 404 e NEM consulta o banco', async () => {
    cfg.GOOGLE_ACCOUNT_PORTAL_ENABLED = false;
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/google-conta' });

    expect(res.statusCode).toBe(404);
    expect(getGoogleAccountBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('404: slot da sessão sem clone', async () => {
    getGoogleAccountBySlotMock.mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/google-conta' });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('anti-IDOR: ignora slot/tenant na query — usa o slot da sessão', async () => {
    getGoogleAccountBySlotMock.mockResolvedValue({
      google_account_email: 'cliente@gmail.com',
      google_account_password_enc: SENHA_ENC,
    });
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/portal/google-conta?slot=clone_de_outro_tenant&tenant=evil',
    });

    expect(res.statusCode).toBe(200);
    // O slot usado é SEMPRE o da sessão; o query param malicioso é ignorado.
    expect(getGoogleAccountBySlotMock).toHaveBeenCalledWith(injectedSlot);
    expect(getGoogleAccountBySlotMock).not.toHaveBeenCalledWith('clone_de_outro_tenant');
    await app.close();
  });

  it('a SENHA do Google NUNCA aparece em log (nem cifrada nem em claro)', async () => {
    getGoogleAccountBySlotMock.mockResolvedValue({
      google_account_email: 'cliente@gmail.com',
      google_account_password_enc: SENHA_ENC,
    });
    const app = await buildApp();

    await app.inject({ method: 'GET', url: '/portal/google-conta' });

    expect(logCalls.length).toBeGreaterThan(0); // logou o sucesso
    const dump = JSON.stringify(logCalls);
    expect(dump).not.toContain(SENHA_PLAIN); // senha em claro nunca no log
    expect(dump).not.toContain(SENHA_ENC); // cifra também não
    expect(dump).not.toContain('cliente@gmail.com'); // e-mail também não (só o slot)
    expect(dump).toContain(injectedSlot); // o log carrega SÓ o slot
    await app.close();
  });
});
