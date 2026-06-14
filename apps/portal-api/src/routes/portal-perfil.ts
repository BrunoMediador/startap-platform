/**
 * Perfil do negocio editavel pelo cliente no portal (Missao 023 W13).
 *
 * O cliente edita nome_negocio, nome_prestador, telefone_contato, endereco,
 * instagram e formas_pagamento sem depender do gestao. Tudo vai no JSONB
 * flow_clones.personalizacao — MESMA fonte que o gestao grava (sem migration).
 *
 * Escopado por request.tenant.slot (withTenant). O slot NUNCA vem do input.
 * Validacao via perfilSchema compartilhado (@startap/core/schemas). Apos a
 * escrita, o data layer reusa updateClone -> re-renderiza o bot_prompt e
 * invalida o cache de clone (webhook pega a versao nova em ~0s).
 */
import { perfilSchema } from '@startap/core/schemas';
import { portalConfig } from '@startap/db';
import type { FastifyPluginAsync } from 'fastify';
import { requireTenant, withTenant } from '../lib/tenant.js';

export const portalPerfilRoutes: FastifyPluginAsync = async (app) => {
  app.get('/portal/perfil', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
    const perfil = await portalConfig.getPerfilBySlot(slot);
    if (perfil === null) return reply.code(404).send({ error: 'fluxo nao encontrado' });
    return reply.code(200).send({ perfil });
  });

  app.put('/portal/perfil', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
    const body = (req.body ?? {}) as { perfil?: unknown };
    const parsed = perfilSchema.safeParse(body.perfil);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'perfil invalido',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const ok = await portalConfig.updatePerfilBySlot(slot, parsed.data);
    if (!ok) return reply.code(404).send({ error: 'fluxo nao encontrado' });
    // Devolve o perfil canonico (ja MERGE-ado/normalizado) para o front sincronizar.
    const perfil = await portalConfig.getPerfilBySlot(slot);
    return reply.code(200).send({ ok: true, perfil });
  });
};
