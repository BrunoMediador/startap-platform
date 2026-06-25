/**
 * Testes do GET/PATCH /portal/equipe (Fatia 1 — painel de estabelecimento).
 *
 * O portal do cliente só LISTA (GET) e EDITA (PATCH: renomear/serviços/ativo/ordem)
 * as vagas pré-provisionadas. CRIAR (POST) e EXCLUIR (DELETE) foram REMOVIDOS do
 * portal de propósito (preço por barbeiro; agendas pré-provisionadas pelo operador)
 * — viram 404 de rota inexistente. Criar/excluir seguem só no gestão.
 *
 * Invariantes cobertos:
 *  - POST/DELETE /portal/equipe -> 404 (rotas inexistentes; trava de verdade).
 *  - GATING em PROFUNDIDADE: flag OFF -> 404; product_type individual -> 409.
 *  - Anti-IDOR: o slot SEMPRE vem da sessão (withTenant) — nunca do body/params;
 *    a data layer (cloneColaboradores) é chamada com o slot injetado.
 *  - seat_cap / homônimo (ColaboradorRuleError) viram 409 (ao ATIVAR/renomear).
 *  - 404 quando o colaborador não existe NESTE slot (update -> null).
 *
 * DB e config mockados (mesmo padrão de portal-perfil.test.ts). A flag
 * ESTABELECIMENTO_ENABLED é variável por teste (reconfigura o mock de config).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Tudo o que as factories de vi.mock (içadas pro topo) referenciam vai DENTRO de
// vi.hoisted — senão dá TDZ ("Cannot access X before initialization"). Inclui o
// configMock (mutável por teste pra alternar a flag) e a classe de erro.
const { configMock, ColaboradorRuleError, getScopeBySlotMock, listBySlotMock, updateMock } =
  vi.hoisted(() => {
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
      updateMock: vi.fn(),
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
    update: (...a: unknown[]) => updateMock(...a),
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
  comissao_pct: 0,
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

describe('POST /portal/equipe (removido — criar é só no gestão)', () => {
  // Trava de verdade (não só de UI): a rota de criação não existe mais no portal.
  // Criar pelo portal geraria barbeiro SEM agenda e furaria o preço por barbeiro.
  it('404: criar colaborador pelo portal não existe', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/equipe',
      payload: { nome: 'Ana', servicos: ['Corte'] },
    });
    expect(res.statusCode).toBe(404);
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

  it('200: PATCH só de comissao_pct repassa o campo (update parcial)', async () => {
    updateMock.mockResolvedValue({ ...COLAB, comissao_pct: 25 });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/equipe/1',
      payload: { comissao_pct: 25 },
    });
    expect(res.statusCode).toBe(200);
    // O patch repassado ao data layer contém SÓ comissao_pct (não inventa nome/ativo).
    expect(updateMock.mock.calls[0][2]).toEqual({ comissao_pct: 25 });
    expect(res.json().colaborador.comissao_pct).toBe(25);
    await app.close();
  });

  it('400: PATCH com comissao_pct negativo é rejeitado pelo schema', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/equipe/1',
      payload: { comissao_pct: -5 },
    });
    expect(res.statusCode).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
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

  it('409: ativar além do seat_cap (ColaboradorRuleError) — limite por barbeiro', async () => {
    updateMock.mockRejectedValue(
      new ColaboradorRuleError('seat_cap_full', 'limite do plano atingido (3 vagas).'),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/equipe/1',
      payload: { ativo: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('seat_cap_full');
    await app.close();
  });
});

describe('DELETE /portal/equipe/:id (removido — excluir é só no gestão)', () => {
  // Trava de verdade: a rota de exclusão não existe mais no portal. Excluir pelo
  // portal apagaria a agenda pré-provisionada e quebraria o setup + o modelo de custo.
  it('404: excluir colaborador pelo portal não existe', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/portal/equipe/1' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
