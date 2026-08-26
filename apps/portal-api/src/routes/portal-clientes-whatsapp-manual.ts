/**
 * Envio manual e humano do CRM. É propositalmente uma rota owner-only: a
 * autorização atual do colaborador é read-only e não prova delegação segura de
 * contato externo. Não há bulk, agenda, fila, retry automático ou automação.
 */
import { logger } from '@startap/core/logger';
import { resolveSilenceGate } from '@startap/core/silence-gate';
import { clientBilling, cloneColaboradores, crmWhatsAppManual, flowClones } from '@startap/db';
import { waha } from '@startap/integrations';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import {
  isCrmWhatsAppManualCircuitClosed,
  recordCrmWhatsAppManualFailure,
  recordCrmWhatsAppManualSuccess,
  reserveCrmWhatsAppManualSlotSend,
} from '../lib/crm-whatsapp-manual-circuit.js';
import { requireTenant, withTenant } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'crm-whatsapp-manual' });
const HUMANIZATION_DELAY_MS = 12_000;

const paramsSchema = z.object({ id: z.string().uuid('id invalido') }).strict();
const bodySchema = z
  .object({
    mensagem: z.string().trim().min(1, 'mensagem obrigatoria').max(1000),
    confirmed: z.literal(true),
  })
  .strict();

const EXPECTED_BODY_KEYS = new Set(['mensagem', 'confirmed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Contrato rejeitado antes de qualquer acesso a dados ou WAHA. A telemetria é
 * deliberadamente estrutural: nunca registra valores, chaves inesperadas, IDs,
 * telefone, texto, headers ou cookies.
 */
function logInvalidContract(req: FastifyRequest, paramsValid: boolean, bodyValid: boolean): void {
  const rawBody: unknown = req.body;
  const rawParams: unknown = req.params;
  const bodyIsObject = isRecord(rawBody);
  const paramsIsObject = isRecord(rawParams);
  const rawId = paramsIsObject ? rawParams.id : undefined;

  log.warn(
    {
      request_id: req.id,
      body_is_object: bodyIsObject,
      expected_fields_present: {
        mensagem: bodyIsObject && Object.hasOwn(rawBody, 'mensagem'),
        confirmed: bodyIsObject && Object.hasOwn(rawBody, 'confirmed'),
      },
      unexpected_key_count: bodyIsObject
        ? Object.keys(rawBody).filter((key) => !EXPECTED_BODY_KEYS.has(key)).length
        : 0,
      id_type: typeof rawId,
      params_valid: paramsValid,
      body_valid: bodyValid,
    },
    'CRM WhatsApp manual rejeitado por contrato invalido',
  );
}

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
  app.post(
    '/portal/clientes/:id/whatsapp-manual',
    { preHandler: withTenant },
    async (req, reply) => {
      const scope = await resolveOwnerScope(req, reply);
      if (!scope) return reply;

      const params = paramsSchema.safeParse(req.params ?? {});
      const body = bodySchema.safeParse(req.body ?? {});
      if (!params.success || !body.success) {
        logInvalidContract(req, params.success, body.success);
        return reply.code(400).send({ error: 'dados_invalidos' });
      }

      const target = await crmWhatsAppManual.getClienteWhatsAppManualTargetForOwner(
        scope.slot,
        scope.tenantId,
        params.data.id,
      );
      if (!target) return reply.code(404).send({ error: 'cliente_nao_encontrado' });
      if (!target.wahaSessao) return reply.code(409).send({ error: 'sessao_waha_indisponivel' });

      const clone = await flowClones.getCloneBySlot(scope.slot);
      if (!clone || clone.tenant_id !== scope.tenantId) {
        log.warn(
          { slot: scope.slot, request_id: req.id, cliente_id: params.data.id },
          'estado operacional CRM WhatsApp indisponivel ou fora do tenant',
        );
        return reply.code(409).send({ error: 'estado_operacional_indisponivel' });
      }
      const silenceGate = resolveSilenceGate(clone, {
        graceDays: clientBilling.GRACE_DAYS,
        daysUntilDue: clientBilling.daysUntilDue,
        billingOverdueSilenceOn: config.BILLING_OVERDUE_SILENCE,
      });
      if (silenceGate.silenced) {
        log.warn(
          {
            slot: scope.slot,
            request_id: req.id,
            cliente_id: params.data.id,
            reason: silenceGate.reason,
          },
          'CRM WhatsApp bloqueado pelo gate operacional',
        );
        return reply.code(409).send({ error: 'fluxo_silenciado' });
      }

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

      if (
        !(await reserveCrmWhatsAppManualSlotSend(
          scope.slot,
          config.CRM_WHATSAPP_MANUAL_SLOT_MAX_SENDS,
          config.CRM_WHATSAPP_MANUAL_SLOT_WINDOW_SECONDS,
        ))
      ) {
        await crmWhatsAppManual.completeClienteWhatsAppManualSend({
          slot: scope.slot,
          tenantId: scope.tenantId,
          sendId: claim.sendId,
          outcome: 'failed',
          failureCode: 'slot_rate_limited',
        });
        log.warn(
          {
            slot: scope.slot,
            request_id: req.id,
            cliente_id: params.data.id,
            operator_user_id: scope.userId,
          },
          'CRM WhatsApp bloqueado pelo limite do slot',
        );
        return reply.code(429).send({ error: 'limite_envios_atingido' });
      }

      try {
        await waha.sendText({
          sessao: target.wahaSessao,
          shardId: target.wahaShardId,
          chatId: `${target.telefone}@c.us`,
          texto: body.data.mensagem,
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
    },
  );
};
