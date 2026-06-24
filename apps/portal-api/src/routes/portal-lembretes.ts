import { logger } from '@startap/core/logger';
/**
 * Lembrete de agendamento — CONFIG por clone no portal self-service (one-way). Migration 060.
 *
 * CONTRATO CONGELADO (o frontend constrói contra isto):
 *   GET   /portal/lembretes -> { enabled: boolean, windows_min: number[] }
 *         windows_min é SEMPRE não vazio: se o clone não configurou (NULL no banco), devolve o
 *         DEFAULT GLOBAL (resolveWindows -> DEFAULT_REMINDER_WINDOWS_MIN, ex.: [1440,120]).
 *   PATCH /portal/lembretes  body { enabled?: boolean, windows_min?: number[] }
 *         -> { enabled, windows_min } (estado NOVO). Valida windows_min contra o conjunto
 *         permitido (1440=24h, 180=3h, 120=2h, 60=1h); inválido -> 400. Escopado slot/tenant.
 *
 * ISOLAMENTO (regra de ouro 5, ADR 0012 Decisão 4): o slot vem SEMPRE de request.tenant.slot
 * (withTenant) — NUNCA de body/query/params. windows/template são do PRÓPRIO clone do user.
 *
 * GATING: flag REMINDERS_ENABLED OFF -> TODAS as rotas respondem 404 (feature dormente; não
 * vaza). O ENVIO em si vive no worker (gated lá por REMINDERS_ENABLED também) — esta rota só
 * controla a config/UI. MVP one-way: sem confirmar/cancelar por resposta.
 */
import {
  ALLOWED_REMINDER_WINDOWS_MIN,
  resolveWindows,
  validateWindows,
} from '@startap/core/reminders';
import { reminders } from '@startap/db';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { requireTenant, withTenant } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'lembretes' });

// Body do PATCH: enabled e/ou windows_min, ambos opcionais (exige >=1 via refine). strict()
// rejeita forjar slot/tenant_id/template (template não é editável v1 — usa o default).
const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    windows_min: z.array(z.number().int()).optional(),
  })
  .strict()
  .refine((b) => b.enabled !== undefined || b.windows_min !== undefined, {
    message: 'envie ao menos um campo (enabled ou windows_min)',
  });

/**
 * Gate: flag global. Responde 404 (flag OFF) e devolve false; senão true. (A resolução de
 * tenant não é necessária aqui — a config vive em flow_clones por slot, sem carimbar
 * tenant_id em escrita; mas o slot já é isolado pelo withTenant.)
 */
async function gateLembretes(_req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (!config.REMINDERS_ENABLED) {
    await reply.code(404).send({ error: 'recurso indisponivel' });
    return false;
  }
  return true;
}

export const portalLembretesRoutes: FastifyPluginAsync = async (app) => {
  // GET /portal/lembretes — estado atual do lembrete do clone (enabled + janelas efetivas).
  app.get('/portal/lembretes', { preHandler: withTenant }, async (req, reply) => {
    if (!(await gateLembretes(req, reply))) return reply;
    const { slot } = requireTenant(req);

    const cfg = await reminders.getReminderConfig(slot);
    if (!cfg) {
      // Clone ausente para o slot da sessão — dado inconsistente. Não vaza detalhe.
      return reply.code(404).send({ error: 'clone nao encontrado' });
    }
    // windows_min do contrato é SEMPRE não vazio: NULL no banco -> default global.
    return reply.code(200).send({
      enabled: cfg.enabled,
      windows_min: resolveWindows(cfg.windows_min),
    });
  });

  // PATCH /portal/lembretes — liga/desliga e/ou ajusta janelas. Valida o conjunto permitido.
  app.patch('/portal/lembretes', { preHandler: withTenant }, async (req, reply) => {
    if (!(await gateLembretes(req, reply))) return reply;
    const { slot } = requireTenant(req);

    const parsed = patchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'dados invalidos',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const b = parsed.data;

    // Valida janelas contra o conjunto permitido (core, fonte única). [] não chega aqui:
    // o schema exige array de inteiros, e o validador rejeita vazio -> 400 explícito.
    let windowsMin: number[] | undefined;
    if (b.windows_min !== undefined) {
      const v = validateWindows(b.windows_min);
      if (!v.ok) {
        return reply.code(400).send({
          error: 'windows_min invalido',
          permitido: ALLOWED_REMINDER_WINDOWS_MIN,
          reason: v.reason,
        });
      }
      windowsMin = v.windows;
    }

    const updated = await reminders.setReminderConfig(slot, {
      enabled: b.enabled,
      windowsMin,
    });
    if (!updated) {
      return reply.code(404).send({ error: 'clone nao encontrado' });
    }

    log.info(
      { slot, enabled: updated.enabled, windowsMin: updated.windows_min },
      'lembrete: config atualizada (portal)',
    );
    return reply.code(200).send({
      enabled: updated.enabled,
      windows_min: resolveWindows(updated.windows_min),
    });
  });
};
