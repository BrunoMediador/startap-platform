/**
 * Testes do POST /portal/equipe/:id/gerar-senha — o DONO gera/regenera a senha de login
 * de um colaborador DELE pelo portal (paridade com o botão do gestão, SCRUM-32 follow-up).
 *
 * Invariantes cobertos:
 *  - GATING: flag COLABORADOR_PORTAL_ENABLED OFF -> 404; product_type individual -> 409.
 *  - ANTI-IDOR: o colaborador é resolvido por listBySlot(slot da SESSÃO); um :id que não
 *    está nesse slot (outro tenant) -> 404 e upsertCredentials NUNCA é chamado.
 *  - Caminho feliz: 201 com { username, generated_password }; upsertCredentials recebe o
 *    slot da sessão + tenant do escopo + o HASH (nunca o plaintext); resposta no-store.
 *
 * DB / config / lib de senha mockados (mesmo padrão de portal-equipe.test.ts). bcrypt é
 * mockado pra não pagar o custo do hash e pra provar que o HASH (não o plaintext) é o que
 * vai pro banco.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  configMock,
  getScopeBySlotMock,
  listBySlotMock,
  listTakenUsernamesMock,
  deriveUsernameMock,
  upsertCredentialsMock,
  genPasswordMock,
  bcryptHashMock,
} = vi.hoisted(() => ({
  configMock: {
    COLABORADOR_PORTAL_ENABLED: true,
    ESTABELECIMENTO_ENABLED: true,
    PORTAL_BCRYPT_COST: 4,
  } as {
    COLABORADOR_PORTAL_ENABLED: boolean;
    ESTABELECIMENTO_ENABLED: boolean;
    PORTAL_BCRYPT_COST: number;
  },
  getScopeBySlotMock: vi.fn(),
  listBySlotMock: vi.fn(),
  listTakenUsernamesMock: vi.fn(),
  deriveUsernameMock: vi.fn(),
  upsertCredentialsMock: vi.fn(),
  genPasswordMock: vi.fn(),
  bcryptHashMock: vi.fn(),
}));

vi.mock('../config.js', () => ({ config: configMock }));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('@startap/db', () => ({
  ColaboradorRuleError: class extends Error {},
  cloneColaboradores: {
    getScopeBySlot: (...a: unknown[]) => getScopeBySlotMock(...a),
    listBySlot: (...a: unknown[]) => listBySlotMock(...a),
    update: vi.fn(),
  },
  colaboradorAuth: {
    listTakenUsernames: (...a: unknown[]) => listTakenUsernamesMock(...a),
    deriveColaboradorUsername: (...a: unknown[]) => deriveUsernameMock(...a),
    upsertCredentials: (...a: unknown[]) => upsertCredentialsMock(...a),
  },
  portalUsers: { getSlotForActivePortalUser: vi.fn() },
}));

vi.mock('../lib/colaborador-credencial.js', () => ({
  genColaboradorPassword: (...a: unknown[]) => genPasswordMock(...a),
}));

vi.mock('bcryptjs', () => ({ default: { hash: (...a: unknown[]) => bcryptHashMock(...a) } }));

const injectedSlot = 'clone_estab_dono';
vi.mock('../lib/tenant.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/tenant.js')>('../lib/tenant.js');
  return {
    ...actual,
    withTenant: vi.fn(async (req: { tenant?: unknown }) => {
      req.tenant = { slot: injectedSlot, userId: 7, username: 'dona', sid: 'sid-x' };
    }),
  };
});

import Fastify, { type FastifyInstance } from 'fastify';
import { portalEquipeRoutes } from './portal-equipe.js';

const ESTAB_SCOPE = { product_type: 'estabelecimento', seat_cap: 5, tenant_id: 'tid-9' };
const COLAB = {
  id: 3,
  nome: 'Thomas',
  gcal_calendar_id: null,
  gcal_status: 'active',
  servicos: [],
  ativo: true,
  ordem: 0,
  comissao_pct: 50,
  created_at: '2026-06-20T00:00:00Z',
  updated_at: '2026-06-20T00:00:00Z',
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalEquipeRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  configMock.COLABORADOR_PORTAL_ENABLED = true;
  configMock.ESTABELECIMENTO_ENABLED = true;
  getScopeBySlotMock.mockResolvedValue(ESTAB_SCOPE);
  listBySlotMock.mockResolvedValue([COLAB]);
  listTakenUsernamesMock.mockResolvedValue([]);
  deriveUsernameMock.mockReturnValue('thomas');
  genPasswordMock.mockReturnValue('Plain1senhAxy');
  bcryptHashMock.mockResolvedValue('HASHED::bcrypt');
  upsertCredentialsMock.mockResolvedValue({ colaborador_id: 3, username: 'thomas' });
});

describe('gating', () => {
  it('404 quando COLABORADOR_PORTAL_ENABLED está OFF', async () => {
    configMock.COLABORADOR_PORTAL_ENABLED = false;
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/equipe/3/gerar-senha' });
    expect(res.statusCode).toBe(404);
    expect(getScopeBySlotMock).not.toHaveBeenCalled();
    expect(upsertCredentialsMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('409 quando o cliente é individual (product_type != estabelecimento)', async () => {
    getScopeBySlotMock.mockResolvedValue({
      product_type: 'individual',
      seat_cap: null,
      tenant_id: 'x',
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/equipe/3/gerar-senha' });
    expect(res.statusCode).toBe(409);
    expect(upsertCredentialsMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('anti-IDOR', () => {
  it('404 quando o :id não pertence ao slot da sessão (não está em listBySlot)', async () => {
    // listBySlot é escopado pelo slot da SESSÃO; o id 999 (outro tenant) não aparece.
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/equipe/999/gerar-senha' });
    expect(res.statusCode).toBe(404);
    expect(listBySlotMock).toHaveBeenCalledWith(injectedSlot);
    expect(upsertCredentialsMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('400 quando o :id é inválido', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/equipe/0/gerar-senha' });
    expect(res.statusCode).toBe(400);
    expect(upsertCredentialsMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('caminho feliz', () => {
  it('201: gera senha, grava o HASH (não o plaintext) escopado no slot/tenant da sessão', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/equipe/3/gerar-senha' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toEqual({ ok: true, username: 'thomas', generated_password: 'Plain1senhAxy' });

    // Hash gerado com o cost do config; só o HASH vai pro banco — nunca o plaintext.
    expect(bcryptHashMock).toHaveBeenCalledWith('Plain1senhAxy', 4);
    expect(upsertCredentialsMock).toHaveBeenCalledWith({
      colaboradorId: 3,
      slot: injectedSlot, // anti-IDOR: slot da SESSÃO, nunca de input
      tenantId: 'tid-9', // tenant resolvido do escopo do clone
      username: 'thomas',
      passwordHash: 'HASHED::bcrypt',
    });
    // O plaintext NÃO pode ter ido pro banco.
    expect(upsertCredentialsMock.mock.calls[0][0].passwordHash).not.toBe('Plain1senhAxy');

    // Resposta com segredo nunca cacheia.
    expect(res.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  // REGRESSÃO (bug de produção 2026-06-27): clone_colaboradores.id é BIGINT e o driver pg
  // devolve bigint como STRING ('3'), não number. O :id da rota vem como number (parseId).
  // O lookup `c.id === id` ('3' === 3) dava SEMPRE false -> 404 "colaborador nao encontrado",
  // mesmo o colaborador EXISTINDO no slot do dono. O fix normaliza os dois lados (Number).
  it('201: acha o colaborador mesmo quando listBySlot devolve id como STRING (bigint do pg)', async () => {
    listBySlotMock.mockResolvedValue([{ ...COLAB, id: '3' as unknown as number }]);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/equipe/3/gerar-senha' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      ok: true,
      username: 'thomas',
      generated_password: 'Plain1senhAxy',
    });
    expect(upsertCredentialsMock).toHaveBeenCalledTimes(1);
    // O colaboradorId gravado é o :id numérico da rota (3), não a string crua.
    expect(upsertCredentialsMock.mock.calls[0][0].colaboradorId).toBe(3);
    await app.close();
  });
});
