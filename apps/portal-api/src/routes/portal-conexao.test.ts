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
    PORTAL_RECONEXAO_LOGOUT_FALLBACK: true,
    PORTAL_BOT_PAUSE: true,
    PORTAL_WAHA_TIMEOUT_MS: 8000,
    // Config WAHA usada para RECRIAR a sessão (recreateWahaConfig) — mesmo padrão
    // do signup. TS_WEBHOOK_URL presente = recriação habilitada.
    WAHA_URL: 'http://waha:3000',
    WAHA_API_KEY: 'k',
    TS_WEBHOOK_URL: 'http://api:3040/webhooks/waha',
    WAHA_WEBHOOK_HMAC_KEY: 'hmac-secret',
    WAHA_WEBHOOK_SECRET: 'static-secret',
  },
}));
vi.mock('../config.js', () => ({ config: mockConfig }));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('@startap/db', () => ({
  clientBilling: {
    GRACE_DAYS: 3,
    daysUntilDue: (nextDueDate: string | null): number | null => {
      if (!nextDueDate) return null;
      const due = Date.parse(`${nextDueDate}T00:00:00Z`);
      const today = new Date();
      return Math.round(
        (due - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) /
          86_400_000,
      );
    },
  },
  flowClones: {
    getCloneBySlot: vi.fn(),
    pauseBotByOwner: vi.fn(),
    resumeBotByOwner: vi.fn(),
    // Reparo on-demand do beco sem saída do signup (waha_sessao NULL).
    bindSessionIfUnset: vi.fn(),
    // Constante real reusada pela derivação de pause_self/pause_locked nas rotas.
    OWNER_PAUSE_KIND: 'owner_request',
  },
  operationalState: { getOperationalSnapshotBySlot: vi.fn() },
}));

// Integrations: classes de erro REAIS (instanceof importa nas rotas) + helpers mockados.
const { wahaMocks, provisioningMocks } = vi.hoisted(() => ({
  wahaMocks: {
    getSessionStatus: vi.fn(),
    restartAndWaitForScan: vi.fn(),
    requestPairingCode: vi.fn(),
    getSessionQR: vi.fn(),
  },
  provisioningMocks: {
    createWahaSession: vi.fn(),
    wahaSessionName: vi.fn(),
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
  class WahaSessionNotFoundError extends Error {
    session: string;
    constructor(session: string) {
      super(`WAHA: sessão "${session}" não existe (404)`);
      this.session = session;
    }
  }
  return {
    waha: {
      sessions: {
        WahaTimeoutError,
        WahaWrongStateError,
        WahaSessionNotFoundError,
        getSessionStatus: (...a: unknown[]) => wahaMocks.getSessionStatus(...a),
        restartAndWaitForScan: (...a: unknown[]) => wahaMocks.restartAndWaitForScan(...a),
        requestPairingCode: (...a: unknown[]) => wahaMocks.requestPairingCode(...a),
        getSessionQR: (...a: unknown[]) => wahaMocks.getSessionQR(...a),
      },
    },
    provisioning: {
      createWahaSession: (...a: unknown[]) => provisioningMocks.createWahaSession(...a),
      wahaSessionName: (...a: unknown[]) => provisioningMocks.wahaSessionName(...a),
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

import { flowClones, operationalState } from '@startap/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { portalConexaoRoutes } from './portal-conexao.js';

const getCloneMock = vi.mocked(flowClones.getCloneBySlot);
const pauseMock = vi.mocked(flowClones.pauseBotByOwner);
const resumeMock = vi.mocked(flowClones.resumeBotByOwner);
const bindSessionMock = vi.mocked(flowClones.bindSessionIfUnset);
const operationalMock = vi.mocked(operationalState.getOperationalSnapshotBySlot);
type OperationalFixture = NonNullable<
  Awaited<ReturnType<typeof operationalState.getOperationalSnapshotBySlot>>
>;

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

function makeOperational(over: Partial<OperationalFixture> = {}): OperationalFixture {
  return {
    slot: 'clone_x',
    tenant_id: 'tenant-x',
    clone_status: 'conectado',
    atendimento_configured: true,
    waha_sessao: 'sess_x',
    flow_enabled: true,
    suspended_reason: null,
    suspended_kind: null,
    suspended_at: null,
    next_due_date: '2099-01-01',
    billing_amount_cents: 8500,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  injectedSlot = 'clone_x';
  mockConfig.PORTAL_RECONEXAO_WAHA = true;
  mockConfig.PORTAL_BOT_PAUSE = true;
  mockConfig.TS_WEBHOOK_URL = 'http://api:3040/webhooks/waha';
  redisMock.set.mockResolvedValue('OK');
  redisMock.ttl.mockResolvedValue(0);
  // Default: recriação OK (testes de falha sobrescrevem).
  provisioningMocks.createWahaSession.mockResolvedValue({ ok: true, status: 'STARTING' });
  // wahaSessionName só é chamado no reparo de slot SEM prefixo clone_ (gestão);
  // devolve o nome namespaced (troca hífen por _). Slots do signup (clone_*) nem chamam.
  provisioningMocks.wahaSessionName.mockImplementation(
    (slot: string) => `clone_${slot.replace(/-/g, '_')}`,
  );
  // Default do reparo: vinculação vence a corrida.
  bindSessionMock.mockResolvedValue(true);
  operationalMock.mockResolvedValue(makeOperational());
  process.env.BILLING_OVERDUE_SILENCE = 'true';
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

  it('first_connected_at NULL -> ever_connected:false (nunca conectou; copy 1ª conexão)', async () => {
    getCloneMock.mockResolvedValue(makeClone({ first_connected_at: null }));
    wahaMocks.getSessionStatus.mockResolvedValue({ status: 'SCAN_QR_CODE' });

    const app = await buildApp();
    const body = (await app.inject({ method: 'GET', url: '/portal/conexao' })).json();
    expect(body.ever_connected).toBe(false);
    // A DATA nunca vaza — só o booleano (LGPD).
    expect(JSON.stringify(body)).not.toContain('first_connected_at');
    await app.close();
  });

  it('first_connected_at preenchido -> ever_connected:true (reconexão), sem vazar a data', async () => {
    getCloneMock.mockResolvedValue(
      makeClone({ first_connected_at: new Date('2026-07-20T12:00:00Z') }),
    );
    wahaMocks.getSessionStatus.mockResolvedValue({ status: 'WORKING' });

    const app = await buildApp();
    const body = (await app.inject({ method: 'GET', url: '/portal/conexao' })).json();
    expect(body.ever_connected).toBe(true);
    expect(JSON.stringify(body)).not.toContain('2026-07-20');
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

  it('FAILED -> 202 restarting, adquire lock, restart async (logoutFallback ON por flag)', async () => {
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
    // O caller repassa o kill-switch (default ON) pra orquestração — fallback habilitado.
    expect(wahaMocks.restartAndWaitForScan).toHaveBeenCalledWith(
      'sess_x',
      expect.objectContaining({ logoutFallback: true }),
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

  it('404 (sessão sumiu) -> RECRIA com a config-ouro e 202 restarting', async () => {
    const { waha } = await import('@startap/integrations');
    getCloneMock.mockResolvedValue(makeClone());
    wahaMocks.getSessionStatus.mockRejectedValue(
      new waha.sessions.WahaSessionNotFoundError('sess_x'),
    );

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/conexao/reconectar' });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ session: 'sess_x', state: 'restarting', poll_after_ms: 2000 });
    // RECRIOU pelo helper do provisionamento, com o MESMO nome de sessão do banco
    // (config-ouro vive dentro de createWahaSession — não duplicada aqui).
    expect(provisioningMocks.createWahaSession).toHaveBeenCalledTimes(1);
    const [wahaCfg, name] = provisioningMocks.createWahaSession.mock.calls[0];
    expect(name).toBe('sess_x');
    // A config WAHA vem do config tipado (env), não de input nem de container.
    expect(wahaCfg).toMatchObject({
      url: 'http://waha:3000',
      apiKey: 'k',
      webhookUrl: 'http://api:3040/webhooks/waha',
      webhookHmacKey: 'hmac-secret',
      webhookSecret: 'static-secret',
    });
    // NÃO chama restartAndWaitForScan (sessão recém-criada já nasce com start:true).
    expect(wahaMocks.restartAndWaitForScan).not.toHaveBeenCalled();
    await app.close();
  });

  it('404 + falha ao recriar -> 503 (não trava o cliente em beco)', async () => {
    const { waha } = await import('@startap/integrations');
    getCloneMock.mockResolvedValue(makeClone());
    wahaMocks.getSessionStatus.mockRejectedValue(
      new waha.sessions.WahaSessionNotFoundError('sess_x'),
    );
    provisioningMocks.createWahaSession.mockResolvedValue({
      ok: false,
      status: 'failed',
      error: 'WAHA: boom',
    });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/conexao/reconectar' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'waha_indisponivel' });
    expect(provisioningMocks.createWahaSession).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('404 mas TS_WEBHOOK_URL ausente -> 503 sem recriar (env lazy, boot intacto)', async () => {
    const { waha } = await import('@startap/integrations');
    mockConfig.TS_WEBHOOK_URL = undefined as unknown as string;
    getCloneMock.mockResolvedValue(makeClone());
    wahaMocks.getSessionStatus.mockRejectedValue(
      new waha.sessions.WahaSessionNotFoundError('sess_x'),
    );

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/conexao/reconectar' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'waha_indisponivel' });
    expect(provisioningMocks.createWahaSession).not.toHaveBeenCalled();
    await app.close();
  });
});

// ── POST /portal/conexao/reconectar — REPARO on-demand (beco sem saída do signup) ──
// waha_sessao NULL + status 'rascunho' = signup cujo createWahaSession falhou. Antes
// TODA ação respondia 503 pra sempre; agora a 1ª reconexão CRIA a sessão e vincula.
describe('POST /portal/conexao/reconectar — reparo de waha_sessao NULL (signup falho)', () => {
  it('rascunho + NULL -> CRIA a sessão (nome=slot), vincula e 202 restarting', async () => {
    getCloneMock.mockResolvedValue(makeClone({ waha_sessao: null, status: 'rascunho' }));

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/conexao/reconectar' });

    expect(res.statusCode).toBe(202);
    // Nome da sessão = o próprio slot (signup usa sessionName=slot; slot já é clone_*).
    expect(res.json()).toEqual({ session: 'clone_x', state: 'restarting', poll_after_ms: 2000 });
    // Lock adquirido ANTES de criar (anti-corrida = anti-2-sessões).
    expect(redisMock.set).toHaveBeenCalledWith(
      'portal:waha:reconnect:clone_x',
      '1',
      'EX',
      35,
      'NX',
    );
    // Criou pela config-ouro do provisionamento, nome = slot (clone_* não re-prefixa).
    expect(provisioningMocks.createWahaSession).toHaveBeenCalledTimes(1);
    const [wahaCfg, name] = provisioningMocks.createWahaSession.mock.calls[0];
    expect(name).toBe('clone_x');
    expect(wahaCfg).toMatchObject({
      url: 'http://waha:3000',
      webhookUrl: 'http://api:3040/webhooks/waha',
    });
    // Persistência CONDICIONAL só DEPOIS do WAHA aceitar (id do clone, nome derivado).
    expect(bindSessionMock).toHaveBeenCalledWith(1, 'clone_x');
    // Slot sem prefixo NUNCA aconteceu aqui -> wahaSessionName não é chamado.
    expect(provisioningMocks.wahaSessionName).not.toHaveBeenCalled();
    await app.close();
  });

  it('reparo com falha do WAHA -> 503 retentável e NÃO persiste (nada de estado permanente)', async () => {
    getCloneMock.mockResolvedValue(makeClone({ waha_sessao: null, status: 'rascunho' }));
    provisioningMocks.createWahaSession.mockResolvedValue({
      ok: false,
      status: 'failed',
      error: 'WAHA: boom',
    });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/conexao/reconectar' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'waha_indisponivel' });
    expect(provisioningMocks.createWahaSession).toHaveBeenCalledTimes(1);
    // Falhou o WAHA -> NÃO grava waha_sessao (clone segue rascunho; cliente retenta).
    expect(bindSessionMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('corrida: lock ocupado -> 429 SEM criar 2ª sessão (2 requests não criam 2)', async () => {
    getCloneMock.mockResolvedValue(makeClone({ waha_sessao: null, status: 'rascunho' }));
    redisMock.set.mockResolvedValue(null); // SET NX falhou -> outra reparação em voo
    redisMock.ttl.mockResolvedValue(30);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/conexao/reconectar' });

    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: 'aguarde', retry_after_seconds: 30 });
    expect(res.headers['retry-after']).toBe('30');
    expect(provisioningMocks.createWahaSession).not.toHaveBeenCalled();
    expect(bindSessionMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('vinculação perde a corrida (bind=false) mas ainda 202 (nome determinístico converge)', async () => {
    getCloneMock.mockResolvedValue(makeClone({ waha_sessao: null, status: 'rascunho' }));
    bindSessionMock.mockResolvedValue(false); // outra request já vinculou a MESMA sessão

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/conexao/reconectar' });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ session: 'clone_x', state: 'restarting', poll_after_ms: 2000 });
    await app.close();
  });

  it('NULL mas clone JÁ progrediu (status != rascunho) -> 503 e NÃO fabrica sessão', async () => {
    getCloneMock.mockResolvedValue(makeClone({ waha_sessao: null, status: 'conectado' }));

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/conexao/reconectar' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'waha_indisponivel' });
    expect(provisioningMocks.createWahaSession).not.toHaveBeenCalled();
    expect(redisMock.set).not.toHaveBeenCalled();
    await app.close();
  });

  it('rascunho + NULL mas TS_WEBHOOK_URL ausente -> 503 sem criar (env lazy, boot intacto)', async () => {
    mockConfig.TS_WEBHOOK_URL = undefined as unknown as string;
    getCloneMock.mockResolvedValue(makeClone({ waha_sessao: null, status: 'rascunho' }));

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/conexao/reconectar' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'waha_indisponivel' });
    expect(provisioningMocks.createWahaSession).not.toHaveBeenCalled();
    // Nem sequer adquire lock (config-ouro indisponível é checado antes).
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

  it('404 (sessão sumiu) -> RECRIA e 422 sessao_nao_pronta (sem emitir código ainda)', async () => {
    const { waha } = await import('@startap/integrations');
    getCloneMock.mockResolvedValue(makeClone());
    wahaMocks.getSessionStatus.mockRejectedValue(
      new waha.sessions.WahaSessionNotFoundError('sess_x'),
    );

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/conexao/codigo' });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      error: 'sessao_nao_pronta',
      next: 'POST /portal/conexao/reconectar',
    });
    expect(provisioningMocks.createWahaSession).toHaveBeenCalledWith(
      expect.objectContaining({ webhookUrl: 'http://api:3040/webhooks/waha' }),
      'sess_x',
    );
    // Sessão recém-criada está STARTING, não SCAN_QR_CODE -> NÃO emite código.
    expect(wahaMocks.requestPairingCode).not.toHaveBeenCalled();
    await app.close();
  });

  it('WORKING -> 409 e NÃO recria sessão (sessão viva intocada)', async () => {
    getCloneMock.mockResolvedValue(makeClone());
    wahaMocks.getSessionStatus.mockResolvedValue({ status: 'WORKING' });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/conexao/codigo' });
    expect(res.statusCode).toBe(409);
    expect(provisioningMocks.createWahaSession).not.toHaveBeenCalled();
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
    expect(res.json()).toMatchObject({
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

// ── Pausa self-service do bot (PORTAL_BOT_PAUSE) ─────────────────────────────────
describe('GET /portal/conexao — campos de pausa derivados', () => {
  it('flow_enabled=true -> bot_paused:false, pause_self:false, pause_locked:false', async () => {
    getCloneMock.mockResolvedValue(makeClone({ flow_enabled: true, suspended_kind: null }));
    wahaMocks.getSessionStatus.mockResolvedValue({ status: 'WORKING' });

    const app = await buildApp();
    const body = (await app.inject({ method: 'GET', url: '/portal/conexao' })).json();
    expect(body.bot_paused).toBe(false);
    expect(body.pause_self).toBe(false);
    expect(body.pause_locked).toBe(false);
    await app.close();
  });

  it('owner_request -> bot_paused:true, pause_self:true, pause_locked:false (cliente retoma)', async () => {
    getCloneMock.mockResolvedValue(
      makeClone({ flow_enabled: false, suspended_kind: 'owner_request' }),
    );
    operationalMock.mockResolvedValue(
      makeOperational({ flow_enabled: false, suspended_kind: 'owner_request' }),
    );
    wahaMocks.getSessionStatus.mockResolvedValue({ status: 'WORKING' });

    const app = await buildApp();
    const body = (await app.inject({ method: 'GET', url: '/portal/conexao' })).json();
    expect(body.bot_paused).toBe(true);
    expect(body.pause_self).toBe(true);
    expect(body.pause_locked).toBe(false);
    await app.close();
  });

  it('billing -> bot_paused:true, pause_self:false, pause_locked:true (suspenso pela Startap)', async () => {
    getCloneMock.mockResolvedValue(makeClone({ flow_enabled: false, suspended_kind: 'billing' }));
    operationalMock.mockResolvedValue(
      makeOperational({ flow_enabled: false, suspended_kind: 'billing' }),
    );
    wahaMocks.getSessionStatus.mockResolvedValue({ status: 'WORKING' });

    const app = await buildApp();
    const body = (await app.inject({ method: 'GET', url: '/portal/conexao' })).json();
    expect(body.bot_paused).toBe(true);
    expect(body.pause_self).toBe(false);
    expect(body.pause_locked).toBe(true);
    await app.close();
  });

  it('flag PORTAL_BOT_PAUSE OFF -> GET omite os campos de pausa (front esconde a UI)', async () => {
    mockConfig.PORTAL_BOT_PAUSE = false;
    getCloneMock.mockResolvedValue(
      makeClone({ flow_enabled: false, suspended_kind: 'owner_request' }),
    );
    operationalMock.mockResolvedValue(
      makeOperational({ flow_enabled: false, suspended_kind: 'owner_request' }),
    );
    wahaMocks.getSessionStatus.mockResolvedValue({ status: 'WORKING' });

    const app = await buildApp();
    const body = (await app.inject({ method: 'GET', url: '/portal/conexao' })).json();
    expect('bot_paused' in body).toBe(false);
    expect('pause_self' in body).toBe(false);
    expect('pause_locked' in body).toBe(false);
    // O resto do snapshot (conexão) segue intacto.
    expect(body.enabled).toBe(true);
    await app.close();
  });
});

describe('POST /portal/bot/pause', () => {
  it('flag OFF -> 404 (front esconde) e NÃO toca o banco', async () => {
    mockConfig.PORTAL_BOT_PAUSE = false;
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/bot/pause' });
    expect(res.statusCode).toBe(404);
    expect(pauseMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('pausa -> 200 { bot_paused:true }; actor=portal:<userId>; slot da SESSÃO (anti-IDOR)', async () => {
    pauseMock.mockResolvedValue({ changed: true, flow_enabled: false });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/bot/pause',
      // Tentativa de injetar outro slot pelo body — deve ser IGNORADA.
      payload: { slot: 'clone_da_vitima' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ bot_paused: true });
    // slot vem do tenant (sessão), nunca do body; actor = portal:<userId>.
    expect(pauseMock).toHaveBeenCalledWith('clone_x', 'portal:7');
    await app.close();
  });

  it('já suspenso pela Startap -> NÃO sobrescreve; changed:false ainda devolve bot_paused:true', async () => {
    pauseMock.mockResolvedValue({ changed: false, flow_enabled: false });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/bot/pause' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ bot_paused: true });
    await app.close();
  });

  it('isolamento: outro slot na sessão -> pausa o slot da sessão, não outro', async () => {
    injectedSlot = 'clone_outro';
    pauseMock.mockResolvedValue({ changed: true, flow_enabled: false });
    const app = await buildApp();
    await app.inject({ method: 'POST', url: '/portal/bot/pause' });
    expect(pauseMock).toHaveBeenCalledWith('clone_outro', 'portal:7');
    await app.close();
  });
});

describe('POST /portal/bot/resume', () => {
  it('flag OFF -> 404', async () => {
    mockConfig.PORTAL_BOT_PAUSE = false;
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/bot/resume' });
    expect(res.statusCode).toBe(404);
    expect(resumeMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('owner_request -> 200 { bot_paused:false }; actor=portal:<userId>', async () => {
    resumeMock.mockResolvedValue({
      changed: true,
      flow_enabled: true,
      outcome: 'resumed',
      operational: makeOperational(),
      startap_kind: null,
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/bot/resume' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ bot_paused: false });
    expect(resumeMock).toHaveBeenCalledWith('clone_x', 'portal:7');
    await app.close();
  });

  it('suspenso pela Startap (billing) -> 409 suspensao_startap (cliente NÃO levanta)', async () => {
    // resume não destrava (changed:false); o estado atual é pause_locked -> 409.
    resumeMock.mockResolvedValue({
      changed: false,
      flow_enabled: false,
      outcome: 'startap_suspension',
      operational: makeOperational({ flow_enabled: false, suspended_kind: 'billing' }),
      startap_kind: 'billing',
    });
    getCloneMock.mockResolvedValue(makeClone({ flow_enabled: false, suspended_kind: 'billing' }));
    wahaMocks.getSessionStatus.mockResolvedValue({ status: 'WORKING' });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/bot/resume' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'suspensao_startap',
      message: 'Seu atendimento está pausado por cobrança. Regularize o pagamento para retomar.',
      suspension_kind: 'billing',
      denied_reason: 'startap_billing',
    });
    await app.close();
  });

  it('manual_other -> 409 suspensao_startap', async () => {
    resumeMock.mockResolvedValue({
      changed: false,
      flow_enabled: false,
      outcome: 'startap_suspension',
      operational: makeOperational({ flow_enabled: false, suspended_kind: 'manual_other' }),
      startap_kind: 'manual_other',
    });
    getCloneMock.mockResolvedValue(
      makeClone({ flow_enabled: false, suspended_kind: 'manual_other' }),
    );
    wahaMocks.getSessionStatus.mockResolvedValue({ status: 'WORKING' });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/bot/resume' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('suspensao_startap');
    await app.close();
  });

  it('abuse -> 409 suspensao_startap', async () => {
    resumeMock.mockResolvedValue({
      changed: false,
      flow_enabled: false,
      outcome: 'startap_suspension',
      operational: makeOperational({ flow_enabled: false, suspended_kind: 'abuse' }),
      startap_kind: 'abuse',
    });
    getCloneMock.mockResolvedValue(makeClone({ flow_enabled: false, suspended_kind: 'abuse' }));
    wahaMocks.getSessionStatus.mockResolvedValue({ status: 'WORKING' });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/bot/resume' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('suspensao_startap');
    await app.close();
  });

  it('já ativo (nada a fazer) -> 200 bot_paused:false (idempotente)', async () => {
    resumeMock.mockResolvedValue({
      changed: false,
      flow_enabled: true,
      outcome: 'already_active',
      operational: makeOperational(),
      startap_kind: null,
    });
    getCloneMock.mockResolvedValue(makeClone({ flow_enabled: true, suspended_kind: null }));
    wahaMocks.getSessionStatus.mockResolvedValue({ status: 'WORKING' });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/bot/resume' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ bot_paused: false });
    await app.close();
  });

  it('owner_request overdue -> 409 billing_overdue, preserva pausa no snapshot final', async () => {
    const overdue = makeOperational({
      flow_enabled: false,
      suspended_kind: 'owner_request',
      next_due_date: '2020-01-01',
    });
    resumeMock.mockResolvedValue({
      changed: false,
      flow_enabled: false,
      outcome: 'billing_overdue',
      operational: overdue,
      startap_kind: null,
    });
    wahaMocks.getSessionStatus.mockResolvedValue({ status: 'WORKING' });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/bot/resume' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'billing_overdue',
      bot_paused: true,
      operational_state: {
        owner_pause: { active: true },
        billing: { blocking: true },
        actions: { resume_owner: { allowed: false, denied_reason: 'billing_overdue' } },
      },
    });
    expect(resumeMock).toHaveBeenCalledWith('clone_x', 'portal:7');
    await app.close();
  });
});
