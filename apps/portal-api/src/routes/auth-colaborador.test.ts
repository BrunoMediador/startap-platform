/**
 * Login de COLABORADOR pelo /auth/login (SCRUM-32). Mesma disciplina do owner: compare
 * bcrypt, lockout, respostas genéricas. Sessão nasce com role='colaborador' + colaboradorId.
 *
 * Prova:
 *  - flag OFF -> NUNCA tenta credencial de colaborador (byte-a-byte como hoje).
 *  - flag ON + senha certa -> 200 role=colaborador + createSession com role/colaboradorId.
 *  - senha errada -> 401 + recordColaboradorFailedLogin (lockout).
 *  - colaborador inativo -> 403.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { configMock } = vi.hoisted(() => ({
  configMock: {
    PORTAL_BCRYPT_COST: 12,
    NODE_ENV: 'test',
    PORTAL_LOGIN_MAX_ATTEMPTS: 5,
    PORTAL_LOGIN_LOCK_MINUTES: 15,
    PORTAL_SESSION_TTL_SECONDS: 3600,
    PORTAL_COOKIE_SECURE: false,
    COLABORADOR_PORTAL_ENABLED: false,
    ATENDIMENTOS_ENABLED: false,
    ATEND_FROM_AGENDA_SLOTS: '',
    ESTABELECIMENTO_ENABLED: false,
  } as Record<string, unknown>,
}));

vi.mock('../config.js', () => ({ config: configMock }));
vi.mock('@startap/db', () => ({
  portalUsers: {
    findPortalUserForAuth: vi.fn(),
    listPortalUsernames: vi.fn(),
    findPortalUserAuthById: vi.fn(),
  },
  colaboradorAuth: {
    findColaboradorForAuth: vi.fn(),
    recordColaboradorFailedLogin: vi.fn(),
    recordColaboradorSuccessfulLogin: vi.fn(),
    findColaboradorAuthById: vi.fn(),
  },
  cloneColaboradores: { getScopeBySlot: vi.fn() },
}));
vi.mock('bcryptjs', () => ({ default: { compare: vi.fn(), hash: vi.fn() } }));
vi.mock('../lib/session.js', () => ({
  createSession: vi.fn(),
  destroySession: vi.fn(),
  invalidateOtherUserSessions: vi.fn(),
}));
vi.mock('../lib/tenant.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/tenant.js')>('../lib/tenant.js');
  return { ...actual, withTenant: vi.fn(), withColaborador: vi.fn() };
});

import cookie from '@fastify/cookie';
import { colaboradorAuth, portalUsers } from '@startap/db';
import bcrypt from 'bcryptjs';
import Fastify, { type FastifyInstance } from 'fastify';
import { createSession } from '../lib/session.js';
import { authRoutes } from './auth.js';

const findOwnerMock = vi.mocked(portalUsers.findPortalUserForAuth);
const listUsernamesMock = vi.mocked(portalUsers.listPortalUsernames);
const findColabMock = vi.mocked(colaboradorAuth.findColaboradorForAuth);
const recordColabFailMock = vi.mocked(colaboradorAuth.recordColaboradorFailedLogin);
const recordColabOkMock = vi.mocked(colaboradorAuth.recordColaboradorSuccessfulLogin);
const compareMock = vi.mocked(bcrypt.compare);
const createSessionMock = vi.mocked(createSession);

const COLAB = {
  colaborador_id: 7,
  slot: 'clone_seven',
  tenant_id: 'tid-7',
  username: 'bene-silva',
  nome: 'Bene Silva',
  password_hash: '$2a$12$colabhash',
  active: true,
  colaborador_ativo: true,
  failed_attempts: 0,
  locked_until: null,
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: 'segredo-de-teste-com-32-caracteres!!' });
  await app.register(authRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  configMock.COLABORADOR_PORTAL_ENABLED = false;
  findOwnerMock.mockResolvedValue(null);
  listUsernamesMock.mockResolvedValue([]);
});

describe('POST /auth/login — colaborador (SCRUM-32)', () => {
  it('flag OFF: NUNCA toca colaborador_auth (byte-a-byte como hoje) -> 401 genérico', async () => {
    configMock.COLABORADOR_PORTAL_ENABLED = false;
    compareMock.mockResolvedValue(false as never);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'bene-silva', password: 'qualquer' },
    });
    expect(res.statusCode).toBe(401);
    expect(findColabMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('flag ON + senha certa: 200 role=colaborador e cria sessão com role/colaboradorId', async () => {
    configMock.COLABORADOR_PORTAL_ENABLED = true;
    findColabMock.mockResolvedValue(COLAB);
    compareMock.mockResolvedValue(true as never);
    createSessionMock.mockResolvedValue('sid-colab');

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'Bene-Silva', password: 'senhaForte99' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.role).toBe('colaborador');
    expect(body.user.username).toBe('bene-silva');
    expect(recordColabOkMock).toHaveBeenCalledWith(7);
    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'colaborador', colaboradorId: 7, slot: 'clone_seven' }),
    );
    await app.close();
  });

  it('flag ON + senha errada: 401 e registra a falha (lockout)', async () => {
    configMock.COLABORADOR_PORTAL_ENABLED = true;
    findColabMock.mockResolvedValue(COLAB);
    compareMock.mockResolvedValue(false as never);
    recordColabFailMock.mockResolvedValue({ failed_attempts: 1, locked_until: null });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'bene-silva', password: 'errada' },
    });

    expect(res.statusCode).toBe(401);
    expect(recordColabFailMock).toHaveBeenCalledWith(7, 5, 15);
    expect(createSessionMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('flag ON + colaborador inativo: 403 (sem compare de senha)', async () => {
    configMock.COLABORADOR_PORTAL_ENABLED = true;
    findColabMock.mockResolvedValue({ ...COLAB, colaborador_ativo: false });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'bene-silva', password: 'senhaForte99' },
    });

    expect(res.statusCode).toBe(403);
    expect(compareMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('flag ON mas username não é colaborador: cai no 401 genérico (sem oráculo)', async () => {
    configMock.COLABORADOR_PORTAL_ENABLED = true;
    findColabMock.mockResolvedValue(null);
    compareMock.mockResolvedValue(false as never);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'fantasma', password: 'x' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'usuario ou senha invalidos' });
    await app.close();
  });
});
