/**
 * Rotas de pausas do portal. Escopadas por request.tenant.slot (flow_id = slot).
 * O dono e o usuario do portal: pode gerenciar QUALQUER pausa do PROPRIO fluxo
 * (inclusive source='fromMe'/'antibot'), mas NUNCA de outro fluxo.
 *
 * Telefone validado 10-15 digitos (igual ao painel). O front so manda valor vindo
 * do dropdown de recent-contacts, mas validamos igual — defesa em profundidade.
 * Logs mascaram o telefone (LGPD).
 */
import { logger } from '@startap/core/logger';
import { portalConfig } from '@startap/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { maskPhone } from '../lib/mask.js';
import { requireTenant, withTenant } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'pausas' });

const phoneSchema = z
  .string()
  .transform((v) => v.replace(/\D/g, ''))
  .refine((v) => v.length >= 10 && v.length <= 15, {
    message: 'telefone deve ter 10-15 digitos (DDI+DDD+numero)',
  });

export const portalPausasRoutes: FastifyPluginAsync = async (app) => {
  app.get('/portal/pausas', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
    const pausas = await portalConfig.listPausasBySlot(slot);
    return reply.code(200).send({ count: pausas.length, pausas });
  });

  app.post('/portal/pausas', { preHandler: withTenant }, async (req, reply) => {
    const { slot, userId } = requireTenant(req);
    const body = (req.body ?? {}) as { telefone?: unknown };
    const parsed = phoneSchema.safeParse(String(body.telefone ?? ''));
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message ?? 'telefone invalido' });
    }
    const telefone = parsed.data;
    const pausa = await portalConfig.addPausaBySlot({ slot, telefone });
    log.info({ slot, userId, phone: maskPhone(telefone) }, 'pausa criada via portal');
    return reply.code(201).send({ ok: true, pausa });
  });

  app.delete('/portal/pausas/:telefone', { preHandler: withTenant }, async (req, reply) => {
    const { slot, userId } = requireTenant(req);
    const params = req.params as { telefone?: string };
    const parsed = phoneSchema.safeParse(String(params.telefone ?? ''));
    if (!parsed.success) {
      return reply.code(400).send({ error: 'telefone invalido' });
    }
    const telefone = parsed.data;
    const removed = await portalConfig.removePausaBySlot({ slot, telefone });
    if (!removed) {
      return reply.code(404).send({ error: 'pausa ativa nao encontrada' });
    }
    log.info({ slot, userId, phone: maskPhone(telefone) }, 'pausa removida via portal');
    return reply.code(200).send({ ok: true });
  });
};
