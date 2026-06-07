/**
 * Rotas de configuracao do fluxo editavel pelo cliente: servicos e horarios.
 * TODAS escopadas por request.tenant.slot (withTenant). O slot NUNCA vem do input.
 *
 * Validacao via schemas Zod compartilhados (@startap/core/schemas) — fonte unica
 * de verdade (ADR 0012, Decisao 6). Apos escrita, invalidateCloneCache (em
 * packages/db) garante que o webhook pegue a versao nova em ~0s.
 */
import { horariosSchema, servicosSchema } from '@startap/core/schemas';
import { portalConfig } from '@startap/db';
import type { FastifyPluginAsync } from 'fastify';
import { requireTenant, withTenant } from '../lib/tenant.js';

export const portalConfigRoutes: FastifyPluginAsync = async (app) => {
  // ── Servicos ────────────────────────────────────────────────────────────
  app.get('/portal/servicos', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
    const servicos = await portalConfig.getServicosBySlot(slot);
    if (servicos === null) return reply.code(404).send({ error: 'fluxo nao encontrado' });
    return reply.code(200).send({ servicos });
  });

  app.put('/portal/servicos', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
    const body = (req.body ?? {}) as { servicos?: unknown };
    const parsed = servicosSchema.safeParse(body.servicos);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'servicos invalidos',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const ok = await portalConfig.updateServicosBySlot(slot, parsed.data);
    if (!ok) return reply.code(404).send({ error: 'fluxo nao encontrado' });
    return reply.code(200).send({ ok: true, servicos: parsed.data });
  });

  // ── Horarios de funcionamento ─────────────────────────────────────────────
  app.get('/portal/horarios', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
    const horarios = await portalConfig.getHorariosBySlot(slot);
    if (horarios === null) return reply.code(404).send({ error: 'fluxo nao encontrado' });
    return reply.code(200).send({ horarios });
  });

  app.put('/portal/horarios', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
    const body = (req.body ?? {}) as { horarios?: unknown };
    const parsed = horariosSchema.safeParse(body.horarios);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'horarios invalidos',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const ok = await portalConfig.updateHorariosBySlot(slot, parsed.data);
    if (!ok) return reply.code(404).send({ error: 'fluxo nao encontrado' });
    return reply.code(200).send({ ok: true, horarios: parsed.data });
  });
};
