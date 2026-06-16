/**
 * Testes do GET/POST/PATCH/DELETE /portal/equipe (Fatia 1 — painel de
 * estabelecimento).
 *
 * Invariantes cobertos:
 *  - GATING em PROFUNDIDADE: flag OFF -> 404; product_type individual -> 409.
 *  - Anti-IDOR: o slot SEMPRE vem da sessão (withTenant) — nunca do body/params;
 *    a data layer (cloneColaboradores) é chamada com o slot injetado.
 *  - seat_cap / homônimo (ColaboradorRuleError) viram 409.
 *  - 404 quando o colaborador não existe NESTE slot (update/delete -> null/false).
 *
 * DB e config mockados (mesmo padrão de portal-perfil.test.ts). A flag
 * ESTABELECIMENTO_ENABLED é variável por teste (reconfigura o mock de config).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Tudo o que as factories de vi.mock (içadas pro topo) referenciam vai DENTRO de
// vi.hoisted — senão dá TDZ ("Cannot access X before initialization"). Inclui o
// configMock (mutável por teste pra alternar a flag) e a classe de erro.
const {
  configMock,
  ColaboradorRuleError,
  getScopeBySlotMock,
  listBySlotMock,
  createMock,
  updateMock,
  removeMock,
} = vi.hoisted(() => {
  class ColaboradorRuleError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'ColaboradorRuleError';
      this.code = code;
    }
  }
  return {
    configMock: { ESTABELECIMENTO_ENABLED: true } as { ESTABELECIMENTO_ENABLED: boolean },
    ColaboradorRuleError,
    getScopeBySlotMock: vi.fn(),
    listBySlotMock: vi.fn(),
    createMock: vi.fn(),
    updateMock: vi.fn(),
    removeMock: vi.fn(),
  };
});

vi.mock('../config.js', () => ({ config: configMock }));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('@startap/db', () => ({
  ColaboradorRuleError,
  cloneColaboradores: {
    getScopeBySlot: (...a: unknown[]) => getScopeBySlotMock(...a),
    listBySlot: (...a: unknown[]) => listBySlotMock(...a),
    create: (...a: unknown[]) => createMock(...a),
    update: (...a: unknown[]) => updateMock(...a),
    remove: (...a: unknown[]) => removeMock(...a),
  },
  portalUsers: { getSlotForActivePortalUser: vi.fn() },
}));

const injectedSlot = 'clone_bruna_estab';
vi.mock('../lib/tenant.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/tenant.js')>('../lib/tenant.js');
  return {
    ...actual,
    withTenant: vi.fn(async (req: { tenant?: unknown }) => {
      req.tenant = { slot: injectedSlot, userId: 9, username: 'dona', sid: 'sid-x' };
    }),
  };
});

import Fastify, { type FastifyInstance } from 'fastify';
import { portalEquipeRoutes } from './portal-equipe.js';

const ESTAB_SCOPE = { product_type: 'estabelecimento', seat_cap: 3, tenant_id: 'tid-1' };
const COLAB = {
  id: 1,
  nome: 'Ana',
  gcal_calendar_id: null,
  gcal_status: 'pending',
  servicos: ['Corte'],
  ativo: true,
  ordem: 0,
  created_at: '2026-06-15T00:00:00Z',
  updated_at: '2026-06-15T00:00:00Z',
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalEquipeRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  configMock.ESTABELECIMENTO_ENABLED = true;
  getScopeBySlotMock.mockResolvedValue(ESTAB_SCOPE);
});

describe('gating', () => {
  it('404 quando a flag ESTABELECIMENTO_ENABLED está OFF', async () => {
    configMock.ESTABELECIMENTO_ENABLED = false;
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/equipe' });
    expect(res.statusCode).toBe(404);
    expect(getScopeBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('409 quando o cliente é individual (product_type != estabelecimento)', async () => {
    getScopeBySlotMock.mockResolvedValue({
      product_type: 'individual',
      seat_cap: null,
      tenant_id: 'x',
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/equipe' });
    expect(res.statusCode).toBe(409);
    expect(listBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('GET /portal/equipe', () => {
  it('200: lista + uso de vagas, escopado pelo slot da sessão', async () => {
    listBySlotMock.mockResolvedValue([COLAB, { ...COLAB, id: 2, ativo: false }]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/equipe' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.seat_cap).toBe(3);
    expect(body.usados).toBe(1); // só os ativos
    expect(body.colaboradores).toHaveLength(2);
    // Anti-IDOR: leitura escopada pelo slot da SESSÃO.
    expect(listBySlotMock).toHaveBeenCalledWith(injectedSlot);
    await app.close();
  });
});

describe('POST /portal/equipe', () => {
  it('201: cria com o slot+tenant da sessão (nunca do body)', async () => {
    createMock.mockResolvedValue(COLAB);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/equipe',
      // slot no body deve ser IGNORADO (strict schema rejeita, mas mesmo se passasse
      // o create é chamado com o slot da sessão).
      payload: { nome: 'Ana', servicos: ['Corte'] },
    });
    expect(res.statusCode).toBe(201);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0]).toMatchObject({
      slot: injectedSlot,
      tenantId: 'tid-1',
      nome: 'Ana',
    });
    expect(createMock.mock.calls[0][1]).toBe(3); // seatCap repassado
    await app.close();
  });

  it('400: nome vazio (schema)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/equipe', payload: { nome: '' } });
    expect(res.statusCode).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('400: campo extra (strict — ex.: tentar setar gcal/tenant pelo portal)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/equipe',
      payload: { nome: 'Ana', gcal_calendar_id: 'x@grupo', tenant_id: 'forjado' },
    });
    expect(res.statusCode).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('409: seat_cap cheio (ColaboradorRuleError)', async () => {
    createMock.mockRejectedValue(
      new ColaboradorRuleError('seat_cap_full', 'limite do plano atingido (3 vagas).'),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/equipe',
      payload: { nome: 'Ana' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('seat_cap_full');
    await app.close();
  });
});

describe('PATCH /portal/equipe/:id', () => {
  it('200: edita escopado por slot+id', async () => {
    updateMock.mockResolvedValue({ ...COLAB, nome: 'Ana B' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/equipe/1',
      payload: { nome: 'Ana B' },
    });
    expect(res.statusCode).toBe(200);
    expect(updateMock).toHaveBeenCalledWith(
      injectedSlot,
      1,
      expect.objectContaining({ nome: 'Ana B' }),
      3,
    );
    await app.close();
  });

  it('400: id inválido', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/equipe/0',
      payload: { nome: 'X' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400: corpo vazio (nada a atualizar)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'PATCH', url: '/portal/equipe/1', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('404: colaborador não existe neste slot (update -> null)', async () => {
    updateMock.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/equipe/77',
      payload: { ativo: true },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('DELETE /portal/equipe/:id', () => {
  it('200: remove escopado por slot+id', async () => {
    removeMock.mockResolvedValue(true);
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/portal/equipe/1' });
    expect(res.statusCode).toBe(200);
    expect(removeMock).toHaveBeenCalledWith(injectedSlot, 1);
    await app.close();
  });

  it('404: nada removido (remove -> false)', async () => {
    removeMock.mockResolvedValue(false);
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/portal/equipe/99' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
