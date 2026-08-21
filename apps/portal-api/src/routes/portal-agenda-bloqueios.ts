/**
 * Bloqueios de agenda (SCRUM-B/C) — fundação backend dormente por flag.
 *
 * DONO:
 *   - /portal/agenda/bloqueios lista/cria/remove bloqueios do tenant.
 *   - pode informar colaborador_id para atuar na agenda de um profissional.
 *
 * COLABORADOR:
 *   - /portal/colaborador/bloqueios lista/cria/remove apenas os próprios bloqueios.
 *   - colaborador_id nunca vem do input; vem da sessão via withColaborador.
 *
 * Segurança:
 *   - AGENDA_BLOQUEIOS_ENABLED ausente/OFF ou slot fora de AGENDA_BLOQUEIOS_SLOTS
 *     -> 404 antes de DB/GCal mutante. '*' libera rollout geral explicitamente.
 *   - rotas do colaborador também exigem COLABORADOR_PORTAL_ENABLED.
 *   - slot/tenant sempre da sessão/banco, nunca do body/query.
 *   - evento GCal nasce com marker privado kind='bloqueio' para o reconciler ignorar.
 *   - gcal_event_id é determinístico por bloqueio, fechando timeout ambíguo no insert.
 */
import { randomUUID } from 'node:crypto';
import { hashEventIdForLog } from '@startap/core/gcal-event-log';
import { logger } from '@startap/core/logger';
import { agendaBloqueios, cloneColaboradores } from '@startap/db';
import { gcal } from '@startap/integrations';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import {
  requireColaborador,
  requireTenant,
  withColaborador,
  withTenant,
} from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'agenda-bloqueios' });

type ResolvedGcalClient = NonNullable<Awaited<ReturnType<typeof gcal.getGcalForSlot>>>;

const tipoSchema = z.enum(['almoco', 'ausencia', 'ferias', 'indisponivel']);

const criarBloqueioSchema = z
  .object({
    inicio_at: z.string().datetime({ offset: true }),
    fim_at: z.string().datetime({ offset: true }),
    timezone: z.string().trim().min(1).max(80).default('America/Sao_Paulo'),
    tipo: tipoSchema,
    motivo: z
      .preprocess((v) => (v == null || v === '' ? undefined : v), z.string().trim().max(240))
      .optional(),
    colaborador_id: z.preprocess(
      (v) => (v == null || v === '' ? undefined : v),
      z.coerce.number().int().positive().optional(),
    ),
  })
  .strict()
  .refine((b) => new Date(b.fim_at).getTime() > new Date(b.inicio_at).getTime(), {
    message: 'fim_at deve ser depois de inicio_at',
    path: ['fim_at'],
  });

const listQuerySchema = z
  .object({
    inicio_at: z.string().datetime({ offset: true }).optional(),
    fim_at: z.string().datetime({ offset: true }).optional(),
    colaborador_id: z.preprocess(
      (v) => (v == null || v === '' ? undefined : v),
      z.coerce.number().int().positive().optional(),
    ),
  })
  .strict()
  .refine(
    (q) =>
      !q.inicio_at ||
      !q.fim_at ||
      new Date(q.fim_at).getTime() > new Date(q.inicio_at).getTime(),
    { message: 'fim_at deve ser depois de inicio_at', path: ['fim_at'] },
  );

const paramsSchema = z.object({ id: z.string().uuid() });

interface TenantScope {
  slot: string;
  tenantId: string;
  timezone: string;
}

interface GcalTarget {
  client: ResolvedGcalClient;
  colaboradorId: number | null;
}

function slotAllowed(slot: string, slotsConfig: string): boolean {
  const entries = slotsConfig
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (entries.length === 0) return false;
  if (entries.includes('*')) return true;
  return entries.includes(slot);
}

function gateEnabled(slot: string, reply: FastifyReply): boolean {
  if (!config.AGENDA_BLOQUEIOS_ENABLED || !slotAllowed(slot, config.AGENDA_BLOQUEIOS_SLOTS)) {
    reply.code(404).send({ error: 'feature_off' });
    return false;
  }
  return true;
}

function gateColaboradorEnabled(slot: string, reply: FastifyReply): boolean {
  if (!gateEnabled(slot, reply)) return false;
  if (!config.COLABORADOR_PORTAL_ENABLED) {
    reply.code(404).send({ error: 'feature_off' });
    return false;
  }
  return true;
}

function gcalEventIdForBloqueio(bloqueioId: string): string {
  return `bloq${bloqueioId.replaceAll('-', '').toLowerCase()}`;
}

async function resolveOwnerScope(slot: string, reply: FastifyReply): Promise<TenantScope | null> {
  const scope = await cloneColaboradores.getScopeBySlot(slot);
  if (!scope.tenant_id) {
    await reply.code(409).send({ error: 'tenant_inconsistente' });
    return null;
  }
  return { slot, tenantId: scope.tenant_id, timezone: scope.timezone };
}

async function resolveTarget(
  slot: string,
  colaboradorId: number | null,
): Promise<GcalTarget | null> {
  if (colaboradorId == null) {
    const client = await gcal.getGcalForSlot(slot);
    return client ? { client, colaboradorId: null } : null;
  }
  const colaboradores = await gcal.getGcalsForSlot(slot);
  const alvo = colaboradores.find((c) => c.colaboradorId === colaboradorId);
  return alvo ? { client: alvo.client, colaboradorId: alvo.colaboradorId } : null;
}

function blockSummary(tipo: agendaBloqueios.AgendaBloqueioTipo, motivo?: string | null): string {
  const labels: Record<agendaBloqueios.AgendaBloqueioTipo, string> = {
    almoco: 'Almoço',
    ausencia: 'Ausência',
    ferias: 'Férias',
    indisponivel: 'Indisponível',
  };
  const base = `Bloqueio: ${labels[tipo]}`;
  const cleanMotivo = motivo?.trim();
  return cleanMotivo ? `${base} - ${cleanMotivo.slice(0, 80)}` : base;
}

async function handleCreate(args: {
  scope: TenantScope;
  input: z.infer<typeof criarBloqueioSchema>;
  createdByRole: agendaBloqueios.AgendaBloqueioCreatedByRole;
  createdByUserId?: number | null;
  createdByColaboradorId?: number | null;
  forcedColaboradorId?: number | null;
  reply: FastifyReply;
}) {
  const colaboradorId = args.forcedColaboradorId ?? args.input.colaborador_id ?? null;
  const target = await resolveTarget(args.scope.slot, colaboradorId);
  if (!target) {
    return args.reply
      .code(colaboradorId == null ? 422 : 404)
      .send({ error: colaboradorId == null ? 'gcal_nao_configurado' : 'colaborador_nao_encontrado' });
  }

  const bloqueioId = randomUUID();
  const gcalEventId = gcalEventIdForBloqueio(bloqueioId);
  await agendaBloqueios.create({
    id: bloqueioId,
    tenantId: args.scope.tenantId,
    slot: args.scope.slot,
    colaboradorId: target.colaboradorId,
    gcalEventId,
    inicioAt: args.input.inicio_at,
    fimAt: args.input.fim_at,
    timezone: args.input.timezone || args.scope.timezone,
    tipo: args.input.tipo,
    motivo: args.input.motivo ?? null,
    createdByRole: args.createdByRole,
    createdByUserId: args.createdByUserId ?? null,
    createdByColaboradorId: args.createdByColaboradorId ?? null,
  });

  try {
    await target.client.createEvent({
      eventId: gcalEventId,
      summary: blockSummary(args.input.tipo, args.input.motivo),
      startISO: args.input.inicio_at,
      endISO: args.input.fim_at,
      timeZone: args.input.timezone || args.scope.timezone,
      extendedPropertiesPrivate: {
        kind: 'bloqueio',
        bloqueioId,
        colaboradorId: target.colaboradorId == null ? '' : String(target.colaboradorId),
      },
    });
    const attached = await agendaBloqueios.attachGcalEventId(
      args.scope.tenantId,
      args.scope.slot,
      bloqueioId,
      gcalEventId,
    );
    if (!attached) throw new Error('bloqueio_local_nao_encontrado_apos_gcal');
    log.info(
      {
        slot: args.scope.slot,
        bloqueioId: attached.id,
        colaboradorId: attached.colaborador_id,
        eventId: hashEventIdForLog(gcalEventId),
      },
      'bloqueio de agenda criado',
    );
    return args.reply.code(201).send({ ok: true, bloqueio: attached });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/40[13]/.test(msg)) gcal.invalidateGcalCache(args.scope.slot);
    let cleanupFailed = false;
    try {
      await target.client.deleteEvent(gcalEventId);
    } catch (cleanupErr) {
      const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      cleanupFailed = !/HTTP 404/.test(cleanupMsg);
      if (cleanupFailed) {
        log.error(
          {
            slot: args.scope.slot,
            bloqueioId,
            colaboradorId: target.colaboradorId,
            eventId: hashEventIdForLog(gcalEventId),
            err: cleanupMsg,
          },
          'cleanup de bloqueio no GCal falhou — linha local permanece removível',
        );
      }
    }
    if (cleanupFailed) {
      await agendaBloqueios.markCreateCleanupFailed(args.scope.tenantId, args.scope.slot, bloqueioId);
    } else {
      await agendaBloqueios.markCreateFailed(args.scope.tenantId, args.scope.slot, bloqueioId);
    }
    log.error(
      {
        slot: args.scope.slot,
        bloqueioId,
        colaboradorId: target.colaboradorId,
        eventId: hashEventIdForLog(gcalEventId),
        err: msg,
        cleanupFailed,
      },
      'falha ao criar bloqueio no GCal',
    );
    return args.reply.code(502).send({ error: 'nao_foi_possivel_criar_bloqueio' });
  }
}

async function handleRemove(args: {
  scope: TenantScope;
  id: string;
  colaboradorId?: number | null;
  reply: FastifyReply;
}) {
  const row = await agendaBloqueios.getActiveById(
    args.scope.tenantId,
    args.scope.slot,
    args.id,
    args.colaboradorId,
  );
  if (!row) return args.reply.code(404).send({ error: 'bloqueio_nao_encontrado' });

  const target = await resolveTarget(args.scope.slot, row.colaborador_id);
  if (!target) return args.reply.code(422).send({ error: 'gcal_nao_configurado' });

  if (row.gcal_event_id) {
    try {
      await target.client.deleteEvent(row.gcal_event_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/HTTP 404/.test(msg)) {
        if (/40[13]/.test(msg)) gcal.invalidateGcalCache(args.scope.slot);
        log.error(
          {
            slot: args.scope.slot,
            bloqueioId: row.id,
            eventId: hashEventIdForLog(row.gcal_event_id),
            err: msg,
          },
          'falha ao remover bloqueio no GCal',
        );
        return args.reply.code(502).send({ error: 'nao_foi_possivel_remover_bloqueio' });
      }
    }
  }

  const deleted = await agendaBloqueios.softDeleteById(
    args.scope.tenantId,
    args.scope.slot,
    args.id,
    args.colaboradorId,
  );
  if (!deleted) return args.reply.code(404).send({ error: 'bloqueio_nao_encontrado' });
  log.info(
    {
      slot: args.scope.slot,
      bloqueioId: deleted.id,
      colaboradorId: deleted.colaborador_id,
      eventId: deleted.gcal_event_id ? hashEventIdForLog(deleted.gcal_event_id) : undefined,
    },
    'bloqueio de agenda removido',
  );
  return args.reply.code(200).send({ ok: true });
}

export const portalAgendaBloqueiosRoutes: FastifyPluginAsync = async (app) => {
  app.get('/portal/agenda/bloqueios', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
    if (!gateEnabled(slot, reply)) return reply;
    const scope = await resolveOwnerScope(slot, reply);
    if (!scope) return reply;
    const parsed = listQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'payload_invalido' });
    const rows = await agendaBloqueios.list({
      tenantId: scope.tenantId,
      slot,
      colaboradorId: parsed.data.colaborador_id,
      inicioAt: parsed.data.inicio_at,
      fimAt: parsed.data.fim_at,
    });
    return reply.code(200).send({ count: rows.length, bloqueios: rows });
  });

  app.post('/portal/agenda/bloqueios', { preHandler: withTenant }, async (req, reply) => {
    const { slot, userId } = requireTenant(req);
    if (!gateEnabled(slot, reply)) return reply;
    const scope = await resolveOwnerScope(slot, reply);
    if (!scope) return reply;
    const parsed = criarBloqueioSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'payload_invalido' });
    return handleCreate({
      scope,
      input: parsed.data,
      createdByRole: 'owner',
      createdByUserId: userId,
      reply,
    });
  });

  app.delete('/portal/agenda/bloqueios/:id', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
    if (!gateEnabled(slot, reply)) return reply;
    const scope = await resolveOwnerScope(slot, reply);
    if (!scope) return reply;
    const parsed = paramsSchema.safeParse(req.params ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'id_invalido' });
    return handleRemove({ scope, id: parsed.data.id, reply });
  });

  app.get('/portal/colaborador/bloqueios', { preHandler: withColaborador }, async (req, reply) => {
    const { slot, tenantId, colaboradorId } = requireColaborador(req);
    if (!gateColaboradorEnabled(slot, reply)) return reply;
    const parsed = listQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'payload_invalido' });
    const rows = await agendaBloqueios.list({
      tenantId,
      slot,
      colaboradorId,
      inicioAt: parsed.data.inicio_at,
      fimAt: parsed.data.fim_at,
    });
    return reply.code(200).send({ count: rows.length, bloqueios: rows });
  });

  app.post('/portal/colaborador/bloqueios', { preHandler: withColaborador }, async (req, reply) => {
    const { slot, tenantId, colaboradorId } = requireColaborador(req);
    if (!gateColaboradorEnabled(slot, reply)) return reply;
    const parsed = criarBloqueioSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'payload_invalido' });
    return handleCreate({
      scope: { slot, tenantId, timezone: parsed.data.timezone },
      input: parsed.data,
      createdByRole: 'colaborador',
      createdByColaboradorId: colaboradorId,
      forcedColaboradorId: colaboradorId,
      reply,
    });
  });

  app.delete(
    '/portal/colaborador/bloqueios/:id',
    { preHandler: withColaborador },
    async (req, reply) => {
      const { slot, tenantId, colaboradorId } = requireColaborador(req);
      if (!gateColaboradorEnabled(slot, reply)) return reply;
      const parsed = paramsSchema.safeParse(req.params ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'id_invalido' });
      return handleRemove({
        scope: { slot, tenantId, timezone: 'America/Sao_Paulo' },
        id: parsed.data.id,
        colaboradorId,
        reply,
      });
    },
  );
};
