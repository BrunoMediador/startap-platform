/**
 * GET /portal/agendamentos — eventos do Google Calendar do clone numa janela ampla.
 *
 * Janela: timeMin = agora - 7 dias, timeMax = agora + 14 dias.
 * Por que -7/+14 (e nao so futuro): barbearia agenda majoritariamente pra HOJE/amanha
 * e raramente pro futuro. Janela so-futuro deixava a home do portal sempre vazia
 * (ex.: Cirilo tinha 38 eventos nos ultimos 30d e 0 nos proximos 14d). Mostrando
 * recentes + proximos, o frontend agrupa em Hoje / Proximos / Recentes.
 * Parametrizavel: ?past= (default 7, max 30) e ?ahead= (default 14, max 60).
 *
 * Reusa packages/integrations/google-calendar:
 *   getGcalForSlot(slot) -> GoogleCalendarClient (ou null se GCal nao configurado),
 *   listEvents({ timeMin, timeMax }).
 * Escopado por request.tenant.slot. getGcalForSlot para clones (slot 'clone_*')
 * faz lookup EXCLUSIVO em flow_clones — sem fallback para a matriz (isolamento).
 *
 * Se o clone nao tem GCal configurado, retorna lista vazia + gcal_configured=false
 * (estado esperado para clones em pre-setup) — nao e erro.
 *
 * DTO whitelist (parecer-001): apenas id, titulo, inicio, fim. NAO expor
 * telefone/descricao/summary cru alem do titulo.
 */
import { logger } from '@startap/core/logger';
import { gcal } from '@startap/integrations';
import {
  TZ,
  hhmmToMins,
  loadScheduleConfig,
  nowPartsInTz,
  weekdayOfDateKey,
  zonedWallTimeToUtc,
} from '@startap/integrations/scheduling';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { maskPhone } from '../lib/mask.js';
import { requireTenant, withTenant } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'agendamentos' });

const DEFAULT_PAST = 7;
const DEFAULT_AHEAD = 14;
const MAX_EVENTS = 50;

const pastDaysQuery = z.coerce.number().int().min(0).max(30).default(DEFAULT_PAST);
const aheadDaysQuery = z.coerce.number().int().min(1).max(60).default(DEFAULT_AHEAD);

interface AgendamentoOut {
  id: string;
  titulo: string;
  inicio: string | null;
  fim: string | null;
}

// ---- POST /portal/agendamentos (Missão 020 F4 — agendamento manual) --------
//
// O dono marca um horário pra um cliente final sem passar pelo robô. O evento
// nasce na MESMA agenda GCal do tenant, com o MESMO formato de título que o
// bot usa ("Nome - Servico | WhatsApp: numero") — a lista da Início e o
// consultar_agendamento do bot enxergam igual.
//
// Anti-corrida: recheca disponibilidade contra o GCal na hora do POST (mesma
// verificação server-side do inserir_agendamento do bot). Conflito → 409
// estruturado; o front recarrega a grade.

/** Piso pra HOJE: não aceitar slot que começa em menos de 10min (regra do bot). */
const POST_TODAY_FLOOR_MIN = 10;
/** Mesmo limite do GET /portal/agenda/slots. */
const POST_MAX_AHEAD_DAYS = 60;

const telefoneSchema = z
  .string()
  .transform((v) => v.replace(/\D/g, ''))
  .refine((v) => v.length >= 10 && v.length <= 15, {
    message: 'telefone deve ter 10-15 digitos (DDI+DDD+numero)',
  });

const criarAgendamentoSchema = z.object({
  servico: z.string().trim().min(1, 'servico obrigatorio').max(80),
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data deve ser YYYY-MM-DD'),
  hora: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'hora deve ser HH:mm'),
  cliente_nome: z.string().trim().min(1, 'nome do cliente obrigatorio').max(80),
  // '' e null contam como "sem telefone" (campo opcional no form).
  cliente_telefone: z.preprocess(
    (v) => (v == null || v === '' ? undefined : v),
    telefoneSchema.optional(),
  ),
});

export const portalAgendamentosRoutes: FastifyPluginAsync = async (app) => {
  app.get('/portal/agendamentos', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);

    const client = await gcal.getGcalForSlot(slot);
    if (!client) {
      // Clone sem GCal proprio (pre-setup ou nao configurado) — vazio, sem erro.
      return reply.code(200).send({ gcal_configured: false, count: 0, agendamentos: [] });
    }

    const query = req.query as { past?: unknown; ahead?: unknown };
    const pastParsed = pastDaysQuery.safeParse(query?.past);
    const aheadParsed = aheadDaysQuery.safeParse(query?.ahead);
    const pastDays = pastParsed.success ? pastParsed.data : DEFAULT_PAST;
    const aheadDays = aheadParsed.success ? aheadParsed.data : DEFAULT_AHEAD;

    const now = new Date();
    const timeMin = new Date(now.getTime() - pastDays * 86_400_000).toISOString();
    const timeMax = new Date(now.getTime() + aheadDays * 86_400_000).toISOString();

    try {
      const events = await client.listEvents({ timeMin, timeMax });
      const agendamentos: AgendamentoOut[] = events
        .map((e) => ({
          id: e.id,
          titulo: e.summary ?? '(sem titulo)',
          inicio: e.start?.dateTime ?? e.start?.date ?? null,
          fim: e.end?.dateTime ?? e.end?.date ?? null,
        }))
        // Ordena por inicio ASC; eventos sem inicio (null) vao pro fim.
        .sort((a, b) => (a.inicio ?? '￿').localeCompare(b.inicio ?? '￿'))
        // Cap defensivo: janela e pequena, mas evita resposta gigante.
        .slice(0, MAX_EVENTS);
      return reply
        .code(200)
        .send({ gcal_configured: true, count: agendamentos.length, agendamentos });
    } catch (err) {
      log.error({ slot, err: err instanceof Error ? err.message : 'erro' }, 'falha ao listar GCal');
      return reply.code(502).send({ error: 'nao foi possivel buscar agendamentos agora' });
    }
  });

  app.post('/portal/agendamentos', { preHandler: withTenant }, async (req, reply) => {
    const { slot, userId } = requireTenant(req);

    const parsed = criarAgendamentoSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'payload_invalido',
        detalhe: parsed.error.issues[0]?.message ?? 'payload invalido',
      });
    }
    const { servico, data, hora, cliente_nome, cliente_telefone } = parsed.data;

    // Config do tenant (horários + serviços) — mesma fonte que o bot e o GET /slots.
    let config: Awaited<ReturnType<typeof loadScheduleConfig>>;
    try {
      config = await loadScheduleConfig(slot);
    } catch (err) {
      log.warn(
        { slot, err: err instanceof Error ? err.message : 'erro' },
        'agendamento manual: horarios/servicos nao configurados',
      );
      return reply.code(422).send({ error: 'config_ausente' });
    }

    const svc = config.services.find((s) => s.name.toLowerCase() === servico.toLowerCase());
    if (!svc) {
      return reply.code(400).send({ error: 'servico_nao_encontrado' });
    }

    const wd = weekdayOfDateKey(data);
    if (wd === null) {
      return reply.code(400).send({ error: 'payload_invalido', detalhe: 'data inexistente' });
    }

    // Janela de aceitação: hoje..+60d (mesma do GET /slots).
    const agora = nowPartsInTz();
    const limite = nowPartsInTz(new Date(Date.now() + POST_MAX_AHEAD_DAYS * 86_400_000));
    if (data > limite.dateKey) {
      return reply.code(400).send({ error: 'data_fora_da_janela', max_dias: POST_MAX_AHEAD_DAYS });
    }

    const startMins = hhmmToMins(hora);
    const endMins = startMins + svc.min;

    // Slot no passado (ou perto demais do relógio) → tratado como conflito:
    // o front recarrega a grade e o horário some sozinho.
    if (
      data < agora.dateKey ||
      (data === agora.dateKey && startMins < agora.mins + POST_TODAY_FLOOR_MIN)
    ) {
      return reply.code(409).send({ error: 'conflito', reason: 'horario_passado' });
    }

    // Dentro do horário de funcionamento do dia (pode ter mudado entre a grade
    // e o submit) — fora → conflito, front recarrega.
    const janela = config.work[wd];
    if (!janela || startMins < janela[0] || endMins > janela[1]) {
      return reply.code(409).send({ error: 'conflito', reason: 'fora_do_horario' });
    }

    const client = await gcal.getGcalForSlot(slot);
    if (!client) {
      return reply.code(422).send({ error: 'gcal_nao_configurado' });
    }

    const startUtc = zonedWallTimeToUtc(data, startMins);
    const endUtc = zonedWallTimeToUtc(data, endMins);

    try {
      // Double-check anti-corrida: recheca contra o GCal AGORA (mesma regra
      // server-side do inserir_agendamento do bot — o GCal é a fonte de verdade).
      const existing = await client.listEvents({
        timeMin: startUtc.toISOString(),
        timeMax: endUtc.toISOString(),
      });
      const conflito = existing.find((ev) => {
        const evStart = new Date(ev.start.dateTime ?? `${ev.start.date}T00:00:00`).getTime();
        const evEnd = new Date(ev.end.dateTime ?? `${ev.end.date}T00:00:00`).getTime();
        return evStart < endUtc.getTime() && evEnd > startUtc.getTime();
      });
      if (conflito) {
        log.warn(
          { slot, userId, servico: svc.name, data, hora },
          'agendamento manual bloqueado: slot ocupado entre a grade e o submit',
        );
        return reply.code(409).send({
          error: 'conflito',
          reason: 'ocupado',
          conflito: {
            inicio: conflito.start.dateTime ?? conflito.start.date ?? null,
            fim: conflito.end.dateTime ?? conflito.end.date ?? null,
          },
        });
      }

      // MESMO formato de título do bot ("Nome - Servico | WhatsApp: numero") —
      // a lista da Início e o consultar_agendamento do bot enxergam igual.
      const summary = cliente_telefone
        ? `${cliente_nome} - ${svc.name} | WhatsApp: ${cliente_telefone}`
        : `${cliente_nome} - ${svc.name}`;

      const ev = await client.createEvent({
        summary,
        startISO: startUtc.toISOString(),
        endISO: endUtc.toISOString(),
        timeZone: TZ,
      });

      log.info(
        {
          slot,
          userId,
          eventId: ev.id,
          servico: svc.name,
          data,
          hora,
          phone: cliente_telefone ? maskPhone(cliente_telefone) : undefined,
        },
        'agendamento manual criado via portal',
      );

      const agendamento: AgendamentoOut = {
        id: ev.id,
        titulo: ev.summary ?? summary,
        inicio: ev.start?.dateTime ?? ev.start?.date ?? startUtc.toISOString(),
        fim: ev.end?.dateTime ?? ev.end?.date ?? endUtc.toISOString(),
      };
      return reply.code(201).send({ ok: true, agendamento });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'erro';
      if (/40[13]/.test(msg)) gcal.invalidateGcalCache(slot);
      log.error({ slot, userId, err: msg }, 'agendamento manual: falha no GCal');
      return reply.code(502).send({ error: 'nao foi possivel criar o agendamento agora' });
    }
  });
};
