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
import { colaboradorAuth, portalUsers } from '@startap/db';
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

/**
 * Contexto do COLABORADOR (SCRUM-32). Injetado por withColaborador nas rotas READ-ONLY
 * do painel do colaborador. A identidade (slot/colaboradorId/tenantId) vem SEMPRE da
 * SESSÃO — nunca de body/query/params (anti-IDOR, regra de ouro 5).
 */
export interface ColaboradorContext {
  slot: string;
  tenantId: string;
  colaboradorId: number;
  username: string;
  /** Nome do colaborador (display). */
  nome: string;
  sid: string;
}

// Decora FastifyRequest com `tenant` (owner, withTenant) e `colaborador` (withColaborador).
declare module 'fastify' {
  interface FastifyRequest {
    tenant?: TenantContext;
    colaborador?: ColaboradorContext;
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

  // CHOKEPOINT anti-IDOR (SCRUM-32): TODA rota do DONO passa por withTenant. Uma sessão
  // de COLABORADOR é READ-ONLY e escopada só aos dados dele — JAMAIS pode alcançar rotas
  // do dono (billing/PIX, equipe, perfil, atendimentos write, agenda write, etc.). Negar
  // aqui, num ponto único, bloqueia o colaborador em TODAS as rotas owner de uma vez
  // (defesa em profundidade — não depende de lembrar de guardar rota a rota).
  if (session.role === 'colaborador') {
    log.warn(
      { colaboradorId: session.colaboradorId },
      'sessao de colaborador tentou rota do dono — negado (403)',
    );
    await reply.code(403).send({ error: 'acesso restrito ao dono' });
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

/**
 * withColaborador — preHandler das rotas READ-ONLY do PAINEL DO COLABORADOR (SCRUM-32).
 *
 * 1. valida a sessão (cookie assinado -> Redis);
 * 2. EXIGE role='colaborador' (uma sessão de DONO cai no 403 — não é o painel dele);
 * 3. re-deriva colaborador_id -> credencial ATIVA + colaborador ATIVO no banco (NÃO
 *    confia no payload da sessão): desativar o colaborador no painel derruba o acesso;
 * 4. injeta request.colaborador = { slot, tenantId, colaboradorId, username, nome }.
 *    TODA query escopada por esses valores DA SESSÃO — nunca de input (anti-IDOR).
 */
export async function withColaborador(req: FastifyRequest, reply: FastifyReply): Promise<void> {
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

  // Só sessão de colaborador entra aqui. Sessão de dono -> 403 (não é o painel dele).
  if (session.role !== 'colaborador' || session.colaboradorId == null) {
    await reply.code(403).send({ error: 'acesso restrito ao colaborador' });
    return;
  }

  // Re-deriva do banco (fonte da verdade): credencial ativa + colaborador ativo.
  // Revogação imediata se o dono desativou o colaborador ou a credencial.
  const auth = await colaboradorAuth.findColaboradorAuthById(session.colaboradorId);
  if (!auth || !auth.active || !auth.colaborador_ativo) {
    log.warn(
      { colaboradorId: session.colaboradorId },
      'sessao de colaborador sem credencial/colaborador ativo — acesso negado',
    );
    await reply.code(403).send({ error: 'colaborador indisponivel' });
    return;
  }

  req.colaborador = {
    slot: auth.slot,
    tenantId: auth.tenant_id,
    colaboradorId: auth.colaborador_id,
    username: auth.username,
    nome: auth.nome,
    sid,
  };
}

/** Helper para rotas: garante que o tenant foi injetado (lanca caso contrario). */
export function requireTenant(req: FastifyRequest): TenantContext {
  if (!req.tenant) {
    throw new Error('withTenant nao executado nesta rota — bug de configuracao');
  }
  return req.tenant;
}

/** Helper para rotas do colaborador: garante que o contexto foi injetado. */
export function requireColaborador(req: FastifyRequest): ColaboradorContext {
  if (!req.colaborador) {
    throw new Error('withColaborador nao executado nesta rota — bug de configuracao');
  }
  return req.colaborador;
}
