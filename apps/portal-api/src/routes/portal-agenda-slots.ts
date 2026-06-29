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
import { isEstabelecimentoSlot } from './portal-agendamentos.js';

const log = logger.child({ service: 'portal-api', module: 'agenda-slots' });

/** Janela máxima de consulta: hoje até +60 dias (DayStrip do front usa 14). */
const MAX_AHEAD_DAYS = 60;

const querySchema = z.object({
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data deve ser YYYY-MM-DD'),
  servico: z.string().trim().min(1, 'servico obrigatorio').max(80),
  // ESTABELECIMENTO (multi-profissional): qual colaborador/agenda a grade consulta.
  // É clone_colaboradores.id (numérico). OPCIONAL no schema porque o INDIVIDUAL não
  // usa (single-agenda) — a obrigatoriedade no estabelecimento é validada no handler
  // (422 'colaborador_obrigatorio', igual ao POST). '' / null => undefined.
  colaborador_id: z.preprocess(
    (v) => (v == null || v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
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
    const { data, servico, colaborador_id } = parsed.data;

    // Config do tenant (horários + serviços) — mesma fonte do bot. Carregada ANTES da
    // checagem de janela porque "passado/futuro" precisa do FUSO do clone (migration 068).
    // REORDENADO: o window-check usava nowPartsInTz() (SP fixo) antes do load; agora usa
    // config.timezone. Para clone SP é byte-idêntico ao comportamento de hoje.
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

    // Fuso do clone (default SP) — relógio da barbearia. Clone SP = byte-idêntico.
    const tz = config.timezone;

    // Janela: nada no passado (calendário do clone), nada além de +60 dias.
    const hoje = nowPartsInTz(new Date(), tz);
    if (data < hoje.dateKey) {
      return reply.code(400).send({ error: 'data_no_passado' });
    }
    const limite = nowPartsInTz(new Date(Date.now() + MAX_AHEAD_DAYS * 86_400_000), tz);
    if (data > limite.dateKey) {
      return reply.code(400).send({ error: 'data_fora_da_janela', max_dias: MAX_AHEAD_DAYS });
    }

    const svc = config.services.find((s) => s.name.toLowerCase() === servico.toLowerCase());
    if (!svc) {
      return reply.code(400).send({ error: 'servico_nao_encontrado' });
    }

    const servicoOut = { nome: svc.name, duracao_min: svc.min };
    const vazio = { count: 0, slots: [], grupos: { manha: [], tarde: [], noite: [] } };

    const wd = weekdayOfDateKey(data, tz);
    if (wd === null) {
      return reply.code(400).send({ error: 'parametros_invalidos', detalhe: 'data inexistente' });
    }
    const aberto = config.work[wd] != null;

    // ── Resolução da agenda que alimenta a grade (individual + estabelecimento) ──
    // INDIVIDUAL: agenda única do clone (getGcalForSlot) — singular, inalterado.
    // ESTABELECIMENTO: o clone NÃO tem agenda própria — os eventos vivem nas agendas
    // dos colaboradores. A grade tem que olhar a agenda DAQUELE colaborador, senão
    // getGcalForSlot devolve vazio → gcal_configured:false em todo dia (o front troca
    // o form por "conecte sua agenda" e o remarcar mostra "dia cheio"). Espelha o
    // gating do POST (#347/#359): exige colaborador_id (422 se faltar) e resolve a
    // agenda dele contra getGcalsForSlot — lista já escopada por slot+tenant na
    // integração (ADR 0024 §4), então colaborador alheio cai no 404 (anti-IDOR).
    let client: NonNullable<Awaited<ReturnType<typeof gcal.getGcalForSlot>>>;

    if (await isEstabelecimentoSlot(slot)) {
      // Estabelecimento exige escolher o profissional (qual agenda a grade consulta).
      if (colaborador_id === undefined) {
        return reply.code(422).send({ error: 'colaborador_obrigatorio' });
      }
      const colaboradores = await gcal.getGcalsForSlot(slot);
      if (colaboradores.length === 0) {
        // Nenhum colaborador com agenda ativa (pré-setup) — estado esperado, não erro.
        return reply
          .code(200)
          .send({ gcal_configured: false, data, servico: servicoOut, aberto, ...vazio });
      }
      const alvo = colaboradores.find((c) => c.colaboradorId === colaborador_id);
      if (!alvo) {
        // colaborador_id não pertence a ESTE slot/tenant (ou sem agenda ativa).
        // Anti-IDOR: a lista só contém colaboradores deste tenant — alheio cai aqui.
        log.warn(
          { slot, colaboradorId: colaborador_id },
          'slots: colaborador fora do tenant ou sem agenda ativa',
        );
        return reply.code(404).send({ error: 'colaborador_nao_encontrado' });
      }
      client = alvo.client;
    } else {
      const single = await gcal.getGcalForSlot(slot);
      if (!single) {
        // Agenda não conectada — estado esperado (pré-setup), não é erro.
        return reply
          .code(200)
          .send({ gcal_configured: false, data, servico: servicoOut, aberto, ...vazio });
      }
      client = single;
    }

    if (!aberto) {
      // Dia fechado — nem consulta o GCal.
      return reply
        .code(200)
        .send({ gcal_configured: true, data, servico: servicoOut, aberto: false, ...vazio });
    }

    try {
      // Janela exata do dia no fuso do clone (00:00 → 24:00 hora de parede).
      const timeMin = zonedWallTimeToUtc(data, 0, tz).toISOString();
      const timeMax = zonedWallTimeToUtc(data, 24 * 60, tz).toISOString();
      const events = await client.listEvents({ timeMin, timeMax });

      const slots = computeFreeSlotsForDay(events, config.work, {
        dateKey: data,
        durationMin: svc.min,
        timeZone: tz,
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
