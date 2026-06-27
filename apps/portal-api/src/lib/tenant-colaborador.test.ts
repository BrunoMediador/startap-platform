/**
 * Isolamento do PAINEL DO COLABORADOR no nível dos preHandlers (SCRUM-32).
 *
 * Prova as guardas anti-IDOR DE PORTA:
 *  - withTenant (chokepoint de TODA rota do dono) REJEITA sessão de colaborador (403) —
 *    um colaborador jamais alcança billing/equipe/perfil/atendimentos/agenda do dono.
 *  - withColaborador REJEITA sessão de dono (403) e sessão de colaborador INATIVO (403),
 *    e injeta o contexto RE-DERIVADO DO BANCO (não do payload da sessão).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./session.js', () => ({ getSession: vi.fn() }));
vi.mock('@startap/db', () => ({
  portalUsers: { getSlotForActivePortalUser: vi.fn() },
  colaboradorAuth: { findColaboradorAuthById: vi.fn() },
}));

import { colaboradorAuth, portalUsers } from '@startap/db';
import { getSession } from './session.js';
import { withColaborador, withTenant } from './tenant.js';

const getSessionMock = vi.mocked(getSession);
const getSlotMock = vi.mocked(portalUsers.getSlotForActivePortalUser);
const findColabByIdMock = vi.mocked(colaboradorAuth.findColaboradorAuthById);

function makeReply() {
  const result = { code: 200, body: undefined as unknown };
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

function makeReq() {
  return {
    cookies: { 'portal.sid': 'cookie-valido' },
    unsignCookie: () => ({ valid: true, value: 'sid-1' }),
    tenant: undefined,
    colaborador: undefined,
  } as never;
}

beforeEach(() => vi.clearAllMocks());

describe('withTenant — chokepoint contra sessão de colaborador', () => {
  it('403 quando a sessão é role=colaborador (não acessa rota do dono)', async () => {
    getSessionMock.mockResolvedValue({
      userId: 0,
      username: 'bene',
      slot: 'clone_seven',
      createdAt: Date.now(),
      role: 'colaborador',
      colaboradorId: 7,
    });
    const req = makeReq();
    const { reply, result } = makeReply();
    // biome-ignore lint/suspicious/noExplicitAny: fakes de teste
    await withTenant(req, reply as any);
    expect(result.code).toBe(403);
    // NÃO re-derivou slot de dono (nem chegou perto da query de owner).
    expect(getSlotMock).not.toHaveBeenCalled();
    // @ts-expect-error fake
    expect(req.tenant).toBeUndefined();
  });

  it('owner segue normal (injeta tenant)', async () => {
    getSessionMock.mockResolvedValue({
      userId: 42,
      username: 'cirilo',
      slot: 'clone_velho',
      createdAt: Date.now(),
    });
    getSlotMock.mockResolvedValue('clone_atual');
    const req = makeReq();
    const { reply, result } = makeReply();
    // biome-ignore lint/suspicious/noExplicitAny: fakes de teste
    await withTenant(req, reply as any);
    expect(result.code).toBe(200);
    // @ts-expect-error fake
    expect(req.tenant).toEqual({
      slot: 'clone_atual',
      userId: 42,
      username: 'cirilo',
      sid: 'sid-1',
    });
  });
});

describe('withColaborador — só colaborador ativo, contexto re-derivado do banco', () => {
  it('403 quando a sessão é de DONO (owner não acessa painel do colaborador)', async () => {
    getSessionMock.mockResolvedValue({
      userId: 42,
      username: 'cirilo',
      slot: 'clone_x',
      createdAt: Date.now(),
    });
    const req = makeReq();
    const { reply, result } = makeReply();
    // biome-ignore lint/suspicious/noExplicitAny: fakes de teste
    await withColaborador(req, reply as any);
    expect(result.code).toBe(403);
    expect(findColabByIdMock).not.toHaveBeenCalled();
  });

  it('403 quando o colaborador foi DESATIVADO (recheca o banco)', async () => {
    getSessionMock.mockResolvedValue({
      userId: 0,
      username: 'bene',
      slot: 'clone_seven',
      createdAt: Date.now(),
      role: 'colaborador',
      colaboradorId: 7,
    });
    findColabByIdMock.mockResolvedValue({
      colaborador_id: 7,
      slot: 'clone_seven',
      tenant_id: 'tid-7',
      username: 'bene',
      nome: 'Bene',
      password_hash: '$2a$12$h',
      active: true,
      colaborador_ativo: false, // desativado no painel
      failed_attempts: 0,
      locked_until: null,
    });
    const req = makeReq();
    const { reply, result } = makeReply();
    // biome-ignore lint/suspicious/noExplicitAny: fakes de teste
    await withColaborador(req, reply as any);
    expect(result.code).toBe(403);
    // @ts-expect-error fake
    expect(req.colaborador).toBeUndefined();
  });

  it('injeta o contexto do colaborador RE-DERIVADO do banco (slot/tenant/id da sessão)', async () => {
    getSessionMock.mockResolvedValue({
      userId: 0,
      username: 'bene',
      slot: 'clone_payload_velho', // payload da sessão NÃO é a fonte da verdade
      createdAt: Date.now(),
      role: 'colaborador',
      colaboradorId: 7,
    });
    findColabByIdMock.mockResolvedValue({
      colaborador_id: 7,
      slot: 'clone_seven', // banco manda
      tenant_id: 'tid-7',
      username: 'bene-silva',
      nome: 'Bene Silva',
      password_hash: '$2a$12$h',
      active: true,
      colaborador_ativo: true,
      failed_attempts: 0,
      locked_until: null,
    });
    const req = makeReq();
    const { reply, result } = makeReply();
    // biome-ignore lint/suspicious/noExplicitAny: fakes de teste
    await withColaborador(req, reply as any);
    expect(result.code).toBe(200);
    expect(findColabByIdMock).toHaveBeenCalledWith(7);
    // @ts-expect-error fake
    expect(req.colaborador).toEqual({
      slot: 'clone_seven',
      tenantId: 'tid-7',
      colaboradorId: 7,
      username: 'bene-silva',
      nome: 'Bene Silva',
      sid: 'sid-1',
    });
  });
});
