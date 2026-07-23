/**
 * Testes de GET/PUT /portal/cartao-config (SCRUM-92 inc.2 / ADR 0032).
 *
 * Invariantes provados:
 *  - gate DUPLO: mode='runtime' só com CARTAO_RUNTIME_ENABLED ON E cartao_mode='runtime';
 *  - allowlist FECHADA de emoji server-side: tag chars / fora-do-catálogo / chave desconhecida = 400;
 *  - anti-IDOR: setCartaoConfigBySlot escopado ao slot da SESSÃO (nunca do body);
 *  - PUT em clone baked → 409; edição dropa `verbatim` (vira cartão montado com a escolha do dono);
 *  - GET de clone MIGRADO (verbatim) SEED o picker com os emojis do cartão legado + preview verbatim.
 *
 * @startap/integrations é REAL (funções puras — fidelidade do preview/allowlist); db/config/tenant
 * mockados (padrão de portal-frases-pausa.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { configMock, getCartaoMock, getProductTypeMock, setConfigMock } = vi.hoisted(() => ({
  configMock: { CARTAO_RUNTIME_ENABLED: true } as { CARTAO_RUNTIME_ENABLED: boolean },
  getCartaoMock: vi.fn(),
  getProductTypeMock: vi.fn(),
  setConfigMock: vi.fn(),
}));

vi.mock('../config.js', () => ({ config: configMock }));
vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('@startap/db', () => ({
  cloneColaboradores: {
    getAreaPromptCustomCartao: (...a: unknown[]) => getCartaoMock(...a),
    getProductType: (...a: unknown[]) => getProductTypeMock(...a),
    setCartaoConfigBySlot: (...a: unknown[]) => setConfigMock(...a),
  },
}));

const injectedSlot = 'clone_cirilobarbearia_c8w2f0';
vi.mock('../lib/tenant.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/tenant.js')>('../lib/tenant.js');
  return {
    ...actual,
    withTenant: vi.fn(async (req: { tenant?: unknown }) => {
      req.tenant = { slot: injectedSlot, userId: 1, username: 'cirilo', sid: 'sid-1' };
    }),
  };
});

import Fastify, { type FastifyInstance } from 'fastify';
import { portalCartaoConfigRoutes } from './portal-cartao-config.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalCartaoConfigRoutes);
  await app.ready();
  return app;
}

function mockClone(over: Record<string, unknown> = {}): void {
  getCartaoMock.mockResolvedValue({
    area: 'barbearia',
    promptCustom: false,
    cartaoMode: 'runtime',
    cartaoConfig: null,
    nomeNegocio: 'Barbearia do Cirilo',
    ...over,
  });
}

describe('GET /portal/cartao-config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMock.CARTAO_RUNTIME_ENABLED = true;
    getProductTypeMock.mockResolvedValue('individual');
  });

  it('runtime (flag ON + cartao_mode runtime) → mode=runtime, defaults + preview', async () => {
    mockClone();
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/cartao-config' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('runtime');
    expect(body.canDisable).toBe(false);
    expect(body.config).toBeNull();
    expect(body.defaults.template).toBe('padrao');
    expect(body.defaults.emojis.marca).toBe('💈');
    expect(body.preview).toContain('inserir_agendamento');
    // Anti-IDOR: leu pelo slot da sessão.
    expect(getCartaoMock).toHaveBeenCalledWith(injectedSlot);
    await app.close();
  });

  it('gate DUPLO: flag ON mas cartao_mode=baked → mode=baked (UI some a seção)', async () => {
    mockClone({ cartaoMode: 'baked' });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/cartao-config' });
    expect(res.json().mode).toBe('baked');
    await app.close();
  });

  it('gate DUPLO: flag GLOBAL OFF → mode=baked mesmo com coluna runtime', async () => {
    configMock.CARTAO_RUNTIME_ENABLED = false;
    mockClone({ cartaoMode: 'runtime' });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/cartao-config' });
    expect(res.json().mode).toBe('baked');
    await app.close();
  });

  it('clone MIGRADO (verbatim): SEED do picker + preview = cartão legado literal', async () => {
    const legado = [
      '[CARTAO DE CONFIRMACAO]',
      '💈 Barbearia do Cirilo',
      '📅 DIA: <dia> / ⏰ HORARIO: <horario> / ✂️ SERVICO: <servico> / 💰 VALOR: <valor>',
      'Responda SIM ✅',
    ].join('\n');
    mockClone({ cartaoConfig: { verbatim: legado } });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/cartao-config' });
    const body = res.json();
    // preview = o cartão legado exato (verbatim vence o montado).
    expect(body.preview).toBe(legado);
    // config.emojis pré-preenchido com os emojis do cartão legado.
    expect(body.config.emojis.marca).toBe('💈');
    expect(body.config.emojis.servico).toBe('✂️');
    await app.close();
  });
});

describe('PUT /portal/cartao-config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMock.CARTAO_RUNTIME_ENABLED = true;
    getProductTypeMock.mockResolvedValue('individual');
    setConfigMock.mockResolvedValue(true);
  });

  it('emojis válidos + template → 200, grava { template, emojis } SEM verbatim, no slot da sessão', async () => {
    mockClone();
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'compacto', emojis: { marca: '💇', valor: '💵' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe('runtime');
    expect(setConfigMock).toHaveBeenCalledTimes(1);
    const [slotArg, cfgArg] = setConfigMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(slotArg).toBe(injectedSlot); // nunca do body
    expect(cfgArg).toEqual({ template: 'compacto', emojis: { marca: '💇', valor: '💵' } });
    expect(cfgArg).not.toHaveProperty('verbatim'); // edição dropa o legado
    await app.close();
  });

  it('tag chars coladas num emoji válido → 400 emoji_invalido (NÃO grava)', async () => {
    mockClone();
    const tagged = `💈${String.fromCodePoint(0xe0067)}`;
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'padrao', emojis: { marca: tagged } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('emoji_invalido');
    expect(res.json().campo).toBe('marca');
    expect(setConfigMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('emoji fora do catálogo → 400 emoji_invalido', async () => {
    mockClone();
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'padrao', emojis: { valor: '🎩' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().campo).toBe('valor');
    await app.close();
  });

  it('chave de emoji desconhecida → 400', async () => {
    mockClone();
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'padrao', emojis: { hack: '💈' } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('template inválido → 400 dados_invalidos', async () => {
    mockClone();
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'livre', emojis: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('dados_invalidos');
    await app.close();
  });

  it('campo extra no body (strict) → 400', async () => {
    mockClone();
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'padrao', emojis: {}, slot: 'outro' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('clone baked (não-runtime efetivo) → 409 cartao_baked (não grava)', async () => {
    mockClone({ cartaoMode: 'baked' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'padrao', emojis: { marca: '💈' } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('cartao_baked');
    expect(setConfigMock).not.toHaveBeenCalled();
    await app.close();
  });
});
