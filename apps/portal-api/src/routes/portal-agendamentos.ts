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
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
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
};
