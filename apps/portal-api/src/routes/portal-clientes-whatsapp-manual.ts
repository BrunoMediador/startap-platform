/**
 * Envio manual e humano do CRM. É propositalmente uma rota owner-only: a
 * autorização atual do colaborador é read-only e não prova delegação segura de
 * contato externo. Não há bulk, agenda, fila, retry automático ou automação.
 */
import { logger } from '@startap/core/logger';
import { cloneColaboradores, crmWhatsAppManual } from '@startap/db';
import { waha } from '@startap/integrations';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import {
  isCrmWhatsAppManualCircuitClosed,
  recordCrmWhatsAppManualFailure,
  recordCrmWhatsAppManualSuccess,
} from '../lib/crm-whatsapp-manual-circuit.js';
import { requireTenant, withTenant } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'crm-whatsapp-manual' });
const HUMANIZATION_DELAY_MS = 12_000;

const paramsSchema = z.object({ id: z.string().uuid('id invalido') }).strict();
const bodySchema = z
  .object({ texto: z.string().trim().min(1, 'texto obrigatorio').max(1000) })
  .strict();

interface OwnerScope {
  slot: string;
  tenantId: string;
  userId: number;
}

async function resolveOwnerScope(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<OwnerScope | null> {
  if (!config.CRM_CLIENTES_ENABLED || !config.CRM_WHATSAPP_MANUAL_ENABLED) {
    await reply.code(404).send({ error: 'feature_off' });
    return null;
  }
  const tenant = requireTenant(req);
  const scope = await cloneColaboradores.getScopeBySlot(tenant.slot);
  if (!scope.tenant_id) {
    await reply.code(409).send({ error: 'tenant_inconsistente' });
    return null;
  }
  return { slot: tenant.slot, tenantId: scope.tenant_id, userId: tenant.userId };
}

export const portalClientesWhatsAppManualRoutes: FastifyPluginAsync = async (app) => {
  app.post('/portal/clientes/:id/whatsapp', { preHandler: withTenant }, async (req, reply) => {
    const scope = await resolveOwnerScope(req, reply);
    if (!scope) return reply;

    const params = paramsSchema.safeParse(req.params ?? {});
    const body = bodySchema.safeParse(req.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'dados_invalidos' });
    }

    const target = await crmWhatsAppManual.getClienteWhatsAppManualTargetForOwner(
      scope.slot,
      scope.tenantId,
      params.data.id,
    );
    if (!target) return reply.code(404).send({ error: 'cliente_nao_encontrado' });
    if (!target.wahaSessao) return reply.code(409).send({ error: 'sessao_waha_indisponivel' });

    // Primeiro resolve/autoriza o alvo; só então cria o claim idempotente. Assim um id
    // inválido não consome o cooldown e nunca deixa auditoria sem cliente válido.
    const claim = await crmWhatsAppManual.claimClienteWhatsAppManualSend({
      slot: scope.slot,
      tenantId: scope.tenantId,
      clienteId: params.data.id,
      operatorUserId: scope.userId,
      cooldownMs: config.CRM_WHATSAPP_MANUAL_COOLDOWN_MS,
    });
    if (!claim) return reply.code(409).send({ error: 'cooldown_ativo' });

    if (!(await isCrmWhatsAppManualCircuitClosed(scope.slot))) {
      await crmWhatsAppManual.completeClienteWhatsAppManualSend({
        slot: scope.slot,
        tenantId: scope.tenantId,
        sendId: claim.sendId,
        outcome: 'failed',
        failureCode: 'circuit_open',
      });
      return reply.code(503).send({ error: 'envio_indisponivel' });
    }

    try {
      await waha.sendText({
        sessao: target.wahaSessao,
        chatId: `${target.telefone}@c.us`,
        texto: body.data.texto,
        typing: true,
        delayMs: HUMANIZATION_DELAY_MS,
        signal: AbortSignal.timeout(config.CRM_WHATSAPP_MANUAL_TIMEOUT_MS),
      });
      await crmWhatsAppManual.completeClienteWhatsAppManualSend({
        slot: scope.slot,
        tenantId: scope.tenantId,
        sendId: claim.sendId,
        outcome: 'sent',
      });
      await recordCrmWhatsAppManualSuccess(scope.slot);
      log.info(
        {
          slot: scope.slot,
          request_id: req.id,
          cliente_id: params.data.id,
          operator_user_id: scope.userId,
        },
        'CRM WhatsApp manual enviado',
      );
      return reply.code(202).send({ ok: true });
    } catch {
      await crmWhatsAppManual.completeClienteWhatsAppManualSend({
        slot: scope.slot,
        tenantId: scope.tenantId,
        sendId: claim.sendId,
        outcome: 'failed',
        failureCode: 'timeout_or_waha_error',
      });
      await recordCrmWhatsAppManualFailure(scope.slot);
      log.warn(
        {
          slot: scope.slot,
          request_id: req.id,
          cliente_id: params.data.id,
          operator_user_id: scope.userId,
        },
        'CRM WhatsApp manual falhou',
      );
      return reply.code(503).send({ error: 'envio_indisponivel' });
    }
  });
};
