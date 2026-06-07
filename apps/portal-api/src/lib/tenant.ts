/**
 * withTenant — preHandler obrigatorio em TODA rota autenticada (ADR 0012, Decisao 4).
 *
 * 1. valida a sessao (cookie assinado -> Redis),
 * 2. confirma o slot do user (defensivo: re-deriva de portal_user_clones),
 * 3. injeta request.tenant = { slot, userId, username },
 * 4. NENHUMA query do portal aceita slot vindo de body/query/params. O slot vem
 *    SEMPRE de request.tenant.slot. O cliente nao consegue nem nomear outro slot.
 *
 * Esta e a barreira minima inegociavel multi-tenant desta camada (regra de ouro 5).
 */
import { logger } from '@startap/core/logger';
import { portalUsers } from '@startap/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getSession } from './session.js';

const log = logger.child({ service: 'portal-api', module: 'tenant' });

export const SESSION_COOKIE = 'portal.sid';

export interface TenantContext {
  slot: string;
  userId: number;
  username: string;
  /** session id da requisicao atual (para preservar a sessao corrente em revogacoes). */
  sid: string;
}

// Decora FastifyRequest com `tenant` (preenchido pelo withTenant).
declare module 'fastify' {
  interface FastifyRequest {
    tenant?: TenantContext;
  }
}

/** Le e valida o cookie de sessao assinado. Retorna o session id ou null. */
function readSignedSessionId(req: FastifyRequest): string | null {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  return unsigned.value;
}

/**
 * preHandler: exige sessao valida e injeta o tenant. 401 se nao autenticado.
 * Re-deriva o slot de portal_user_clones (nao confia cegamente no payload da
 * sessao) — se o user foi desativado/desvinculado, cai aqui.
 */
export async function withTenant(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sid = readSignedSessionId(req);
  if (!sid) {
    await reply.code(401).send({ error: 'nao autenticado' });
    return;
  }

  const session = await getSession(sid);
  if (!session) {
    await reply.code(401).send({ error: 'sessao expirada ou invalida' });
    return;
  }

  // Defensivo: re-resolve o slot ativo do user. Revogacao imediata se o user
  // foi desativado (getSlotForActivePortalUser filtra active = TRUE).
  const slot = await portalUsers.getSlotForActivePortalUser(session.userId);
  if (!slot) {
    log.warn({ userId: session.userId }, 'sessao sem slot ativo — acesso negado');
    await reply.code(403).send({ error: 'usuario sem fluxo ativo' });
    return;
  }

  req.tenant = { slot, userId: session.userId, username: session.username, sid };
}

/** Helper para rotas: garante que o tenant foi injetado (lanca caso contrario). */
export function requireTenant(req: FastifyRequest): TenantContext {
  if (!req.tenant) {
    throw new Error('withTenant nao executado nesta rota — bug de configuracao');
  }
  return req.tenant;
}
