/**
 * CRM de clientes finais do negócio (Missão 034, backend-only).
 *
 * Contrato server-authoritative:
 *  - identidade canônica = tenant_id + telefone canônico, nunca corpo do cliente;
 *  - owner vê lista/perfil/histórico e edita só aniversário/cidade/nota interna;
 *  - colaborador só lê clientes com atendimento próprio, nunca nota interna;
 *  - snapshots em `atendimentos` seguem imutáveis; backfill histórico fica fora do GET.
 */
import { clientes, cloneColaboradores } from '@startap/db';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import {
  requireColaborador,
  requireTenant,
  withColaborador,
  withTenant,
} from '../lib/tenant.js';

const listQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const semRetornoQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional(),
    offset: z.coerce.number().int().min(0).max(100).optional(),
  })
  .strict();

const DEFAULT_ANIVERSARIANTES_DIAS = 30;
const aniversariantesQuerySchema = z.discriminatedUnion('modo', [
  z
    .object({
      modo: z.literal('proximos'),
      dias: z.coerce.number().int().min(1).max(31).default(DEFAULT_ANIVERSARIANTES_DIAS),
      limit: z.coerce.number().int().min(1).max(50).optional(),
      offset: z.coerce.number().int().min(0).max(100).optional(),
    })
    .strict(),
  z
    .object({
      modo: z.literal('mes'),
      mes: z.coerce.number().int().min(1).max(12),
      limit: z.coerce.number().int().min(1).max(50).optional(),
      offset: z.coerce.number().int().min(0).max(100).optional(),
    })
    .strict(),
]);

const clienteIdParamSchema = z.object({
  id: z.string().uuid('id invalido'),
});

const mmddSchema = /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;

function isValidBirthdayMmdd(value: string): boolean {
  if (!mmddSchema.test(value)) return false;
  const [monthStr, dayStr] = value.split('-');
  const month = Number(monthStr);
  const day = Number(dayStr);
  const date = new Date(Date.UTC(2000, month - 1, day));
  return (
    date.getUTCFullYear() === 2000 &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const patchSchema = z
  .object({
    aniversario_mmdd: z
      .union([
        z
          .string()
          .regex(mmddSchema, 'aniversario_mmdd deve ser MM-DD')
          .refine(isValidBirthdayMmdd, 'aniversario_mmdd deve ser uma data real'),
        z.literal(''),
        z.null(),
      ])
      .optional(),
    cidade: z
      .union([z.string().trim().max(80), z.literal(''), z.null()])
      .optional(),
    nota_interna: z
      .union([z.string().trim().max(2000), z.literal(''), z.null()])
      .optional(),
  })
  .strict();

function formatIssues(error: z.ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

function normalizeAniversariantesQuery(query: unknown): unknown {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return query;
  const raw = query as Record<string, unknown>;
  if (raw.modo === undefined) {
    return {
      ...raw,
      modo: 'proximos',
      dias: raw.dias ?? DEFAULT_ANIVERSARIANTES_DIAS,
    };
  }
  if (raw.modo === 'proximos' && raw.dias === undefined) {
    return { ...raw, dias: DEFAULT_ANIVERSARIANTES_DIAS };
  }
  return raw;
}

async function gateClientesOwner(
  req: FastifyRequest,
  reply: FastifyReply,
) : Promise<{ slot: string; tenantId: string; timezone: string } | null> {
  if (!config.CRM_CLIENTES_ENABLED) {
    await reply.code(404).send({ error: 'feature_off' });
    return null;
  }
  const { slot } = requireTenant(req);
  const scope = await cloneColaboradores.getScopeBySlot(slot);
  if (!scope.tenant_id) {
    await reply.code(409).send({ error: 'cliente sem tenant_id (dado inconsistente)' });
    return null;
  }
  return { slot, tenantId: scope.tenant_id, timezone: scope.timezone };
}

async function gateRankingOwner(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ slot: string; tenantId: string; timezone: string } | null> {
  if (!config.CRM_CLIENTES_ENABLED || !config.RANKING_SEM_RETORNO_ENABLED) {
    await reply.code(404).send({ error: 'feature_off' });
    return null;
  }
  return gateClientesOwner(req, reply);
}

async function gateAniversariantesOwner(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ slot: string; tenantId: string; timezone: string } | null> {
  if (!config.CRM_CLIENTES_ENABLED || !config.CRM_ANIVERSARIANTES_ENABLED) {
    await reply.code(404).send({ error: 'feature_off' });
    return null;
  }
  return gateClientesOwner(req, reply);
}

async function gateClientesColaborador(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ slot: string; tenantId: string; colaboradorId: number } | null> {
  if (!config.CRM_CLIENTES_ENABLED || !config.COLABORADOR_PORTAL_ENABLED) {
    await reply.code(404).send({ error: 'feature_off' });
    return null;
  }
  const c = requireColaborador(req);
  return { slot: c.slot, tenantId: c.tenantId, colaboradorId: c.colaboradorId };
}

async function gateRankingColaborador(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ slot: string; tenantId: string; colaboradorId: number; timezone: string } | null> {
  if (
    !config.CRM_CLIENTES_ENABLED ||
    !config.COLABORADOR_PORTAL_ENABLED ||
    !config.RANKING_SEM_RETORNO_ENABLED
  ) {
    await reply.code(404).send({ error: 'feature_off' });
    return null;
  }
  const gate = await gateClientesColaborador(req, reply);
  if (!gate) return null;
  const scope = await cloneColaboradores.getScopeBySlot(gate.slot);
  return { ...gate, timezone: scope.timezone };
}

async function gateAniversariantesColaborador(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ slot: string; tenantId: string; colaboradorId: number; timezone: string } | null> {
  if (
    !config.CRM_CLIENTES_ENABLED ||
    !config.COLABORADOR_PORTAL_ENABLED ||
    !config.CRM_ANIVERSARIANTES_ENABLED
  ) {
    await reply.code(404).send({ error: 'feature_off' });
    return null;
  }
  const gate = await gateClientesColaborador(req, reply);
  if (!gate) return null;
  const scope = await cloneColaboradores.getScopeBySlot(gate.slot);
  return { ...gate, timezone: scope.timezone };
}

export const portalClientesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/portal/clientes', { preHandler: withTenant }, async (req, reply) => {
    const gate = await gateClientesOwner(req, reply);
    if (!gate) return reply;

    const parsed = listQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'parametros invalidos', issues: formatIssues(parsed.error) });
    }

    const result = await clientes.listClientesForOwner({
      slot: gate.slot,
      tenantId: gate.tenantId,
      search: parsed.data.q,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
    return reply.code(200).send(result);
  });

  app.get('/portal/clientes/sem-retorno', { preHandler: withTenant }, async (req, reply) => {
    const gate = await gateRankingOwner(req, reply);
    if (!gate) return reply;

    const parsed = semRetornoQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'parametros invalidos', issues: formatIssues(parsed.error) });
    }

    const result = await clientes.listClientesSemRetornoForOwner({
      slot: gate.slot,
      tenantId: gate.tenantId,
      timezone: gate.timezone,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
    return reply.code(200).send(result);
  });

  app.get('/portal/clientes/aniversariantes', { preHandler: withTenant }, async (req, reply) => {
    const gate = await gateAniversariantesOwner(req, reply);
    if (!gate) return reply;

    const parsed = aniversariantesQuerySchema.safeParse(normalizeAniversariantesQuery(req.query));
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'parametros invalidos', issues: formatIssues(parsed.error) });
    }

    const result =
      parsed.data.modo === 'proximos'
        ? await clientes.listClientesAniversariantesForOwner({
            slot: gate.slot,
            tenantId: gate.tenantId,
            timezone: gate.timezone,
            mode: 'proximos',
            dias: parsed.data.dias,
            limit: parsed.data.limit,
            offset: parsed.data.offset,
          })
        : await clientes.listClientesAniversariantesForOwner({
            slot: gate.slot,
            tenantId: gate.tenantId,
            timezone: gate.timezone,
            mode: 'mes',
            mes: parsed.data.mes,
            limit: parsed.data.limit,
            offset: parsed.data.offset,
          });
    return reply.code(200).send(result);
  });

  app.get('/portal/clientes/:id', { preHandler: withTenant }, async (req, reply) => {
    const gate = await gateClientesOwner(req, reply);
    if (!gate) return reply;

    const parsed = clienteIdParamSchema.safeParse(req.params ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'id invalido' });
    }

    const cliente = await clientes.getClienteProfileForOwner(
      gate.slot,
      gate.tenantId,
      parsed.data.id,
    );
    if (!cliente) {
      return reply.code(404).send({ error: 'cliente nao encontrado' });
    }
    const historico = await clientes.listClienteHistoricoForOwner({
      slot: gate.slot,
      tenantId: gate.tenantId,
      clienteId: parsed.data.id,
    });
    return reply.code(200).send({ cliente, historico });
  });

  app.patch('/portal/clientes/:id', { preHandler: withTenant }, async (req, reply) => {
    const gate = await gateClientesOwner(req, reply);
    if (!gate) return reply;

    const idParsed = clienteIdParamSchema.safeParse(req.params ?? {});
    if (!idParsed.success) {
      return reply.code(400).send({ error: 'id invalido' });
    }
    const bodyParsed = patchSchema.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: 'dados invalidos', issues: formatIssues(bodyParsed.error) });
    }

    const body = bodyParsed.data;
    if (Object.keys(body).length === 0) {
      return reply.code(400).send({ error: 'envie ao menos um campo para alterar' });
    }

    const cliente = await clientes.updateClienteProfileForOwner(
      gate.slot,
      gate.tenantId,
      idParsed.data.id,
      {
        aniversario_mmdd:
          body.aniversario_mmdd === '' ? null : (body.aniversario_mmdd ?? undefined),
        cidade: body.cidade === '' ? null : (body.cidade ?? undefined),
        nota_interna: body.nota_interna === '' ? null : (body.nota_interna ?? undefined),
      },
    );
    if (!cliente) {
      return reply.code(404).send({ error: 'cliente nao encontrado' });
    }
    return reply.code(200).send({ ok: true, cliente });
  });

  app.get('/portal/colaborador/clientes', { preHandler: withColaborador }, async (req, reply) => {
    const gate = await gateClientesColaborador(req, reply);
    if (!gate) return reply;

    const parsed = listQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'parametros invalidos', issues: formatIssues(parsed.error) });
    }

    const result = await clientes.listClientesForColaborador({
      slot: gate.slot,
      tenantId: gate.tenantId,
      colaboradorId: gate.colaboradorId,
      search: parsed.data.q,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
    return reply.code(200).send(result);
  });

  app.get(
    '/portal/colaborador/clientes/sem-retorno',
    { preHandler: withColaborador },
    async (req, reply) => {
      const gate = await gateRankingColaborador(req, reply);
      if (!gate) return reply;

      const parsed = semRetornoQuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'parametros invalidos', issues: formatIssues(parsed.error) });
      }

      const result = await clientes.listClientesSemRetornoForColaborador({
        slot: gate.slot,
        tenantId: gate.tenantId,
        colaboradorId: gate.colaboradorId,
        timezone: gate.timezone,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      });
      return reply.code(200).send(result);
    },
  );

  app.get(
    '/portal/colaborador/clientes/aniversariantes',
    { preHandler: withColaborador },
    async (req, reply) => {
      const gate = await gateAniversariantesColaborador(req, reply);
      if (!gate) return reply;

      const parsed = aniversariantesQuerySchema.safeParse(normalizeAniversariantesQuery(req.query));
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'parametros invalidos', issues: formatIssues(parsed.error) });
      }

      const result =
        parsed.data.modo === 'proximos'
          ? await clientes.listClientesAniversariantesForColaborador({
              slot: gate.slot,
              tenantId: gate.tenantId,
              colaboradorId: gate.colaboradorId,
              timezone: gate.timezone,
              mode: 'proximos',
              dias: parsed.data.dias,
              limit: parsed.data.limit,
              offset: parsed.data.offset,
            })
          : await clientes.listClientesAniversariantesForColaborador({
              slot: gate.slot,
              tenantId: gate.tenantId,
              colaboradorId: gate.colaboradorId,
              timezone: gate.timezone,
              mode: 'mes',
              mes: parsed.data.mes,
              limit: parsed.data.limit,
              offset: parsed.data.offset,
            });
      return reply.code(200).send(result);
    },
  );

  app.get(
    '/portal/colaborador/clientes/:id',
    { preHandler: withColaborador },
    async (req, reply) => {
      const gate = await gateClientesColaborador(req, reply);
      if (!gate) return reply;

      const parsed = clienteIdParamSchema.safeParse(req.params ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'id invalido' });
      }

      const cliente = await clientes.getClienteProfileForColaborador(
        gate.slot,
        gate.tenantId,
        gate.colaboradorId,
        parsed.data.id,
      );
      if (!cliente) {
        return reply.code(404).send({ error: 'cliente nao encontrado' });
      }
      const historico = await clientes.listClienteHistoricoForColaborador({
        slot: gate.slot,
        tenantId: gate.tenantId,
        colaboradorId: gate.colaboradorId,
        clienteId: parsed.data.id,
      });
      return reply.code(200).send({ cliente, historico });
    },
  );
};
