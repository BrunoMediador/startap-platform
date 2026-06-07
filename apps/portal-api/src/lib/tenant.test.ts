import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock da sessao Redis e da query de slot ANTES de importar o modulo sob teste.
vi.mock('./session.js', () => ({
  getSession: vi.fn(),
}));
vi.mock('@startap/db', () => ({
  portalUsers: {
    getSlotForActivePortalUser: vi.fn(),
  },
}));

import { portalUsers } from '@startap/db';
import { getSession } from './session.js';
import { withTenant } from './tenant.js';

const getSessionMock = vi.mocked(getSession);
const getSlotMock = vi.mocked(portalUsers.getSlotForActivePortalUser);

// ── Fakes de request/reply ────────────────────────────────────────────────────
type ReplyResult = { code: number; body: unknown };

function makeReply() {
  const result: ReplyResult = { code: 200, body: undefined };
  const reply = {
    code(c: number) {
      result.code = c;
      return reply;
    },
    send(b: unknown) {
      result.body = b;
      return reply;
    },
  };
  return { reply, result };
}

function makeReq(opts: {
  cookie?: string;
  unsigned?: { valid: boolean; value: string | null };
}) {
  return {
    cookies: opts.cookie ? { 'portal.sid': opts.cookie } : {},
    unsignCookie: (_raw: string) => opts.unsigned ?? { valid: true, value: 'sid-from-cookie' },
    tenant: undefined,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('withTenant', () => {
  it('401 quando nao ha cookie de sessao', async () => {
    const req = makeReq({});
    const { reply, result } = makeReply();
    // biome-ignore lint/suspicious/noExplicitAny: fakes de teste
    await withTenant(req, reply as any);
    expect(result.code).toBe(401);
    // @ts-expect-error tenant nao tipado no fake
    expect(req.tenant).toBeUndefined();
  });

  it('401 quando cookie assinado e invalido', async () => {
    const req = makeReq({ cookie: 'adulterado', unsigned: { valid: false, value: null } });
    const { reply, result } = makeReply();
    // biome-ignore lint/suspicious/noExplicitAny: fakes de teste
    await withTenant(req, reply as any);
    expect(result.code).toBe(401);
  });

  it('401 quando a sessao nao existe no Redis', async () => {
    getSessionMock.mockResolvedValue(null);
    const req = makeReq({ cookie: 'cookie-valido' });
    const { reply, result } = makeReply();
    // biome-ignore lint/suspicious/noExplicitAny: fakes de teste
    await withTenant(req, reply as any);
    expect(result.code).toBe(401);
  });

  it('403 quando o user nao tem slot ativo (desativado/desvinculado)', async () => {
    getSessionMock.mockResolvedValue({
      userId: 7,
      username: 'cirilo',
      slot: 'clone_x',
      createdAt: Date.now(),
    });
    getSlotMock.mockResolvedValue(null);
    const req = makeReq({ cookie: 'cookie-valido' });
    const { reply, result } = makeReply();
    // biome-ignore lint/suspicious/noExplicitAny: fakes de teste
    await withTenant(req, reply as any);
    expect(result.code).toBe(403);
  });

  it('injeta o tenant com o slot RE-DERIVADO do DB (nao do payload da sessao)', async () => {
    // Sessao diz 'clone_velho', mas o DB e a fonte da verdade -> 'clone_atual'.
    getSessionMock.mockResolvedValue({
      userId: 42,
      username: 'cirilo',
      slot: 'clone_velho',
      createdAt: Date.now(),
    });
    getSlotMock.mockResolvedValue('clone_atual');
    const req = makeReq({ cookie: 'cookie-valido' });
    const { reply, result } = makeReply();
    // biome-ignore lint/suspicious/noExplicitAny: fakes de teste
    await withTenant(req, reply as any);
    // nao houve resposta de erro
    expect(result.code).toBe(200);
    // @ts-expect-error tenant nao tipado no fake
    expect(req.tenant).toEqual({ slot: 'clone_atual', userId: 42, username: 'cirilo' });
    expect(getSlotMock).toHaveBeenCalledWith(42);
  });
});
