/**
 * Rotas de home/status do portal. Tudo escopado por request.tenant.slot.
 *
 * GET /portal/contatos — contatos recentes da sessao WAHA do cliente (dropdown
 *   de pausas). Session resolvida do clone do tenant — nunca de input.
 * GET /portal/status   — status WAHA, contagem de pausas ativas, billing
 *   (next_due_date / dias restantes / status).
 */
import { logger } from '@startap/core/logger';
import { clientBilling, flowClones, portalConfig } from '@startap/db';
import { waha } from '@startap/integrations';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireTenant, withTenant } from '../lib/tenant.js';
import { getRecentContacts } from '../lib/waha-contacts.js';

const log = logger.child({ service: 'portal-api', module: 'status' });

const daysQuery = z.coerce.number().int().min(1).max(30).default(7);

export const portalStatusRoutes: FastifyPluginAsync = async (app) => {
  app.get('/portal/contatos', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
    const clone = await flowClones.getCloneBySlot(slot);
    const session = clone?.waha_sessao ?? null;
    if (!session) {
      // Sem sessao WAHA vinculada (clone em pre-setup) — lista vazia, nao e erro.
      return reply.code(200).send({ session: null, count: 0, contacts: [] });
    }

    const parsed = daysQuery.safeParse((req.query as { days?: unknown })?.days);
    const days = parsed.success ? parsed.data : 7;

    try {
      const { contacts, source } = await getRecentContacts(session, days);
      return reply.code(200).send({ session, days, count: contacts.length, contacts, source });
    } catch (err) {
      log.error({ slot, err: err instanceof Error ? err.message : 'erro' }, 'falha contatos');
      return reply.code(502).send({ error: 'nao foi possivel buscar contatos agora' });
    }
  });

  app.get('/portal/status', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
    const clone = await flowClones.getCloneBySlot(slot);
    if (!clone) return reply.code(404).send({ error: 'fluxo nao encontrado' });

    const session = clone.waha_sessao;

    // Status WAHA — graceful: se falhar, retorna 'unknown' sem derrubar a home.
    let wahaStatus = 'unknown';
    if (session) {
      try {
        const s = await waha.sessions.getSessionStatus(session);
        wahaStatus = s.status ?? 'unknown';
      } catch (err) {
        log.info(
          { slot, err: err instanceof Error ? err.message : 'erro' },
          'WAHA status indisponivel',
        );
      }
    }

    const [pausasAtivas, billing] = await Promise.all([
      portalConfig.countPausasAtivasBySlot(slot),
      clientBilling.getBillingBySlot(slot),
    ]);

    return reply.code(200).send({
      slot,
      display_name: clone.display_name,
      // Fuso (IANA) do clone (migration 068) — o frontend usa pra rotular horários no
      // relógio da barbearia. Default 'America/Sao_Paulo' (clone sem fuso declarado).
      timezone: clone.timezone,
      flow_enabled: clone.flow_enabled,
      // PORQUÊ da pausa (∈ billing|owner_request|manual_other|abuse|null). A Home
      // usa isto pra NÃO confundir pausa do dono (owner_request) com inadimplência:
      // só mostra "regularize a mensalidade" quando é cobrança de verdade.
      suspended_kind: clone.suspended_kind,
      waha: { session, status: wahaStatus },
      pausas_ativas: pausasAtivas,
      billing: billing
        ? {
            next_due_date: billing.next_due_date,
            dias_restantes: clientBilling.daysUntilDue(billing.next_due_date),
            status: billing.status,
          }
        : null,
    });
  });
};
