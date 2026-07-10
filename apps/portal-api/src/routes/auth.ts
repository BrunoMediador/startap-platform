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
import { canonicalE164 } from '@startap/core/phone';
import { cloneColaboradores, colaboradorAuth, flowClones, portalUsers } from '@startap/db';
import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { createSession, destroySession, invalidateOtherUserSessions } from '../lib/session.js';
import {
  SESSION_COOKIE,
  requireColaborador,
  requireTenant,
  withColaborador,
  withTenant,
} from '../lib/tenant.js';

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

export function cookieSecure(): boolean {
  if (config.PORTAL_COOKIE_SECURE !== undefined) return config.PORTAL_COOKIE_SECURE;
  return config.NODE_ENV === 'production';
}

/** Opções do cookie de sessão (compartilhadas por owner e colaborador). */
function sessionCookieOpts() {
  return {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax' as const,
    signed: true,
    path: '/',
    maxAge: config.PORTAL_SESSION_TTL_SECONDS,
  };
}

/**
 * Login de COLABORADOR (SCRUM-32). Tentado SÓ quando nenhum owner casou o username E a
 * flag COLABORADOR_PORTAL_ENABLED está ON. Retorna `true` quando RESOLVEU o login do
 * colaborador (já enviou a resposta 200/401/403/429) ou `false` quando NÃO há colaborador
 * com esse username — nesse caso o caller cai no dummy-compare + 401 genérico (sem oráculo
 * de enumeração, sem bcrypt em dobro). Devolver boolean (em vez do reply) evita depender do
 * valor de retorno de reply.send() — o caller só decide se já respondeu.
 *
 * Mesma disciplina do owner: lockout progressivo, compare bcrypt, respostas genéricas. A
 * sessão nasce com role='colaborador' + colaboradorId — o withTenant passa a barrá-la em
 * TODA rota do dono (chokepoint), e ela só alcança /colaborador/* (READ-ONLY).
 */
async function loginColaborador(
  reply: FastifyReply,
  username: string,
  password: string,
): Promise<boolean> {
  const c = await colaboradorAuth.findColaboradorForAuth(username);
  if (!c) return false; // não é colaborador — caller faz o dummy-compare + 401

  // Credencial ou colaborador desativado: nega (mesma semântica do owner inativo).
  if (!c.active || !c.colaborador_ativo) {
    await reply.code(403).send({ error: 'usuario desativado' });
    return true;
  }

  if (c.locked_until && c.locked_until.getTime() > Date.now()) {
    log.warn({ colaboradorId: c.colaborador_id }, 'login de colaborador bloqueado por lockout');
    await reply
      .code(429)
      .send({ error: 'muitas tentativas — tente novamente mais tarde', locked: true });
    return true;
  }

  const ok = await bcrypt.compare(password, c.password_hash);
  if (!ok) {
    const state = await colaboradorAuth.recordColaboradorFailedLogin(
      c.colaborador_id,
      config.PORTAL_LOGIN_MAX_ATTEMPTS,
      config.PORTAL_LOGIN_LOCK_MINUTES,
    );
    const locked = state.locked_until !== null;
    log.warn({ colaboradorId: c.colaborador_id, locked }, 'login de colaborador falhou');
    await reply
      .code(locked ? 429 : 401)
      .send(
        locked
          ? { error: 'muitas tentativas — tente novamente mais tarde', locked: true }
          : { error: 'usuario ou senha invalidos' },
      );
    return true;
  }

  await colaboradorAuth.recordColaboradorSuccessfulLogin(c.colaborador_id);
  const sid = await createSession({
    userId: 0, // colaborador não é portal_users; a identidade é colaboradorId
    username: c.username,
    slot: c.slot,
    createdAt: Date.now(),
    role: 'colaborador',
    colaboradorId: c.colaborador_id,
  });
  reply.setCookie(SESSION_COOKIE, sid, sessionCookieOpts());

  log.info({ colaboradorId: c.colaborador_id }, 'login de colaborador ok');
  await reply.code(200).send({
    ok: true,
    role: 'colaborador',
    user: { username: c.username, display_name: c.nome },
  });
  return true;
}

/**
 * Resolve o user do login aceitando o NUMERO em qualquer formatacao (PR #268 —
 * achado do frontend: cliente novo loga com o WhatsApp, mas "(31) 99999-8842"
 * falhava porque o lookup era so lower(username) exato).
 *
 * Ordem (para na primeira que acha):
 *  1. Match exato (comportamento atual — clientes legados como 'cirilo' intactos).
 *  2. Forma canonica E.164 do input (signup grava o username canonico).
 *  3. Canonico nos DOIS lados (exigencia da security): cobre conta criada manual
 *     no gestao com username em forma local (ex: '31999998842'). Se MAIS de um
 *     username resolve pro mesmo canonico (duplicata legada — o signup nao cria
 *     mais, dedup canonica), NAO loga ninguem: ambiguidade e falha segura.
 */
async function findUserAcceptingPhoneFormats(
  username: string,
): Promise<Awaited<ReturnType<typeof portalUsers.findPortalUserForAuth>>> {
  const exact = await portalUsers.findPortalUserForAuth(username);
  if (exact) return exact;

  const canonical = canonicalE164(username);
  if (!canonical) return null; // input nao parece telefone — nada a tentar

  if (canonical !== username.trim()) {
    const byCanonical = await portalUsers.findPortalUserForAuth(canonical);
    if (byCanonical) return byCanonical;
  }

  // Canonico nos dois lados (tabela minuscula na v1 — ver listPortalUsernames).
  const all = await portalUsers.listPortalUsernames();
  const matches = all.filter((u) => canonicalE164(u.username) === canonical);
  if (matches.length === 1 && matches[0]) {
    return portalUsers.findPortalUserAuthById(matches[0].id);
  }
  if (matches.length > 1) {
    log.error(
      { userIds: matches.map((u) => u.id) },
      'login ambiguo: mais de um username resolve pro mesmo numero canonico — negado (corrigir no gestao)',
    );
  }
  return null;
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'credenciais invalidas' });
    }
    const { username, password } = parsed.data;

    const user = await findUserAcceptingPhoneFormats(username);

    // O fluxo do DONO só roda quando há um owner ATIVO casando o username. Quando NÃO
    // há owner ativo (owner inexistente OU owner INATIVO homônimo), tentamos a
    // credencial de COLABORADOR antes de qualquer 401/403.
    //
    // Bug de produção (2026-06-27): um portal_users INATIVO com o mesmo username de um
    // colaborador (ex.: 'robson' no dragon) SOMBREAVA o login — o handler achava o owner
    // inativo e retornava 403 "usuario desativado" ANTES de tentar o colaborador, então o
    // compare da senha do colaborador NUNCA era alcançado (failed_attempts=0,
    // last_login_at=NULL). Movendo o gate de inatividade para DEPOIS do fallback, o
    // colaborador real loga; o owner inativo SEM colaborador correspondente mantém o 403.
    if (!user?.active) {
      // Fallback: credencial de COLABORADOR (SCRUM-32). Só quando a feature está ON —
      // com a flag OFF o login é byte-a-byte como hoje (nunca toca colaborador_auth).
      if (config.COLABORADOR_PORTAL_ENABLED) {
        const handled = await loginColaborador(reply, username, password);
        if (handled) return reply; // colaborador resolveu (200/401/403/429), resposta já enviada
      }
      // Owner INATIVO homônimo sem colaborador que resolva: mantém o 403 explícito
      // (comportamento atual preservado — mesma semântica de antes do fix).
      if (user) {
        return reply.code(403).send({ error: 'usuario desativado' });
      }
      // Username inexistente: 401 genérico (sem oraculo de enumeracao). Custo constante:
      // roda um compare dummy para nao vazar timing.
      await bcrypt.compare(
        password,
        '$2a$12$00000000000000000000000000000000000000000000000000000',
      );
      return reply.code(401).send({ error: 'usuario ou senha invalidos' });
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

    reply.setCookie(SESSION_COOKIE, sid, sessionCookieOpts());

    log.info({ userId: user.id }, 'login ok');
    return reply.code(200).send({
      ok: true,
      // role explícito (SCRUM-32) — o front roteia owner vs colaborador. Aditivo:
      // owners existentes recebem 'owner' (antes ausente; o front trata ausência como dono).
      role: 'owner',
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

    // Gating do painel de estabelecimento (Fatia 1): product_type vem do banco
    // (READ-only; o cliente NUNCA o nomeia) e é o ponto ÚNICO de gating do portal —
    // já é server-fetched pelo guard do (app)/layout, sem fetch extra no client.
    // Individual (fallback seguro de getScopeBySlot) -> product_type omitido na
    // resposta -> o portal renderiza IDÊNTICO ao de hoje (Cirilo/Samuel intocados).
    // Com a flag OFF nem consultamos o banco: feature dormente, /auth/me byte-a-byte.
    let productType: 'individual' | 'estabelecimento' = 'individual';
    let seatCap: number | null = null;
    if (config.ESTABELECIMENTO_ENABLED) {
      try {
        const scope = await cloneColaboradores.getScopeBySlot(tenant.slot);
        productType = scope.product_type;
        seatCap = scope.seat_cap;
      } catch (e) {
        // Nunca derruba /auth/me por causa do gating — degrada pra individual.
        log.warn(
          { userId: tenant.userId, err: e instanceof Error ? e.message : String(e) },
          'falha ao resolver product_type — degrada pra individual',
        );
      }
    }

    // Resolução env→coluna (ADR 0030 D1): env ATEND_FROM_AGENDA_SLOTS OR flow_clones.billing_from_agenda_enabled.
    const atendFromAgenda = await flowClones.resolveAtendFromAgendaEnabledForSlot(
      tenant.slot,
      config.ATEND_FROM_AGENDA_SLOTS,
    );

    return reply.code(200).send({
      username: tenant.username,
      slot: tenant.slot,
      // Flag do app de gestão (atendimentos/faturamento/comissão, ADR 0026). SEMPRE
      // presente (boolean), independente de product_type — o front liga/desliga o
      // menu por ele. !! garante boolean mesmo se a config vier indefinida.
      atendimentos_enabled: !!config.ATENDIMENTOS_ENABLED,
      // Flag do billing derivado da agenda (ADR 0027). SEMPRE presente (boolean) — o
      // front gateia as ABAS previsão/faturado por ela (criar-no-agendamento da Fase B2
      // também). Gate POR-CLONE: reflete se o SLOT DESTA sessão está na lista
      // ATEND_FROM_AGENDA_SLOTS (vazia = OFF pra todos). Mantém o front coerente com o
      // gate real do gancho (B2/D) — clone fora da lista NÃO vê as abas.
      atend_from_agenda: atendFromAgenda,
      // Só envia os campos quando a feature está ON E o cliente é estabelecimento.
      // Ausentes = individual (o front trata ausência como 'individual').
      ...(productType === 'estabelecimento'
        ? { product_type: productType, seat_cap: seatCap }
        : {}),
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

  // GET /auth/colaborador/me — identidade da sessão de COLABORADOR (SCRUM-32). withColaborador
  // EXIGE role='colaborador' (sessão de dono -> 403) e re-deriva do banco. Identidade SEMPRE
  // da sessão — nunca de input. Espelha /auth/me, mas pro painel READ-ONLY do colaborador.
  app.get('/auth/colaborador/me', { preHandler: withColaborador }, async (req, reply) => {
    if (!config.COLABORADOR_PORTAL_ENABLED) {
      return reply.code(404).send({ error: 'recurso indisponivel' });
    }
    const c = requireColaborador(req);
    // Fuso (IANA) do clone DO PRÓPRIO colaborador (migration 068) — escopado SEMPRE ao slot
    // da SESSÃO (c.slot), nunca de input/outro tenant. Default 'America/Sao_Paulo'. O painel
    // do colaborador (estab Cuiabá) usa pra renderizar agenda/comissão no relógio da barbearia.
    const scope = await cloneColaboradores.getScopeBySlot(c.slot);
    return reply.code(200).send({
      role: 'colaborador',
      username: c.username,
      display_name: c.nome,
      colaborador_id: c.colaboradorId,
      slot: c.slot,
      timezone: scope.timezone,
    });
  });
};
