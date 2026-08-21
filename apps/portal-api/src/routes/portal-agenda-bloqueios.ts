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
import {
  OCORRENCIAS_MAX,
  OCORRENCIAS_MIN,
  PERIODICIDADES,
  type Periodicidade,
  expandirDatas,
} from '@startap/core/recorrencia';
import { hashEventIdForLog } from '@startap/core/gcal-event-log';
import { logger } from '@startap/core/logger';
import { agendaBloqueios, cloneColaboradores } from '@startap/db';
import { gcal } from '@startap/integrations';
import { zonedWallTimeToUtc } from '@startap/integrations/scheduling';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { isGcalForbiddenOrAuthError, isGcalRateLimitError } from '../lib/gcal-rate-limit.js';
import type { AvaliarSlotConflito } from '../lib/avaliar-slot.js';
import {
  requireColaborador,
  requireTenant,
  withColaborador,
  withTenant,
} from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'agenda-bloqueios' });

type ResolvedGcalClient = NonNullable<Awaited<ReturnType<typeof gcal.getGcalForSlot>>>;

const tipoSchema = z.enum(['almoco', 'ausencia', 'ferias', 'indisponivel']);
const periodicidadeSchema = z.enum(PERIODICIDADES);

const criarBloqueioBaseSchema = z
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
  .strict();

const criarBloqueioSchema = criarBloqueioBaseSchema
  .refine((b) => new Date(b.fim_at).getTime() > new Date(b.inicio_at).getTime(), {
    message: 'fim_at deve ser depois de inicio_at',
    path: ['fim_at'],
  });

const previewRecorrenciaSchema = criarBloqueioBaseSchema
  .extend({
    periodicidade: periodicidadeSchema,
    ocorrencias: z.coerce.number().int().min(OCORRENCIAS_MIN).max(OCORRENCIAS_MAX),
  })
  .refine((b) => new Date(b.fim_at).getTime() > new Date(b.inicio_at).getTime(), {
    message: 'fim_at deve ser depois de inicio_at',
    path: ['fim_at'],
  });

// Contrato canônico do POST /serie:
// o cliente reenvia a âncora + periodicidade + quantidade, e o servidor RECALCULA a
// série inteira. Não aceitamos lista arbitrária de datas/ocorrências no body final.
const criarSerieSchema = previewRecorrenciaSchema;

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
const serieParamsSchema = z.object({ serieId: z.string().uuid() });

interface TenantScope {
  slot: string;
  tenantId: string;
  timezone: string;
}

interface GcalTarget {
  client: ResolvedGcalClient;
  colaboradorId: number | null;
}

interface BloqueioCreatePayload {
  inicio_at: string;
  fim_at: string;
  timezone: string;
  tipo: agendaBloqueios.AgendaBloqueioTipo;
  motivo?: string | null;
}

interface BloqueioSerieOccurrence {
  inicio_at: string;
  fim_at: string;
}

type BloqueioPreviewStatus = 'livre' | 'ocupado';
type CreateOccurrenceResult =
  | { ok: true; bloqueio: agendaBloqueios.AgendaBloqueioRow }
  | { ok: false; error: 'rate_limit' | 'gcal_falhou' };

type RemoveOccurrenceResult =
  | { ok: true; bloqueio: agendaBloqueios.AgendaBloqueioRow }
  | {
      ok: false;
      error: 'rate_limit' | 'gcal_falhou' | 'gcal_nao_configurado' | 'bloqueio_nao_encontrado';
    };

type CreateOccurrenceError = Extract<CreateOccurrenceResult, { ok: false }>['error'];
type RemoveOccurrenceError = Extract<RemoveOccurrenceResult, { ok: false }>['error'];

type SerieFailureReason =
  | 'gcal_rate_limit'
  | 'erro_gcal'
  | 'gcal_nao_configurado'
  | 'bloqueio_nao_encontrado';

function assertNever(value: never): never {
  throw new Error(`unsupported value: ${String(value)}`);
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

function mapCreateFailureReason(error: CreateOccurrenceError): SerieFailureReason {
  return error === 'rate_limit' ? 'gcal_rate_limit' : 'erro_gcal';
}

function mapRemoveFailureReason(error: RemoveOccurrenceError): SerieFailureReason {
  switch (error) {
    case 'rate_limit':
      return 'gcal_rate_limit';
    case 'gcal_falhou':
      return 'erro_gcal';
    case 'gcal_nao_configurado':
      return 'gcal_nao_configurado';
    case 'bloqueio_nao_encontrado':
      return 'bloqueio_nao_encontrado';
    default:
      return assertNever(error);
  }
}

function formatDateKeyInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) throw new Error(`nao foi possivel formatar data em ${timeZone}`);
  return `${year}-${month}-${day}`;
}

function getWallMinutesInTimeZone(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 'NaN');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 'NaN');
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    throw new Error(`nao foi possivel resolver horario em ${timeZone}`);
  }
  return hour * 60 + minute;
}

function expandirOcorrenciasSerie(input: {
  inicioAt: string;
  fimAt: string;
  timeZone: string;
  periodicidade: Periodicidade;
  ocorrencias: number;
}): BloqueioSerieOccurrence[] {
  const start = new Date(input.inicioAt);
  const end = new Date(input.fimAt);
  const durationMs = end.getTime() - start.getTime();
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('intervalo invalido para recorrencia');
  }
  const dataAncora = formatDateKeyInTimeZone(start, input.timeZone);
  const startMinutes = getWallMinutesInTimeZone(start, input.timeZone);
  return expandirDatas(dataAncora, input.periodicidade, input.ocorrencias).map((dataKey) => {
    const startUtc = zonedWallTimeToUtc(dataKey, startMinutes, input.timeZone);
    return {
      inicio_at: startUtc.toISOString(),
      fim_at: new Date(startUtc.getTime() + durationMs).toISOString(),
    };
  });
}

async function avaliarPreviewOcorrencia(args: {
  target: GcalTarget;
  occurrence: BloqueioSerieOccurrence;
}): Promise<{ status: BloqueioPreviewStatus; conflito?: AvaliarSlotConflito }> {
  // Compatível com o bloqueio simples: o preview só INFORMA conflito de agenda já ocupado;
  // não veta a criação da série. O create simples continua podendo sobrepor horários.
  const existing = await args.target.client.listEvents({
    timeMin: args.occurrence.inicio_at,
    timeMax: args.occurrence.fim_at,
  });
  const conflito = existing.find((ev) => {
    const evStart = new Date(ev.start.dateTime ?? `${ev.start.date}T00:00:00`).getTime();
    const evEnd = new Date(ev.end.dateTime ?? `${ev.end.date}T00:00:00`).getTime();
    return (
      evStart < new Date(args.occurrence.fim_at).getTime() &&
      evEnd > new Date(args.occurrence.inicio_at).getTime()
    );
  });
  if (!conflito) return { status: 'livre' };
  return {
    status: 'ocupado',
    // Privacidade: expõe só a janela ocupada, nunca título/descrição/telefone.
    conflito: {
      inicio: conflito.start.dateTime ?? conflito.start.date ?? null,
      fim: conflito.end.dateTime ?? conflito.end.date ?? null,
    },
  };
}

async function createOccurrence(args: {
  scope: TenantScope;
  input: BloqueioCreatePayload;
  target: GcalTarget;
  createdByRole: agendaBloqueios.AgendaBloqueioCreatedByRole;
  createdByUserId?: number | null;
  createdByColaboradorId?: number | null;
  serieId?: string | null;
}): Promise<CreateOccurrenceResult> {
  const bloqueioId = randomUUID();
  const gcalEventId = gcalEventIdForBloqueio(bloqueioId);
  await agendaBloqueios.create({
    id: bloqueioId,
    tenantId: args.scope.tenantId,
    slot: args.scope.slot,
    colaboradorId: args.target.colaboradorId,
    serieId: args.serieId ?? null,
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
    await args.target.client.createEvent({
      eventId: gcalEventId,
      summary: blockSummary(args.input.tipo, args.input.motivo),
      startISO: args.input.inicio_at,
      endISO: args.input.fim_at,
      timeZone: args.input.timezone || args.scope.timezone,
      extendedPropertiesPrivate: {
        kind: 'bloqueio',
        bloqueioId,
        colaboradorId:
          args.target.colaboradorId == null ? '' : String(args.target.colaboradorId),
        ...(args.serieId ? { serie_id: args.serieId } : {}),
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
        serieId: attached.serie_id,
      },
      'bloqueio de agenda criado',
    );
    return { ok: true, bloqueio: attached };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isGcalForbiddenOrAuthError(msg)) gcal.invalidateGcalCache(args.scope.slot);
    let cleanupFailed = false;
    try {
      await args.target.client.deleteEvent(gcalEventId);
    } catch (cleanupErr) {
      const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      cleanupFailed = !/HTTP 404/.test(cleanupMsg);
      if (cleanupFailed) {
        log.error(
          {
            slot: args.scope.slot,
            bloqueioId,
            colaboradorId: args.target.colaboradorId,
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
        colaboradorId: args.target.colaboradorId,
        eventId: hashEventIdForLog(gcalEventId),
        err: msg,
        cleanupFailed,
        serieId: args.serieId ?? null,
      },
      'falha ao criar bloqueio no GCal',
    );
    return { ok: false, error: isGcalRateLimitError(msg) ? 'rate_limit' : 'gcal_falhou' };
  }
}

async function removeOccurrence(args: {
  scope: TenantScope;
  row: agendaBloqueios.AgendaBloqueioRow;
}): Promise<RemoveOccurrenceResult> {
  const target = await resolveTarget(args.scope.slot, args.row.colaborador_id);
  if (!target) return { ok: false, error: 'gcal_nao_configurado' };

  if (args.row.gcal_event_id) {
    try {
      await target.client.deleteEvent(args.row.gcal_event_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/HTTP 404/.test(msg)) {
        if (isGcalForbiddenOrAuthError(msg)) gcal.invalidateGcalCache(args.scope.slot);
        log.error(
          {
            slot: args.scope.slot,
            bloqueioId: args.row.id,
            eventId: hashEventIdForLog(args.row.gcal_event_id),
            err: msg,
            serieId: args.row.serie_id,
          },
          'falha ao remover bloqueio no GCal',
        );
        return { ok: false, error: isGcalRateLimitError(msg) ? 'rate_limit' : 'gcal_falhou' };
      }
    }
  }

  const deleted = await agendaBloqueios.softDeleteById(
    args.scope.tenantId,
    args.scope.slot,
    args.row.id,
    args.row.colaborador_id,
  );
  if (!deleted) return { ok: false, error: 'bloqueio_nao_encontrado' };
  log.info(
    {
      slot: args.scope.slot,
      bloqueioId: deleted.id,
      colaboradorId: deleted.colaborador_id,
      eventId: deleted.gcal_event_id ? hashEventIdForLog(deleted.gcal_event_id) : undefined,
      serieId: deleted.serie_id,
    },
    'bloqueio de agenda removido',
  );
  return { ok: true, bloqueio: deleted };
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

  const created = await createOccurrence({
    scope: args.scope,
    input: args.input,
    target,
    createdByRole: args.createdByRole,
    createdByUserId: args.createdByUserId,
    createdByColaboradorId: args.createdByColaboradorId,
  });
  if (!created.ok) {
    return args.reply.code(502).send({
      error:
        created.error === 'rate_limit' ? 'gcal_rate_limit' : 'nao_foi_possivel_criar_bloqueio',
    });
  }
  return args.reply.code(201).send({ ok: true, bloqueio: created.bloqueio });
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

  const removed = await removeOccurrence({ scope: args.scope, row });
  if (!removed.ok) {
    if (removed.error === 'gcal_nao_configurado') {
      return args.reply.code(422).send({ error: 'gcal_nao_configurado' });
    }
    if (removed.error === 'bloqueio_nao_encontrado') {
      return args.reply.code(404).send({ error: 'bloqueio_nao_encontrado' });
    }
    return args.reply.code(502).send({
      error:
        removed.error === 'rate_limit' ? 'gcal_rate_limit' : 'nao_foi_possivel_remover_bloqueio',
    });
  }
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

  app.post(
    '/portal/agenda/bloqueios/recorrencia/preview',
    { preHandler: withTenant },
    async (req, reply) => {
      const { slot } = requireTenant(req);
      if (!gateEnabled(slot, reply)) return reply;
      const scope = await resolveOwnerScope(slot, reply);
      if (!scope) return reply;
      const parsed = previewRecorrenciaSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'payload_invalido' });
      const colaboradorId = parsed.data.colaborador_id ?? null;
      const target = await resolveTarget(slot, colaboradorId);
      if (!target) {
        return reply
          .code(colaboradorId == null ? 422 : 404)
          .send({ error: colaboradorId == null ? 'gcal_nao_configurado' : 'colaborador_nao_encontrado' });
      }
      let previews;
      try {
        const occurrences = expandirOcorrenciasSerie({
          inicioAt: parsed.data.inicio_at,
          fimAt: parsed.data.fim_at,
          timeZone: parsed.data.timezone || scope.timezone,
          periodicidade: parsed.data.periodicidade,
          ocorrencias: parsed.data.ocorrencias,
        });
        previews = [];
        for (const occurrence of occurrences) {
          const avaliacao = await avaliarPreviewOcorrencia({ target, occurrence });
          previews.push({
            ...occurrence,
            timezone: parsed.data.timezone || scope.timezone,
            tipo: parsed.data.tipo,
            motivo: parsed.data.motivo ?? null,
            colaborador_id: target.colaboradorId,
            status: avaliacao.status,
            ...(avaliacao.conflito ? { conflito: avaliacao.conflito } : {}),
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'erro';
        if (isGcalForbiddenOrAuthError(msg)) gcal.invalidateGcalCache(slot);
        return reply.code(/nao foi possivel formatar|nao foi possivel resolver|intervalo invalido/.test(msg) ? 400 : 502).send({
          error: /nao foi possivel formatar|nao foi possivel resolver|intervalo invalido/.test(msg)
            ? 'payload_invalido'
            : 'nao foi possivel avaliar a serie agora',
        });
      }
      return reply.code(200).send({ ok: true, previews });
    },
  );

  app.post('/portal/agenda/bloqueios/serie', { preHandler: withTenant }, async (req, reply) => {
    const { slot, userId } = requireTenant(req);
    if (!gateEnabled(slot, reply)) return reply;
    const scope = await resolveOwnerScope(slot, reply);
    if (!scope) return reply;
    const parsed = criarSerieSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'payload_invalido' });
    const colaboradorId = parsed.data.colaborador_id ?? null;
    const target = await resolveTarget(slot, colaboradorId);
    if (!target) {
      return reply
        .code(colaboradorId == null ? 422 : 404)
        .send({ error: colaboradorId == null ? 'gcal_nao_configurado' : 'colaborador_nao_encontrado' });
    }

      let ocorrenciasSerie: BloqueioSerieOccurrence[];
      try {
        ocorrenciasSerie = expandirOcorrenciasSerie({
          inicioAt: parsed.data.inicio_at,
          fimAt: parsed.data.fim_at,
          timeZone: parsed.data.timezone || scope.timezone,
          periodicidade: parsed.data.periodicidade,
          ocorrencias: parsed.data.ocorrencias,
        });
      } catch {
        return reply.code(400).send({ error: 'payload_invalido' });
      }

      const serieId = randomUUID();
      const criados: Array<{ id: string; inicio_at: string; fim_at: string }> = [];
    const falhas: Array<{
      inicio_at: string;
      fim_at: string;
      error: CreateOccurrenceError;
      reason: SerieFailureReason;
    }> = [];
      for (const ocorrencia of ocorrenciasSerie) {
        const created = await createOccurrence({
          scope,
          target,
        input: {
          inicio_at: ocorrencia.inicio_at,
          fim_at: ocorrencia.fim_at,
          timezone: parsed.data.timezone || scope.timezone,
          tipo: parsed.data.tipo,
          motivo: parsed.data.motivo ?? null,
        },
        createdByRole: 'owner',
        createdByUserId: userId,
        serieId,
      });
      if (!created.ok) {
        falhas.push({
          inicio_at: ocorrencia.inicio_at,
          fim_at: ocorrencia.fim_at,
          error: created.error,
          reason: mapCreateFailureReason(created.error),
        });
        if (created.error === 'rate_limit') break;
        continue;
      }
      criados.push({
        id: created.bloqueio.id,
        inicio_at: created.bloqueio.inicio_at,
        fim_at: created.bloqueio.fim_at,
      });
    }

    const resposta = { serie_id: serieId, criados, falhas };
    if (criados.length === 0) return reply.code(409).send({ ok: false, ...resposta });
    if (falhas.length > 0) return reply.code(207).send({ ok: true, ...resposta });
    return reply.code(201).send({ ok: true, ...resposta });
  });

  app.delete(
    '/portal/agenda/bloqueios/serie/:serieId',
    { preHandler: withTenant },
    async (req, reply) => {
      const { slot } = requireTenant(req);
      if (!gateEnabled(slot, reply)) return reply;
      const scope = await resolveOwnerScope(slot, reply);
      if (!scope) return reply;
      const parsed = serieParamsSchema.safeParse(req.params ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'serie_invalida' });
      const rows = await agendaBloqueios.listFutureActiveBySerieId({
        tenantId: scope.tenantId,
        slot,
        serieId: parsed.data.serieId,
      });
      if (rows.length === 0) return reply.code(404).send({ error: 'serie_nao_encontrada' });

      const removidos: Array<{ id: string; inicio_at: string; fim_at: string }> = [];
      const falhas: Array<{
        id: string;
        inicio_at: string;
        fim_at: string;
        error: RemoveOccurrenceError;
        reason: SerieFailureReason;
      }> = [];

      for (const row of rows) {
        const removed = await removeOccurrence({ scope, row });
        if (!removed.ok) {
          falhas.push({
            id: row.id,
            inicio_at: row.inicio_at,
            fim_at: row.fim_at,
            error: removed.error,
            reason: mapRemoveFailureReason(removed.error),
          });
          if (removed.error === 'rate_limit') break;
          continue;
        }
        removidos.push({
          id: removed.bloqueio.id,
          inicio_at: removed.bloqueio.inicio_at,
          fim_at: removed.bloqueio.fim_at,
        });
      }

      const resposta = { serie_id: parsed.data.serieId, removidos, falhas };
      if (removidos.length === 0) return reply.code(409).send({ ok: false, ...resposta });
      if (falhas.length > 0) return reply.code(207).send({ ok: true, ...resposta });
      return reply.code(200).send({ ok: true, ...resposta });
    },
  );

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

  app.post(
    '/portal/colaborador/bloqueios/recorrencia/preview',
    { preHandler: withColaborador },
    async (req, reply) => {
      const { slot, tenantId, colaboradorId } = requireColaborador(req);
      if (!gateColaboradorEnabled(slot, reply)) return reply;
      const parsed = previewRecorrenciaSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'payload_invalido' });
      const target = await resolveTarget(slot, colaboradorId);
      if (!target) return reply.code(422).send({ error: 'gcal_nao_configurado' });
      let previews;
      try {
        const occurrences = expandirOcorrenciasSerie({
          inicioAt: parsed.data.inicio_at,
          fimAt: parsed.data.fim_at,
          timeZone: parsed.data.timezone || 'America/Sao_Paulo',
          periodicidade: parsed.data.periodicidade,
          ocorrencias: parsed.data.ocorrencias,
        });
        previews = [];
        for (const occurrence of occurrences) {
          const avaliacao = await avaliarPreviewOcorrencia({ target, occurrence });
          previews.push({
            ...occurrence,
            timezone: parsed.data.timezone || 'America/Sao_Paulo',
            tipo: parsed.data.tipo,
            motivo: parsed.data.motivo ?? null,
            colaborador_id: colaboradorId,
            status: avaliacao.status,
            ...(avaliacao.conflito ? { conflito: avaliacao.conflito } : {}),
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'erro';
        if (isGcalForbiddenOrAuthError(msg)) gcal.invalidateGcalCache(slot);
        return reply.code(/nao foi possivel formatar|nao foi possivel resolver|intervalo invalido/.test(msg) ? 400 : 502).send({
          error: /nao foi possivel formatar|nao foi possivel resolver|intervalo invalido/.test(msg)
            ? 'payload_invalido'
            : 'nao foi possivel avaliar a serie agora',
        });
      }
      return reply.code(200).send({ ok: true, previews });
    },
  );

  app.post('/portal/colaborador/bloqueios/serie', { preHandler: withColaborador }, async (req, reply) => {
    const { slot, tenantId, colaboradorId } = requireColaborador(req);
    if (!gateColaboradorEnabled(slot, reply)) return reply;
    const parsed = criarSerieSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'payload_invalido' });
    const target = await resolveTarget(slot, colaboradorId);
    if (!target) return reply.code(422).send({ error: 'gcal_nao_configurado' });

      let ocorrenciasSerie: BloqueioSerieOccurrence[];
      try {
        ocorrenciasSerie = expandirOcorrenciasSerie({
          inicioAt: parsed.data.inicio_at,
          fimAt: parsed.data.fim_at,
          timeZone: parsed.data.timezone || 'America/Sao_Paulo',
          periodicidade: parsed.data.periodicidade,
          ocorrencias: parsed.data.ocorrencias,
        });
      } catch {
        return reply.code(400).send({ error: 'payload_invalido' });
      }

      const serieId = randomUUID();
      const criados: Array<{ id: string; inicio_at: string; fim_at: string }> = [];
    const falhas: Array<{
      inicio_at: string;
      fim_at: string;
      error: CreateOccurrenceError;
      reason: SerieFailureReason;
    }> = [];
      for (const ocorrencia of ocorrenciasSerie) {
        const created = await createOccurrence({
          scope: { slot, tenantId, timezone: parsed.data.timezone || 'America/Sao_Paulo' },
        target,
        input: {
          inicio_at: ocorrencia.inicio_at,
          fim_at: ocorrencia.fim_at,
          timezone: parsed.data.timezone || 'America/Sao_Paulo',
          tipo: parsed.data.tipo,
          motivo: parsed.data.motivo ?? null,
        },
        createdByRole: 'colaborador',
        createdByColaboradorId: colaboradorId,
        serieId,
      });
      if (!created.ok) {
        falhas.push({
          inicio_at: ocorrencia.inicio_at,
          fim_at: ocorrencia.fim_at,
          error: created.error,
          reason: mapCreateFailureReason(created.error),
        });
        if (created.error === 'rate_limit') break;
        continue;
      }
      criados.push({
        id: created.bloqueio.id,
        inicio_at: created.bloqueio.inicio_at,
        fim_at: created.bloqueio.fim_at,
      });
    }

    const resposta = { serie_id: serieId, criados, falhas };
    if (criados.length === 0) return reply.code(409).send({ ok: false, ...resposta });
    if (falhas.length > 0) return reply.code(207).send({ ok: true, ...resposta });
    return reply.code(201).send({ ok: true, ...resposta });
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

  app.delete(
    '/portal/colaborador/bloqueios/serie/:serieId',
    { preHandler: withColaborador },
    async (req, reply) => {
      const { slot, tenantId, colaboradorId } = requireColaborador(req);
      if (!gateColaboradorEnabled(slot, reply)) return reply;
      const parsed = serieParamsSchema.safeParse(req.params ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'serie_invalida' });
      const rows = await agendaBloqueios.listFutureActiveBySerieId({
        tenantId,
        slot,
        serieId: parsed.data.serieId,
        colaboradorId,
      });
      if (rows.length === 0) return reply.code(404).send({ error: 'serie_nao_encontrada' });

      const removidos: Array<{ id: string; inicio_at: string; fim_at: string }> = [];
      const falhas: Array<{
        id: string;
        inicio_at: string;
        fim_at: string;
        error: RemoveOccurrenceError;
        reason: SerieFailureReason;
      }> = [];
      for (const row of rows) {
        const removed = await removeOccurrence({
          scope: { slot, tenantId, timezone: 'America/Sao_Paulo' },
          row,
        });
        if (!removed.ok) {
          falhas.push({
            id: row.id,
            inicio_at: row.inicio_at,
            fim_at: row.fim_at,
            error: removed.error,
            reason: mapRemoveFailureReason(removed.error),
          });
          if (removed.error === 'rate_limit') break;
          continue;
        }
        removidos.push({
          id: removed.bloqueio.id,
          inicio_at: removed.bloqueio.inicio_at,
          fim_at: removed.bloqueio.fim_at,
        });
      }

      const resposta = { serie_id: parsed.data.serieId, removidos, falhas };
      if (removidos.length === 0) return reply.code(409).send({ ok: false, ...resposta });
      if (falhas.length > 0) return reply.code(207).send({ ok: true, ...resposta });
      return reply.code(200).send({ ok: true, ...resposta });
    },
  );
};
