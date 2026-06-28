/**
 * Rotas de SUSPEITA DE BOT do portal (SCRUM-4 PR-E). Lista os números que a auto-pausa do bot-detect
 * pausou (flow_pauses source='bot_detected') e deixa o DONO despausar num clique — a rede de proteção
 * da auto-pausa. Escopadas por request.tenant.slot (flow_id = slot): o cliente NUNCA vê nem despausa
 * pausa de outro fluxo (anti-IDOR; o slot vem SEMPRE da sessão, jamais de input — chokepoint withTenant).
 *
 * SEM flag própria: enquanto a auto-pausa (worker BOT_DETECT_AUTOPAUSE) estiver OFF não existe linha
 * source='bot_detected' -> a lista vem VAZIA -> a seção some no portal. Byte-a-byte OFF pro pagante.
 *
 * O DONO vê o número COMPLETO (são contatos DELE — precisa reconhecer quem foi pausado). Mascarar é
 * regra dos NOSSOS logs (maskPhone), não da tela do dono. Telefone validado 10-15 dígitos (defesa em
 * profundidade). Despausar reusa removePausaBySlot (= removeFlowPause escopado por slot).
 */
import { logger } from '@startap/core/logger';
import { portalConfig } from '@startap/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { maskPhone } from '../lib/mask.js';
import { requireTenant, withTenant } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'bot-detect' });

const phoneSchema = z
  .string()
  .transform((v) => v.replace(/\D/g, ''))
  .refine((v) => v.length >= 10 && v.length <= 15, {
    message: 'telefone deve ter 10-15 digitos (DDI+DDD+numero)',
  });

export const portalBotDetectRoutes: FastifyPluginAsync = async (app) => {
  // Lista as pausas por suspeita de bot do PRÓPRIO fluxo (escopo = slot da sessão).
  app.get('/portal/bot-detect/pausas', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
    const pausas = await portalConfig.listBotDetectPausasBySlot(slot);
    return reply.code(200).send({ count: pausas.length, pausas });
  });

  // Despausa (rede de proteção): remove a pausa do PRÓPRIO fluxo. 404 se não havia pausa ativa.
  app.delete(
    '/portal/bot-detect/pausas/:telefone',
    { preHandler: withTenant },
    async (req, reply) => {
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
      log.info(
        { slot, userId, phone: maskPhone(telefone) },
        'bot-detect: numero despausado pelo cliente via portal',
      );
      return reply.code(200).send({ ok: true });
    },
  );
};
