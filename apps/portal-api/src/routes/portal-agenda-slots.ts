/**
 * GET /portal/agenda/slots — grade de horários LIVRES de um dia pra um serviço
 * (Missão 020 F4: agendamento manual pelo painel).
 *
 * Query: ?data=YYYY-MM-DD&servico=<nome do serviço cadastrado>
 *
 * A duração do serviço (sempre múltiplo de 5 — PR #266) define o passo da
 * grade. O cálculo é o MESMO que o bot usa (computeFreeSlotsForDay, extraído
 * de free-slots): horário de funcionamento do tenant − eventos do GCal −
 * passado (piso de 10min pra hoje). Só horários livres saem na resposta —
 * ocupado nem aparece (decisão de UX, doc 020 B3).
 *
 * Escopado por request.tenant.slot (withTenant) — cliente A jamais enxerga
 * slots/serviços do cliente B. GCal resolvido por getGcalForSlot (per-clone,
 * sem fallback pra matriz em clones).
 *
 * Respostas:
 *   200 { gcal_configured, data, servico, aberto, count, slots, grupos }
 *   400 parametros invalidos / servico nao cadastrado / data fora da janela
 *   422 horarios/servicos do fluxo nao configurados (config_ausente)
 *   502 falha ao consultar o GCal
 */
import { logger } from '@startap/core/logger';
import { gcal } from '@startap/integrations';
import {
  computeFreeSlotsForDay,
  hhmmToMins,
  loadScheduleConfig,
  nowPartsInTz,
  weekdayOfDateKey,
  zonedWallTimeToUtc,
} from '@startap/integrations/scheduling';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireTenant, withTenant } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'agenda-slots' });

/** Janela máxima de consulta: hoje até +60 dias (DayStrip do front usa 14). */
const MAX_AHEAD_DAYS = 60;

const querySchema = z.object({
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data deve ser YYYY-MM-DD'),
  servico: z.string().trim().min(1, 'servico obrigatorio').max(80),
});

/** Agrupa slots 'HH:mm' em manhã (<12h), tarde (12h–17h59) e noite (>=18h). */
export function groupSlots(slots: string[]): {
  manha: string[];
  tarde: string[];
  noite: string[];
} {
  const grupos = { manha: [] as string[], tarde: [] as string[], noite: [] as string[] };
  for (const s of slots) {
    const mins = hhmmToMins(s);
    if (mins < 12 * 60) grupos.manha.push(s);
    else if (mins < 18 * 60) grupos.tarde.push(s);
    else grupos.noite.push(s);
  }
  return grupos;
}

export const portalAgendaSlotsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/portal/agenda/slots', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);

    const parsed = querySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'parametros_invalidos',
        detalhe: parsed.error.issues[0]?.message ?? 'query invalida',
      });
    }
    const { data, servico } = parsed.data;

    // Janela: nada no passado (calendário de SP), nada além de +60 dias.
    const hoje = nowPartsInTz();
    if (data < hoje.dateKey) {
      return reply.code(400).send({ error: 'data_no_passado' });
    }
    const limite = nowPartsInTz(new Date(Date.now() + MAX_AHEAD_DAYS * 86_400_000));
    if (data > limite.dateKey) {
      return reply.code(400).send({ error: 'data_fora_da_janela', max_dias: MAX_AHEAD_DAYS });
    }

    // Config do tenant (horários + serviços) — mesma fonte do bot.
    let config: Awaited<ReturnType<typeof loadScheduleConfig>>;
    try {
      config = await loadScheduleConfig(slot);
    } catch (err) {
      log.warn(
        { slot, err: err instanceof Error ? err.message : 'erro' },
        'slots: horarios/servicos nao configurados',
      );
      return reply.code(422).send({ error: 'config_ausente' });
    }

    const svc = config.services.find((s) => s.name.toLowerCase() === servico.toLowerCase());
    if (!svc) {
      return reply.code(400).send({ error: 'servico_nao_encontrado' });
    }

    const servicoOut = { nome: svc.name, duracao_min: svc.min };
    const vazio = { count: 0, slots: [], grupos: { manha: [], tarde: [], noite: [] } };

    const wd = weekdayOfDateKey(data);
    if (wd === null) {
      return reply.code(400).send({ error: 'parametros_invalidos', detalhe: 'data inexistente' });
    }
    const aberto = config.work[wd] != null;

    const client = await gcal.getGcalForSlot(slot);
    if (!client) {
      // Agenda não conectada — estado esperado (pré-setup), não é erro.
      return reply
        .code(200)
        .send({ gcal_configured: false, data, servico: servicoOut, aberto, ...vazio });
    }

    if (!aberto) {
      // Dia fechado — nem consulta o GCal.
      return reply
        .code(200)
        .send({ gcal_configured: true, data, servico: servicoOut, aberto: false, ...vazio });
    }

    try {
      // Janela exata do dia em SP (00:00 → 24:00 hora de parede).
      const timeMin = zonedWallTimeToUtc(data, 0).toISOString();
      const timeMax = zonedWallTimeToUtc(data, 24 * 60).toISOString();
      const events = await client.listEvents({ timeMin, timeMax });

      const slots = computeFreeSlotsForDay(events, config.work, {
        dateKey: data,
        durationMin: svc.min,
      });

      return reply.code(200).send({
        gcal_configured: true,
        data,
        servico: servicoOut,
        aberto: true,
        count: slots.length,
        slots,
        grupos: groupSlots(slots),
      });
    } catch (err) {
      log.error(
        { slot, err: err instanceof Error ? err.message : 'erro' },
        'slots: falha ao consultar GCal',
      );
      return reply.code(502).send({ error: 'nao foi possivel consultar a agenda agora' });
    }
  });
};
