import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks ANTES de importar o modulo sob teste.
// config.js valida process.env no import (lanca se faltar var) — mockamos para o teste.
vi.mock('../config.js', () => ({
  config: { PORTAL_BCRYPT_COST: 12, NODE_ENV: 'test' },
}));
vi.mock('@startap/db', () => ({
  portalUsers: {
    findPortalUserAuthById: vi.fn(),
    changePortalUserPassword: vi.fn(),
  },
}));
vi.mock('bcryptjs', () => ({
  default: { compare: vi.fn(), hash: vi.fn() },
}));
vi.mock('../lib/session.js', () => ({
  createSession: vi.fn(),
  destroySession: vi.fn(),
  invalidateOtherUserSessions: vi.fn(),
}));
// withTenant stub: injeta um tenant fixo (a unidade de auth real vive em tenant.test.ts).
vi.mock('../lib/tenant.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/tenant.js')>('../lib/tenant.js');
  return {
    ...actual,
    withTenant: vi.fn(async (req: { tenant?: unknown }) => {
      req.tenant = { slot: 'clone_x', userId: 7, username: 'cirilo', sid: 'sid-atual' };
    }),
  };
});

import { portalUsers } from '@startap/db';
import bcrypt from 'bcryptjs';
import Fastify, { type FastifyInstance } from 'fastify';
import { invalidateOtherUserSessions } from '../lib/session.js';
import { authRoutes, changePasswordSchema } from './auth.js';

const findByIdMock = vi.mocked(portalUsers.findPortalUserAuthById);
const changePwMock = vi.mocked(portalUsers.changePortalUserPassword);
const compareMock = vi.mocked(bcrypt.compare);
const hashMock = vi.mocked(bcrypt.hash);
const invalidateMock = vi.mocked(invalidateOtherUserSessions);

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(authRoutes);
  await app.ready();
  return app;
}

const ACTIVE_USER = {
  id: 7,
  slot: 'clone_x',
  username: 'cirilo',
  password_hash: '$2a$12$hashatual',
  display_name: 'Cirilo',
  active: true,
  must_change_password: true,
  failed_attempts: 0,
  locked_until: null,
  last_login_at: null,
  created_at: new Date(),
  updated_at: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Schema ──────────────────────────────────────────────────────────────────
describe('changePasswordSchema', () => {
  it('aceita new_password de 8 chars', () => {
    const r = changePasswordSchema.safeParse({ current_password: 'x', new_password: '12345678' });
    expect(r.success).toBe(true);
  });

  it('rejeita new_password com menos de 8 chars', () => {
    const r = changePasswordSchema.safeParse({ current_password: 'x', new_password: '1234567' });
    expect(r.success).toBe(false);
  });

  it('rejeita new_password com mais de 72 chars (limite bcrypt)', () => {
    const r = changePasswordSchema.safeParse({
      current_password: 'x',
      new_password: 'a'.repeat(73),
    });
    expect(r.success).toBe(false);
  });

  it('rejeita current_password vazia', () => {
    const r = changePasswordSchema.safeParse({ current_password: '', new_password: '12345678' });
    expect(r.success).toBe(false);
  });
});

// ── Fluxo POST /auth/change-password ──────────────────────────────────────────
describe('POST /auth/change-password', () => {
  it('200 no caminho feliz: troca o hash e invalida as demais sessoes', async () => {
    findByIdMock.mockResolvedValue(ACTIVE_USER);
    compareMock.mockResolvedValue(true as never);
    hashMock.mockResolvedValue('$2a$12$novohash' as never);
    changePwMock.mockResolvedValue({ ...ACTIVE_USER, must_change_password: false });
    invalidateMock.mockResolvedValue(2);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/change-password',
      payload: { current_password: 'senhaAtual1', new_password: 'novaSenhaForte9' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(hashMock).toHaveBeenCalledWith('novaSenhaForte9', 12);
    expect(changePwMock).toHaveBeenCalledWith(7, '$2a$12$novohash');
    // mantem a sessao atual, derruba as outras
    expect(invalidateMock).toHaveBeenCalledWith(7, 'sid-atual');
    await app.close();
  });

  it('400 quando new_password tem menos de 8 chars', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/change-password',
      payload: { current_password: 'senhaAtual1', new_password: 'curta' },
    });
    expect(res.statusCode).toBe(400);
    expect(changePwMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('401 quando a senha atual esta incorreta (sem gravar nada)', async () => {
    findByIdMock.mockResolvedValue(ACTIVE_USER);
    compareMock.mockResolvedValue(false as never);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/change-password',
      payload: { current_password: 'errada', new_password: 'novaSenhaForte9' },
    });

    expect(res.statusCode).toBe(401);
    expect(changePwMock).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('400 quando a nova senha e igual a atual', async () => {
    findByIdMock.mockResolvedValue(ACTIVE_USER);
    compareMock.mockResolvedValue(true as never);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/change-password',
      payload: { current_password: 'mesmaSenha12', new_password: 'mesmaSenha12' },
    });

    expect(res.statusCode).toBe(400);
    expect(changePwMock).not.toHaveBeenCalled();
    await app.close();
  });
});
