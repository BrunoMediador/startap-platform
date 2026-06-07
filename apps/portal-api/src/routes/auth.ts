/**
 * Rotas de autenticacao do portal (ADR 0012, Decisao 2).
 *
 * POST /auth/login            — username+senha, bcrypt compare, lockout progressivo.
 * POST /auth/logout           — destroi a sessao no Redis e limpa o cookie.
 * GET  /auth/me               — dados do user logado (exige withTenant).
 * POST /auth/change-password  — troca de senha self-service (exige withTenant).
 *
 * Lockout: PORTAL_LOGIN_MAX_ATTEMPTS erradas => trava PORTAL_LOGIN_LOCK_MINUTES.
 * Respostas de erro sao genericas (nao revelam se o username existe).
 */
import { logger } from '@startap/core/logger';
import { portalUsers } from '@startap/db';
import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { createSession, destroySession, invalidateOtherUserSessions } from '../lib/session.js';
import { SESSION_COOKIE, requireTenant, withTenant } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'auth' });

const loginSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(200),
});

// new_password: min 8, max 72 (limite real do bcrypt — bytes alem de 72 sao
// silenciosamente ignorados; cortamos no schema para nao dar falsa seguranca).
export const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(200),
  new_password: z.string().min(8).max(72),
});

function cookieSecure(): boolean {
  if (config.PORTAL_COOKIE_SECURE !== undefined) return config.PORTAL_COOKIE_SECURE;
  return config.NODE_ENV === 'production';
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'credenciais invalidas' });
    }
    const { username, password } = parsed.data;

    const user = await portalUsers.findPortalUserForAuth(username);
    // Resposta generica para username inexistente (sem oraculo de enumeracao).
    if (!user) {
      // Custo constante: roda um compare dummy para nao vazar timing.
      await bcrypt.compare(
        password,
        '$2a$12$00000000000000000000000000000000000000000000000000000',
      );
      return reply.code(401).send({ error: 'usuario ou senha invalidos' });
    }

    if (!user.active) {
      return reply.code(403).send({ error: 'usuario desativado' });
    }

    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      log.warn({ userId: user.id }, 'login bloqueado por lockout');
      return reply
        .code(429)
        .send({ error: 'muitas tentativas — tente novamente mais tarde', locked: true });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      const state = await portalUsers.recordFailedLogin(
        user.id,
        config.PORTAL_LOGIN_MAX_ATTEMPTS,
        config.PORTAL_LOGIN_LOCK_MINUTES,
      );
      const locked = state.locked_until !== null;
      log.warn({ userId: user.id, locked }, 'login falhou');
      return reply
        .code(locked ? 429 : 401)
        .send(
          locked
            ? { error: 'muitas tentativas — tente novamente mais tarde', locked: true }
            : { error: 'usuario ou senha invalidos' },
        );
    }

    // Sucesso: zera lockout, grava last_login_at, cria sessao no Redis.
    const slot = await portalUsers.getSlotForActivePortalUser(user.id);
    if (!slot) {
      return reply.code(403).send({ error: 'usuario sem fluxo ativo' });
    }
    await portalUsers.recordSuccessfulLogin(user.id);
    const sid = await createSession({
      userId: user.id,
      username: user.username,
      slot,
      createdAt: Date.now(),
    });

    reply.setCookie(SESSION_COOKIE, sid, {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: 'lax',
      signed: true,
      path: '/',
      maxAge: config.PORTAL_SESSION_TTL_SECONDS,
    });

    log.info({ userId: user.id }, 'login ok');
    return reply.code(200).send({
      ok: true,
      user: {
        username: user.username,
        display_name: user.display_name,
        must_change_password: user.must_change_password,
      },
    });
  });

  app.post('/auth/logout', async (req, reply) => {
    const raw = req.cookies?.[SESSION_COOKIE];
    if (raw) {
      const unsigned = req.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) {
        await destroySession(unsigned.value);
      }
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(200).send({ ok: true });
  });

  app.get('/auth/me', { preHandler: withTenant }, async (req, reply) => {
    const tenant = requireTenant(req);
    return reply.code(200).send({
      username: tenant.username,
      slot: tenant.slot,
    });
  });

  // Troca de senha self-service. Autenticada (withTenant). Confere a senha atual
  // antes de trocar, limpa must_change_password e derruba as DEMAIS sessoes do
  // user (mantem a atual). Rate limit herdado do escopo /auth/* (10/min por IP).
  app.post('/auth/change-password', { preHandler: withTenant }, async (req, reply) => {
    const tenant = requireTenant(req);

    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'nova senha deve ter entre 8 e 72 caracteres' });
    }
    const { current_password, new_password } = parsed.data;

    let user: Awaited<ReturnType<typeof portalUsers.findPortalUserAuthById>>;
    try {
      user = await portalUsers.findPortalUserAuthById(tenant.userId);
    } catch (e) {
      const err = e as { code?: string; constraint?: string };
      log.error(
        { userId: tenant.userId, pgCode: err.code, pgConstraint: err.constraint },
        'falha ao carregar user para troca de senha',
      );
      return reply.code(500).send({ error: 'erro ao trocar senha' });
    }

    // withTenant ja garantiu sessao + slot ativo; este null seria corrida rara.
    if (!user || !user.active) {
      return reply.code(403).send({ error: 'usuario indisponivel' });
    }

    const ok = await bcrypt.compare(current_password, user.password_hash);
    if (!ok) {
      log.warn({ userId: tenant.userId }, 'troca de senha negada — senha atual incorreta');
      return reply.code(401).send({ error: 'senha atual incorreta' });
    }

    if (current_password === new_password) {
      return reply.code(400).send({ error: 'a nova senha deve ser diferente da atual' });
    }

    try {
      const hash = await bcrypt.hash(new_password, config.PORTAL_BCRYPT_COST);
      await portalUsers.changePortalUserPassword(tenant.userId, hash);
    } catch (e) {
      const err = e as { code?: string; constraint?: string };
      log.error(
        { userId: tenant.userId, pgCode: err.code, pgConstraint: err.constraint },
        'falha ao gravar nova senha',
      );
      return reply.code(500).send({ error: 'erro ao trocar senha' });
    }

    // Derruba outras sessoes (outros dispositivos); mantem a atual ativa.
    const revoked = await invalidateOtherUserSessions(tenant.userId, tenant.sid).catch(() => -1);
    log.info({ userId: tenant.userId, otherSessionsRevoked: revoked }, 'senha trocada');

    return reply.code(200).send({ ok: true });
  });
};
