import { beforeEach, describe, expect, it, vi } from 'vitest';

// configMock e o mock de cloneColaboradores são içados pro topo (vi.hoisted) porque as
// factories de vi.mock referenciam essas refs — sem hoisted dá TDZ. configMock é MUTÁVEL
// por teste pra alternar ATENDIMENTOS_ENABLED/ESTABELECIMENTO_ENABLED no /auth/me.
const { configMock, getScopeBySlotMock } = vi.hoisted(() => ({
  configMock: {
    PORTAL_BCRYPT_COST: 12,
    NODE_ENV: 'test',
    PORTAL_LOGIN_MAX_ATTEMPTS: 5,
    PORTAL_LOGIN_LOCK_MINUTES: 15,
    PORTAL_SESSION_TTL_SECONDS: 3600,
    PORTAL_COOKIE_SECURE: false,
    ATENDIMENTOS_ENABLED: false,
    ATEND_FROM_AGENDA_SLOTS: '',
    ESTABELECIMENTO_ENABLED: false,
  } as Record<string, unknown>,
  getScopeBySlotMock: vi.fn(),
}));

// Mocks ANTES de importar o modulo sob teste.
// config.js valida process.env no import (lanca se faltar var) — mockamos para o teste.
vi.mock('../config.js', () => ({ config: configMock }));
vi.mock('@startap/db', () => ({
  portalUsers: {
    findPortalUserAuthById: vi.fn(),
    changePortalUserPassword: vi.fn(),
    findPortalUserForAuth: vi.fn(),
    listPortalUsernames: vi.fn(),
    getSlotForActivePortalUser: vi.fn(),
    recordSuccessfulLogin: vi.fn(),
    recordFailedLogin: vi.fn(),
  },
  cloneColaboradores: {
    getScopeBySlot: (...a: unknown[]) => getScopeBySlotMock(...a),
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

import cookie from '@fastify/cookie';
import { portalUsers } from '@startap/db';
import bcrypt from 'bcryptjs';
import Fastify, { type FastifyInstance } from 'fastify';
import { createSession, invalidateOtherUserSessions } from '../lib/session.js';
import { authRoutes, changePasswordSchema } from './auth.js';

const findByIdMock = vi.mocked(portalUsers.findPortalUserAuthById);
const changePwMock = vi.mocked(portalUsers.changePortalUserPassword);
const findForAuthMock = vi.mocked(portalUsers.findPortalUserForAuth);
const listUsernamesMock = vi.mocked(portalUsers.listPortalUsernames);
const getSlotMock = vi.mocked(portalUsers.getSlotForActivePortalUser);
const compareMock = vi.mocked(bcrypt.compare);
const hashMock = vi.mocked(bcrypt.hash);
const invalidateMock = vi.mocked(invalidateOtherUserSessions);

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: 'segredo-de-teste-com-32-caracteres!!' });
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
  // Estado padrão entre testes: flags OFF; scope individual sem tenant.
  configMock.ATENDIMENTOS_ENABLED = false;
  configMock.ATEND_FROM_AGENDA_SLOTS = '';
  configMock.ESTABELECIMENTO_ENABLED = false;
  getScopeBySlotMock.mockResolvedValue({
    product_type: 'individual',
    seat_cap: null,
    tenant_id: 'tid-1',
  });
});

// ── GET /auth/me — flag do app de gestão ─────────────────────────────────────
describe('GET /auth/me — atendimentos_enabled', () => {
  it('atendimentos_enabled=false quando a flag está OFF (sempre presente)', async () => {
    configMock.ATENDIMENTOS_ENABLED = false;
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.atendimentos_enabled).toBe(false);
    expect(body.username).toBe('cirilo');
    await app.close();
  });

  it('atendimentos_enabled=true quando a flag está ON', async () => {
    configMock.ATENDIMENTOS_ENABLED = true;
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(200);
    expect(res.json().atendimentos_enabled).toBe(true);
    await app.close();
  });

  it('campo presente mesmo pra individual (sem product_type/seat_cap no corpo)', async () => {
    configMock.ATENDIMENTOS_ENABLED = true;
    configMock.ESTABELECIMENTO_ENABLED = false; // não resolve scope -> individual
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    const body = res.json();
    expect(body.atendimentos_enabled).toBe(true);
    expect(body.product_type).toBeUndefined();
    expect(body.seat_cap).toBeUndefined();
    await app.close();
  });
});

// ── GET /auth/me — flag do billing derivado da agenda (ADR 0027) ─────────────
describe('GET /auth/me — atend_from_agenda (gate por-clone)', () => {
  it('atend_from_agenda=false quando a lista está vazia (OFF pra todos; sempre presente)', async () => {
    configMock.ATEND_FROM_AGENDA_SLOTS = '';
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(200);
    expect(res.json().atend_from_agenda).toBe(false);
    await app.close();
  });

  it('atend_from_agenda=true quando o SLOT desta sessão está na lista (independe de atendimentos_enabled)', async () => {
    // a sessão de teste é slot 'clone_x' (stub do withTenant).
    configMock.ATEND_FROM_AGENDA_SLOTS = 'clone_x';
    configMock.ATENDIMENTOS_ENABLED = false;
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    const body = res.json();
    expect(body.atend_from_agenda).toBe(true);
    expect(body.atendimentos_enabled).toBe(false);
    await app.close();
  });

  it('atend_from_agenda=false quando o SLOT desta sessão está FORA da lista (Cirilo/Samuel)', async () => {
    // lista liga SÓ o dragon; a sessão é clone_x -> deve ficar OFF.
    configMock.ATEND_FROM_AGENDA_SLOTS = 'clone_barber_dragon_caly8b';
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.json().atend_from_agenda).toBe(false);
    await app.close();
  });
});

// ── Login: número de WhatsApp em qualquer formatação (PR #268) ───────────────
describe('POST /auth/login — fallback canônico de telefone', () => {
  const PHONE_USER = {
    ...ACTIVE_USER,
    id: 21,
    slot: 'clone_barbearia_x_ab12cd',
    username: '553199998842', // canônico — como o signup grava
    display_name: 'Barbearia X',
    must_change_password: false,
  };

  function arrangeHappyLogin() {
    compareMock.mockResolvedValue(true as never);
    getSlotMock.mockResolvedValue(PHONE_USER.slot);
    vi.mocked(createSession).mockResolvedValue('sid-novo');
    listUsernamesMock.mockResolvedValue([
      { id: 7, username: 'cirilo' },
      { id: 21, username: PHONE_USER.username },
    ]);
  }

  it('digitar o número MASCARADO "(31) 99999-8842" acha a conta canônica (achado do frontend)', async () => {
    arrangeHappyLogin();
    // 1ª busca (input cru) falha; 2ª (canônico) acha.
    findForAuthMock.mockResolvedValueOnce(null).mockResolvedValueOnce(PHONE_USER);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: '(31) 99999-8842', password: 'senhaForte99' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().user.username).toBe('553199998842');
    expect(findForAuthMock).toHaveBeenNthCalledWith(1, '(31) 99999-8842');
    expect(findForAuthMock).toHaveBeenNthCalledWith(2, '553199998842');
    await app.close();
  });

  it('username legado em forma LOCAL (31999998842) é achado pelo canônico nos dois lados', async () => {
    arrangeHappyLogin();
    const legado = { ...PHONE_USER, id: 33, username: '31999998842' };
    findForAuthMock.mockResolvedValue(null); // nem cru nem canônico batem exato
    listUsernamesMock.mockResolvedValue([{ id: 33, username: '31999998842' }]);
    findByIdMock.mockResolvedValue(legado);
    getSlotMock.mockResolvedValue(legado.slot);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: '(31) 99999-8842', password: 'senhaForte99' },
    });

    expect(res.statusCode).toBe(200);
    expect(findByIdMock).toHaveBeenCalledWith(33);
    await app.close();
  });

  it('login NÃO-telefone segue intacto: match exato, sem fallback (Cirilo intocado)', async () => {
    arrangeHappyLogin();
    findForAuthMock.mockResolvedValue({ ...ACTIVE_USER, must_change_password: false });
    getSlotMock.mockResolvedValue('clone_x');

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'cirilo', password: 'senhaForte99' },
    });

    expect(res.statusCode).toBe(200);
    expect(findForAuthMock).toHaveBeenCalledTimes(1);
    expect(listUsernamesMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('AMBIGUIDADE (2 usernames legados => mesmo canônico) nega login — falha segura', async () => {
    arrangeHappyLogin();
    findForAuthMock.mockResolvedValue(null);
    listUsernamesMock.mockResolvedValue([
      { id: 33, username: '31999998842' },
      { id: 44, username: '5531999998842' },
    ]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: '(31) 99999-8842', password: 'senhaForte99' },
    });

    expect(res.statusCode).toBe(401);
    expect(findByIdMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('número inexistente: 401 genérico (sem oráculo)', async () => {
    findForAuthMock.mockResolvedValue(null);
    listUsernamesMock.mockResolvedValue([{ id: 7, username: 'cirilo' }]);
    compareMock.mockResolvedValue(false as never);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: '(31) 98888-0000', password: 'qualquer' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'usuario ou senha invalidos' });
    await app.close();
  });
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
