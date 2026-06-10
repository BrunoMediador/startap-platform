/**
 * Testes das rotas de reconexão WAHA do portal (ADR 0015).
 *
 * DB, integrations WAHA e Redis (lock) são MOCKADOS — nada bate em serviço real.
 * Foco: flag OFF esconde tudo; isolamento (slot/sessão/número da sessão, nunca input);
 * guard 409 em WORKING; 429 no 2º clique (lock); 422 telefone_nao_cadastrado; QR guard.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// config.js valida process.env no import — mockamos. Flag MUTÁVEL por teste.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    NODE_ENV: 'test',
    PORTAL_RECONEXAO_WAHA: true,
    PORTAL_WAHA_TIMEOUT_MS: 8000,
  },
}));
vi.mock('../config.js', () => ({ config: mockConfig }));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('@startap/db', () => ({
  flowClones: { getCloneBySlot: vi.fn() },
}));

// Integrations: classes de erro REAIS (instanceof importa nas rotas) + helpers mockados.
const { wahaMocks } = vi.hoisted(() => ({
  wahaMocks: {
    getSessionStatus: vi.fn(),
    restartAndWaitForScan: vi.fn(),
    requestPairingCode: vi.fn(),
    getSessionQR: vi.fn(),
  },
}));
vi.mock('@startap/integrations', () => {
  class WahaTimeoutError extends Error {}
  class WahaWrongStateError extends Error {
    status: string;
    constructor(msg: string, status: string) {
      super(msg);
      this.status = status;
    }
  }
  return {
    waha: {
      sessions: {
        WahaTimeoutError,
        WahaWrongStateError,
        getSessionStatus: (...a: unknown[]) => wahaMocks.getSessionStatus(...a),
        restartAndWaitForScan: (...a: unknown[]) => wahaMocks.restartAndWaitForScan(...a),
        requestPairingCode: (...a: unknown[]) => wahaMocks.requestPairingCode(...a),
        getSessionQR: (...a: unknown[]) => wahaMocks.getSessionQR(...a),
      },
    },
  };
});

// Redis (lock) mockado via session.js getRedis.
const { redisMock } = vi.hoisted(() => ({
  redisMock: { set: vi.fn(), ttl: vi.fn() },
}));
vi.mock('../lib/session.js', () => ({
  getRedis: () => redisMock,
}));

// withTenant stub: injeta tenant fixo (slot da sessão). Auth real vive em tenant.test.ts.
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

import { flowClones } from '@startap/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { portalConexaoRoutes } from './portal-conexao.js';

const getCloneMock = vi.mocked(flowClones.getCloneBySlot);

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalConexaoRoutes);
  await app.ready();
  return app;
}

function makeClone(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    slot: 'clone_x',
    waha_sessao: 'sess_x',
    cliente_telefone: '+55 11 97963-0828',
    display_name: 'Barbearia X',
    ...over,
    // biome-ignore lint/suspicious/noExplicitAny: fixture de teste
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  injectedSlot = 'clone_x';
  mockConfig.PORTAL_RECONEXAO_WAHA = true;
  redisMock.set.mockResolvedValue('OK');
  redisMock.ttl.mockResolvedValue(0);
});

// ── Flag OFF ──────────────────────────────────────────────────────────────────
describe('flag PORTAL_RECONEXAO_WAHA OFF', () => {
  it('GET /portal/conexao -> { enabled:false } e NADA MAIS (front esconde)', async () => {
    mockConfig.PORTAL_RECONEXAO_WAHA = false;
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/conexao' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false });
    // Não consulta clone nem WAHA com a flag OFF.
    expect(getCloneMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('rotas de ação -> 404 com a flag OFF', async () => {
    mockConfig.PORTAL_RECONEXAO_WAHA = false;
    const app = await buildApp();
    for (const [method, url] of [
      ['POST', '/portal/conexao/reconectar'],
      ['POST', '/portal/conexao/codigo'],
      ['GET', '/portal/conexao/qr'],
      ['GET', '/portal/conexao/status'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(404);
    }
    await app.close();
  });
});

// ── GET /portal/conexao ─────────────────────────────────────────────────────────
describe('GET /portal/conexao', () => {
  it('WORKING -> connected:true, can_reconnect:false, telefone mascarado', async () => {
    getCloneMock.mockResolvedValue(makeClone());
    wahaMocks.getSessionStatus.mockResolvedValue({ status: 'WORKING' });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/conexao' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.connected).toBe(true);
    expect(body.needs_action).toBe(false);
    expect(body.can_reconnect).toBe(false);
    expect(body.has_registered_phone).toBe(true);
    // Telefone SEMPRE mascarado — nunca em claro.
    expect(body.registered_phone_masked).toBe('5511****0828');
    expect(JSON.stringify(body)).not.toContain('5511979630828');
    expect(getCloneMock).toHaveBeenCalledWith('clone_x');
    await app.close();
  });

  it('WAHA fora -> status unknown, graceful (não derruba)', async () => {
    getCloneMock.mockResolvedValue(makeClone());
    wahaMocks.getSessionStatus.mockRejectedValue(new Error('econnrefused'));

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/conexao' });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('unknown');
    expect(res.json().needs_action).toBe(true);
    await app.close();
  });

  it('cliente_telefone null -> has_registered_phone:false, masked:null', async () => {
    getCloneMock.mockResolvedValue(makeClone({ cliente_telefone: null }));
    wahaMocks.getSessionStatus.mockResolvedValue({ status: 'SCAN_QR_CODE' });

    const app = await buildApp();
    const body = (await app.inject({ method: 'GET', url: '/portal/conexao' })).json();
    expect(body.has_registered_phone).toBe(false);
    expect(body.registered_phone_masked).toBeNull();
    await app.close();
  });

  it('isolamento: usa o slot da sessão (outro slot -> outra query)', async () => {
    injectedSlot = 'clone_outro';
    getCloneMock.mockResolvedValue(makeClone({ slot: 'clone_outro' }));
    wahaMocks.getSessionStatus.mockResolvedValue({ status: 'FAILED' });

    const app = await buildApp();
    await app.inject({ method: 'GET', url: '/portal/conexao' });
    expect(getCloneMock).toHaveBeenCalledWith('clone_outro');
    await app.close();
  });
});

// ── POST /portal/conexao/reconectar ──────────────────────────────────────────────
describe('POST /portal/conexao/reconectar', () => {
  it('WORKING -> 409 ja_conectado SEM restart (protege sessão pagante)', async () => {
    getCloneMock.mockResolvedValue(makeClone());
    wahaMocks.getSessionStatus.mockResolvedValue({ status: 'WORKING' });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/conexao/reconectar' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'ja_conectado' });
    expect(wahaMocks.restartAndWaitForScan).not.toHaveBeenCalled();
    expect(redisMock.set).not.toHaveBeenCalled();
    await app.close();
  });

  it('FAILED -> 202 restarting, adquire lock, restart async', async () => {
    getCloneMock.mockResolvedValue(makeClone());
    wahaMocks.getSessionStatus.mockResolvedValue({ status: 'FAILED' });
    wahaMocks.restartAndWaitForScan.mockResolvedValue({ status: 'SCAN_QR_CODE', ready: true });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/conexao/reconectar' });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ session: 'sess_x', state: 'restarting', poll_after_ms: 2000 });
    // Lock SET NX EX por slot.
    expect(redisMock.set).toHaveBeenCalledWith(
      'portal:waha:reconnect:clone_x',
      '1',
      'EX',
      35,
      'NX',
    );
    await app.close();
  });

  it('2º clique (lock ocupado) -> 429 com Retry-After, SEM 2º restart', async () => {
    getCloneMock.mockResolvedValue(makeClone());
    wahaMocks.getSessionStatus.mockResolvedValue({ status: 'FAILED' });
    redisMock.set.mockResolvedValue(null); // SET NX falhou (lock já existe)
    redisMock.ttl.mockResolvedValue(28);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/conexao/reconectar' });

    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: 'aguarde', retry_after_seconds: 28 });
    expect(res.headers['retry-after']).toBe('28');
    expect(wahaMocks.restartAndWaitForScan).not.toHaveBeenCalled();
    await app.close();
  });

  it('WAHA unknown -> 503 (não reinicia sem garantir guard != WORKING)', async () => {
    getCloneMock.mockResolvedValue(makeClone());
    wahaMocks.getSessionStatus.mockRejectedValue(new Error('timeout'));

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/conexao/reconectar' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'waha_indisponivel' });
    expect(redisMock.set).not.toHaveBeenCalled();
    await app.close();
  });
});

// ── POST /portal/conexao/codigo ──────────────────────────────────────────────────
describe('POST /portal/conexao/codigo', () => {
  it('telefone null -> 422 telefone_nao_cadastrado (nunca aceita input)', async () => {
    getCloneMock.mockResolvedValue(makeClone({ cliente_telefone: null }));

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/conexao/codigo',
      // Tentativa de injetar número pelo body — deve ser IGNORADA.
      payload: { phoneNumber: '5599999999999' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'telefone_nao_cadastrado' });
    expect(wahaMocks.requestPairingCode).not.toHaveBeenCalled();
    await app.close();
  });

  it('SCAN_QR_CODE -> 200 com pairing_code; número do BANCO normalizado (sem +)', async () => {
    getCloneMock.mockResolvedValue(makeClone());
    wahaMocks.getSessionStatus.mockResolvedValue({ status: 'SCAN_QR_CODE' });
    wahaMocks.requestPairingCode.mockResolvedValue({ code: 'ABCD-1234' });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/conexao/codigo',
      payload: { phoneNumber: '5599999999999' }, // ignorado (anti-IDOR)
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      pairing_code: 'ABCD-1234',
      expires_in_seconds: 60,
      phone_masked: '5511****0828',
    });
    // Número veio do banco normalizado p/ dígitos, sessão da sessão.
    expect(wahaMocks.requestPairingCode).toHaveBeenCalledWith('sess_x', '5511979630828', {
      timeoutMs: 8000,
    });
    await app.close();
  });

  it('WORKING -> 409 ja_conectado', async () => {
    getCloneMock.mockResolvedValue(makeClone());
    wahaMocks.getSessionStatus.mockResolvedValue({ status: 'WORKING' });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/conexao/codigo' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'ja_conectado' });
    await app.close();
  });

  it('estado não-pronto (STARTING) -> 422 sessao_nao_pronta com next', async () => {
    getCloneMock.mockResolvedValue(makeClone());
    wahaMocks.getSessionStatus.mockResolvedValue({ status: 'STARTING' });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/conexao/codigo' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      error: 'sessao_nao_pronta',
      next: 'POST /portal/conexao/reconectar',
    });
    expect(wahaMocks.requestPairingCode).not.toHaveBeenCalled();
    await app.close();
  });
});

// ── GET /portal/conexao/qr ────────────────────────────────────────────────────────
describe('GET /portal/conexao/qr', () => {
  it('SCAN_QR_CODE -> 200 com qr', async () => {
    getCloneMock.mockResolvedValue(makeClone());
    wahaMocks.getSessionQR.mockResolvedValue({ qr: 'data:image/png;base64,AAAA' });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/conexao/qr' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ qr: 'data:image/png;base64,AAAA' });
    await app.close();
  });

  it('WORKING -> 200 { connected:true, qr:null }', async () => {
    getCloneMock.mockResolvedValue(makeClone());
    wahaMocks.getSessionQR.mockResolvedValue({ connected: true, qr: null });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/conexao/qr' });
    expect(res.json()).toEqual({ connected: true, qr: null });
    await app.close();
  });

  it('estado errado -> 409 sessao_nao_pronta com status', async () => {
    const { waha } = await import('@startap/integrations');
    getCloneMock.mockResolvedValue(makeClone());
    wahaMocks.getSessionQR.mockRejectedValue(
      new waha.sessions.WahaWrongStateError('nope', 'FAILED'),
    );

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/conexao/qr' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'sessao_nao_pronta', status: 'FAILED' });
    await app.close();
  });
});

// ── GET /portal/conexao/status ────────────────────────────────────────────────────
describe('GET /portal/conexao/status', () => {
  it('200 com terminal=true em WORKING', async () => {
    getCloneMock.mockResolvedValue(makeClone());
    wahaMocks.getSessionStatus.mockResolvedValue({ status: 'WORKING' });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/conexao/status' });
    expect(res.json()).toEqual({
      session: 'sess_x',
      status: 'WORKING',
      connected: true,
      terminal: true,
    });
    await app.close();
  });

  it('200 com terminal=false em SCAN_QR_CODE', async () => {
    getCloneMock.mockResolvedValue(makeClone());
    wahaMocks.getSessionStatus.mockResolvedValue({ status: 'SCAN_QR_CODE' });

    const app = await buildApp();
    const body = (await app.inject({ method: 'GET', url: '/portal/conexao/status' })).json();
    expect(body.terminal).toBe(false);
    expect(body.connected).toBe(false);
    await app.close();
  });
});
