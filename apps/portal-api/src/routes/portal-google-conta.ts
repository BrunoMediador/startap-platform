/**
 * Entrega da credencial Google do CLIENTE no portal self-service (migration 061).
 *
 * O QUE ENTREGA: o login (e-mail + senha) da conta Google que a EMPRESA criou pro cliente
 * usar no app Google Agenda no celular/computador dele. É credencial de LOGIN HUMANO —
 * NÃO é a Service Account do bot (colunas gcal_*, ADR 0024, escopo distinto).
 *
 * CONTRATO CONGELADO (o frontend constrói contra isto):
 *   GET /portal/google-conta
 *     -> 200 { google_account_email: string|null, google_account_password: string|null }
 *        com header 'cache-control: no-store'. A senha JÁ vem DECIFRADA (server-side).
 *        Se a credencial não foi configurada, ambos os campos vêm null.
 *
 * GATING: flag GOOGLE_ACCOUNT_PORTAL_ENABLED (default OFF). OFF -> 404 ANTES de qualquer
 * consulta ao banco (feature dormente; não vaza; o front esconde a seção).
 *
 * ISOLAMENTO (regra de ouro 5, ADR 0012 Decisão 4 — anti-IDOR): o slot vem SEMPRE de
 * request.tenant.slot (withTenant). NUNCA de body/query/params — o cliente não consegue nem
 * nomear outro slot.
 *
 * SEGURANÇA: a senha do Google NUNCA entra em log (nem em erro). O log de sucesso carrega
 * SÓ { slot }. A senha é decifrada com decryptSecret de @startap/core (mesmo formato
 * enc:v2 do gcal) apenas se a coluna não for NULL. cache-control: no-store impede que o
 * navegador/proxy guarde a credencial.
 */
import { decryptSecret } from '@startap/core';
import { logger } from '@startap/core/logger';
import { flowClones } from '@startap/db';
import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { requireTenant, withTenant } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'google-conta' });

export const portalGoogleContaRoutes: FastifyPluginAsync = async (app) => {
  app.get('/portal/google-conta', { preHandler: withTenant }, async (req, reply) => {
    // Gate ANTES de tudo: flag OFF -> 404 e NEM consulta o banco (feature dormente).
    if (!config.GOOGLE_ACCOUNT_PORTAL_ENABLED) {
      return reply.code(404).send({ error: 'recurso indisponivel' });
    }

    // slot SEMPRE da sessão (anti-IDOR) — nunca de input.
    const { slot } = requireTenant(req);

    const row = await flowClones.getGoogleAccountBySlot(slot);
    if (!row) {
      // Slot da sessão sem clone — dado inconsistente. Não vaza detalhe.
      return reply.code(404).send({ error: 'fluxo nao encontrado' });
    }

    // Decifra a senha SÓ se a coluna não for NULL (credencial pode não ter sido criada
    // ainda). A senha decifrada vive apenas nesta resposta — NUNCA é logada.
    const password =
      row.google_account_password_enc !== null
        ? decryptSecret(row.google_account_password_enc)
        : null;

    // Log de sucesso carrega SÓ o slot. Sem e-mail, sem senha, sem cifra.
    log.info({ slot }, 'credencial google entregue ao dono (portal)');

    reply.header('cache-control', 'no-store');
    return reply.code(200).send({
      google_account_email: row.google_account_email,
      google_account_password: password,
    });
  });
};
