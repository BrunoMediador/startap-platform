/**
 * GET /portal/agendamentos — proximos eventos do Google Calendar do clone.
 *
 * Reusa packages/integrations/google-calendar:
 *   getGcalForSlot(slot) -> GoogleCalendarClient (ou null se GCal nao configurado),
 *   listEvents({ timeMin, timeMax }).
 * Escopado por request.tenant.slot. getGcalForSlot para clones (slot 'clone_*')
 * faz lookup EXCLUSIVO em flow_clones — sem fallback para a matriz (isolamento).
 *
 * Se o clone nao tem GCal configurado, retorna lista vazia + gcal_configured=false
 * (estado esperado para clones em pre-setup) — nao e erro.
 */
import { logger } from '@startap/core/logger';
import { gcal } from '@startap/integrations';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireTenant, withTenant } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'agendamentos' });

const daysAheadQuery = z.coerce.number().int().min(1).max(60).default(14);

interface AgendamentoOut {
  id: string;
  titulo: string;
  inicio: string | null;
  fim: string | null;
}

export const portalAgendamentosRoutes: FastifyPluginAsync = async (app) => {
  app.get('/portal/agendamentos', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);

    const client = await gcal.getGcalForSlot(slot);
    if (!client) {
      // Clone sem GCal proprio (pre-setup ou nao configurado) — vazio, sem erro.
      return reply.code(200).send({ gcal_configured: false, count: 0, agendamentos: [] });
    }

    const parsed = daysAheadQuery.safeParse((req.query as { days?: unknown })?.days);
    const daysAhead = parsed.success ? parsed.data : 14;

    const now = new Date();
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + daysAhead * 86_400_000).toISOString();

    try {
      const events = await client.listEvents({ timeMin, timeMax });
      const agendamentos: AgendamentoOut[] = events.map((e) => ({
        id: e.id,
        titulo: e.summary ?? '(sem titulo)',
        inicio: e.start?.dateTime ?? e.start?.date ?? null,
        fim: e.end?.dateTime ?? e.end?.date ?? null,
      }));
      return reply
        .code(200)
        .send({ gcal_configured: true, count: agendamentos.length, agendamentos });
    } catch (err) {
      log.error({ slot, err: err instanceof Error ? err.message : 'erro' }, 'falha ao listar GCal');
      return reply.code(502).send({ error: 'nao foi possivel buscar agendamentos agora' });
    }
  });
};
