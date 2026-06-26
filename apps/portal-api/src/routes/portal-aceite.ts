/**
 * Aceite dos Termos + Política de Privacidade — GATE PÓS-LOGIN (SCRUM-1, fluxo 2).
 *
 * Cobre os clientes ATUAIS (Cirilo, Samuel, Seven 7, …) que se cadastraram ANTES do
 * checkbox existir. Ao logar, o portal-web consulta GET /portal/aceite/status; se o
 * tenant ainda não aceitou a versão VIGENTE, o front bloqueia o app e mostra a tela de
 * aceite, que chama POST /portal/aceite. A prova (terms_acceptances) é a MESMA do
 * signup — versionada; se a versão dos termos mudar no futuro, o gate reaparece.
 *
 * ISOLAMENTO (regra de ouro 5): slot e userId vêm SEMPRE de request.tenant (withTenant),
 * nunca de input. Anti-IDOR por construção — o cliente não nomeia outro slot.
 *
 * LGPD: ip/user_agent ficam só na prova (terms_acceptances), nunca em log claro.
 */
import { logger } from '@startap/core/logger';
import { tenant, termsAcceptance } from '@startap/db';
import type { FastifyPluginAsync } from 'fastify';
import {
  PRIVACY_VERSION,
  TERMS_VERSION,
  USER_AGENT_MAX,
  needsAcceptance,
} from '../lib/legal-version.js';
import { requireTenant, withTenant } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'aceite' });

export const portalAceiteRoutes: FastifyPluginAsync = async (app) => {
  // Status do aceite do tenant logado: precisa (re)aceitar a versão vigente?
  app.get('/portal/aceite/status', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
    const last = await termsAcceptance.getLatestAcceptanceForSlot(slot);
    return reply.code(200).send({
      needs_acceptance: needsAcceptance(last),
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
      accepted_terms_version: last?.terms_version ?? null,
      accepted_privacy_version: last?.privacy_version ?? null,
    });
  });

  // Registra o aceite do tenant logado (gate pós-login). Append-only; versão e
  // identidade vêm do servidor — o corpo da request é IGNORADO (sem campo do cliente).
  app.post('/portal/aceite', { preHandler: withTenant }, async (req, reply) => {
    const { slot, userId } = requireTenant(req);
    const tenantId = await tenant.resolveTenantId(slot);
    const uaRaw = req.headers['user-agent'];
    await termsAcceptance.recordTermsAcceptance({
      slot,
      tenantId,
      portalUserId: userId,
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION,
      ip: req.ip || null,
      userAgent: typeof uaRaw === 'string' ? uaRaw.slice(0, USER_AGENT_MAX) : null,
    });
    log.info({ slot }, 'aceite pós-login registrado');
    return reply.code(201).send({
      ok: true,
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
    });
  });
};
