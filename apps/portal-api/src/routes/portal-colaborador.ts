/**
 * Painel do COLABORADOR (barbeiro de estabelecimento) — visão READ-ONLY e ESCOPADA
 * (SCRUM-32). O colaborador loga no portal com username (nome) + senha gerada pelo dono
 * no gestão e vê SÓ os dados DELE: a agenda dele e a comissão/faturamento dele.
 *
 * ISOLAMENTO / ANTI-IDOR (regra de ouro 5): TODA query escopa por (slot + tenant_id +
 * colaborador_id) vindos da SESSÃO (withColaborador) — NUNCA de body/query/params. É
 * IMPOSSÍVEL um colaborador pedir dados de outro: não há campo de id no request; a
 * identidade é a credencial. Trocar id no request não muda nada (não existe esse id).
 *   - AGENDA: resolve a agenda DELE em getGcalsForSlot(slot) (lista já escopada por
 *     slot+tenant na integração, ADR 0024 §4) e filtra ao colaboradorId DA SESSÃO. A
 *     agenda de outro colaborador NUNCA é listada.
 *   - COMISSÃO/FATURAMENTO: getComissaoColaborador escopa por cc.id = colaboradorId DA
 *     SESSÃO; outro colaborador/tenant não casa o WHERE -> 404 (não vaza existência).
 *
 * READ-ONLY: só GET. Nenhuma escrita (sem criar/editar/cancelar agendamento, sem editar
 * atendimento, sem billing). A visão do DONO (todos os colaboradores) vive em rotas que
 * passam por withTenant — barradas a colaborador no chokepoint (403).
 *
 * GATING: flag COLABORADOR_PORTAL_ENABLED OFF -> TODAS as rotas respondem 404 (feature
 * dormente; não vaza). Defesa em profundidade — o acesso real ainda exige credencial
 * gerada (só estabelecimento) + colaborador ativo (withColaborador recheca no banco).
 */
import { logger } from '@startap/core/logger';
import { atendimentos } from '@startap/db';
import { gcal } from '@startap/integrations';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { requireColaborador, withColaborador } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'colaborador' });

/** Janela da agenda do colaborador: passado recente + próximos (mesma do dono). */
const DEFAULT_PAST = 7;
const DEFAULT_AHEAD = 14;
const MAX_EVENTS = 100;

const pastDaysQuery = z.coerce.number().int().min(0).max(30).default(DEFAULT_PAST);
const aheadDaysQuery = z.coerce.number().int().min(1).max(60).default(DEFAULT_AHEAD);

// Período do relatório de comissão/faturamento: [de, ate], ambos YYYY-MM-DD.
const periodoSchema = z.object({
  de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'de deve ser YYYY-MM-DD'),
  ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ate deve ser YYYY-MM-DD'),
});

interface AgendaItemOut {
  id: string;
  titulo: string;
  inicio: string | null;
  fim: string | null;
}

/** Gate da feature: 404 quando OFF (não vaza). Retorna true se pode seguir. */
function gateEnabled(reply: FastifyReply): boolean {
  if (!config.COLABORADOR_PORTAL_ENABLED) {
    reply.code(404).send({ error: 'recurso indisponivel' });
    return false;
  }
  return true;
}

export const portalColaboradorRoutes: FastifyPluginAsync = async (app) => {
  // GET /portal/colaborador/agenda?past=&ahead= — SÓ os agendamentos da agenda DELE
  // (read-only). Vive sob /portal/* (namespace PROXIADO pelo portal-web): o caminho antigo
  // /colaborador/* colidia com as PÁGINAS Next e nunca chegava aqui (agenda sempre vazia).
  app.get('/portal/colaborador/agenda', { preHandler: withColaborador }, async (req, reply) => {
    if (!gateEnabled(reply)) return reply;
    const { slot, colaboradorId } = requireColaborador(req);

    const q = req.query as { past?: unknown; ahead?: unknown };
    const pastDays = pastDaysQuery.safeParse(q?.past).success
      ? pastDaysQuery.parse(q?.past)
      : DEFAULT_PAST;
    const aheadDays = aheadDaysQuery.safeParse(q?.ahead).success
      ? aheadDaysQuery.parse(q?.ahead)
      : DEFAULT_AHEAD;

    const now = new Date();
    const timeMin = new Date(now.getTime() - pastDays * 86_400_000).toISOString();
    const timeMax = new Date(now.getTime() + aheadDays * 86_400_000).toISOString();

    // Resolve a agenda DESTE colaborador. getGcalsForSlot é escopado por slot+tenant na
    // integração (ADR 0024 §4); filtramos ao colaboradorId DA SESSÃO. Nenhuma outra
    // agenda do estabelecimento é tocada.
    let colaboradores: Awaited<ReturnType<typeof gcal.getGcalsForSlot>>;
    try {
      colaboradores = await gcal.getGcalsForSlot(slot);
    } catch (err) {
      log.error(
        { slot, colaboradorId, err: err instanceof Error ? err.message : 'erro' },
        'colaborador/agenda: falha ao resolver agendas do clone',
      );
      return reply.code(502).send({ error: 'nao foi possivel buscar a agenda agora' });
    }

    const alvo = colaboradores.find((c) => c.colaboradorId === colaboradorId);
    if (!alvo) {
      // Sem agenda ativa pra este colaborador (pré-setup / agenda não conectada).
      // Estado esperado, não erro: lista vazia + flag.
      return reply.code(200).send({ gcal_configured: false, count: 0, agendamentos: [] });
    }

    try {
      const events = await alvo.client.listEvents({ timeMin, timeMax });
      const agendamentos: AgendaItemOut[] = events
        .map((e) => ({
          id: e.id,
          // DTO whitelist (mesma do dono): só id/titulo/inicio/fim. Nada de PII extra.
          titulo: e.summary ?? '(sem titulo)',
          inicio: e.start?.dateTime ?? e.start?.date ?? null,
          fim: e.end?.dateTime ?? e.end?.date ?? null,
        }))
        .sort((a, b) => (a.inicio ?? '￿').localeCompare(b.inicio ?? '￿'))
        .slice(0, MAX_EVENTS);
      return reply
        .code(200)
        .send({ gcal_configured: true, count: agendamentos.length, agendamentos });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'erro';
      if (/40[13]/.test(msg)) gcal.invalidateGcalCache(slot);
      log.error({ slot, colaboradorId, err: msg }, 'colaborador/agenda: falha no GCal');
      return reply.code(502).send({ error: 'nao foi possivel buscar a agenda agora' });
    }
  });

  // GET /portal/colaborador/comissao?de=&ate= — FATURAMENTO (bruto dele) + PREVISÃO +
  // COMISSÃO (o que ELE ganha), nos dois baldes. Escopado ao colaborador DA SESSÃO
  // (read-only). Sob /portal/* pelo mesmo motivo de roteamento da agenda (acima).
  app.get('/portal/colaborador/comissao', { preHandler: withColaborador }, async (req, reply) => {
    if (!gateEnabled(reply)) return reply;
    const { slot, tenantId, colaboradorId, nome } = requireColaborador(req);

    const parsed = periodoSchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'periodo invalido',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const { de, ate } = parsed.data;

    // Dois baldes: faturado (realizado/passado) + previsão (agendado/futuro). AMBOS
    // escopados a cc.id = colaboradorId DA SESSÃO (anti-IDOR no SQL).
    const [faturado, previsao] = await Promise.all([
      atendimentos.getComissaoColaborador(slot, tenantId, colaboradorId, de, ate, 'faturado'),
      atendimentos.getComissaoColaborador(slot, tenantId, colaboradorId, de, ate, 'previsao'),
    ]);

    // null = colaborador não casou o escopo (inativo/inconsistente). Devolve zeros com a
    // identidade da sessão — nunca dado de outro colaborador.
    const zero = (balde: 'faturado' | 'previsao') => ({
      total_bruto_cents: 0,
      comissao_pct: faturado?.comissao_pct ?? previsao?.comissao_pct ?? 0,
      comissao_cents: 0,
      count: 0,
      balde,
    });

    return reply.code(200).send({
      de,
      ate,
      colaborador_id: colaboradorId,
      profissional_nome: faturado?.profissional_nome ?? previsao?.profissional_nome ?? nome,
      faturado: faturado
        ? {
            total_bruto_cents: faturado.total_bruto_cents,
            comissao_pct: faturado.comissao_pct,
            comissao_cents: faturado.comissao_cents,
            count: faturado.count,
            balde: 'faturado' as const,
          }
        : zero('faturado'),
      previsao: previsao
        ? {
            total_bruto_cents: previsao.total_bruto_cents,
            comissao_pct: previsao.comissao_pct,
            comissao_cents: previsao.comissao_cents,
            count: previsao.count,
            balde: 'previsao' as const,
          }
        : zero('previsao'),
    });
  });
};
