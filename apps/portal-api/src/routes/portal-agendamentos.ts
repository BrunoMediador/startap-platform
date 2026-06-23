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
import { cloneColaboradores } from '@startap/db';
import { gcal } from '@startap/integrations';
import {
  TZ,
  hhmmToMins,
  loadScheduleConfig,
  nowPartsInTz,
  weekdayOfDateKey,
  zonedWallTimeToUtc,
} from '@startap/integrations/scheduling';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
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
  /**
   * Estabelecimento (multi-profissional): identifica de qual colaborador é o
   * evento. Ausente no INDIVIDUAL (single-agenda) — o front renderiza idêntico
   * a hoje (Cirilo/Samuel). Só adiciona id + nome do profissional; nenhuma PII
   * nova vaza (DTO whitelist continua: titulo já contém nome/serviço como hoje).
   */
  colaborador_id?: number;
  profissional_nome?: string;
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

// ---- PATCH /portal/agendamentos/:eventId (editar/remarcar) -------------------
//
// Todos os campos OPCIONAIS, mas o body precisa ter >= 1 (.refine). O eventId é
// PRESERVADO (remarcar = PATCH, nunca delete+create) — ver patchEvent no client.
// telefone reusa o mesmo telefoneSchema do POST; '' / null => "limpar telefone"
// é tratado como undefined (não muda). null/'' não viram "remover telefone".
const editarAgendamentoSchema = z
  .object({
    servico: z.string().trim().min(1).max(80).optional(),
    data: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'data deve ser YYYY-MM-DD')
      .optional(),
    hora: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'hora deve ser HH:mm')
      .optional(),
    cliente_nome: z.string().trim().min(1).max(80).optional(),
    cliente_telefone: z.preprocess(
      (v) => (v == null || v === '' ? undefined : v),
      telefoneSchema.optional(),
    ),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: 'informe ao menos um campo para editar',
  });

export const portalAgendamentosRoutes: FastifyPluginAsync = async (app) => {
  app.get('/portal/agendamentos', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);

    const query = req.query as { past?: unknown; ahead?: unknown };
    const pastParsed = pastDaysQuery.safeParse(query?.past);
    const aheadParsed = aheadDaysQuery.safeParse(query?.ahead);
    const pastDays = pastParsed.success ? pastParsed.data : DEFAULT_PAST;
    const aheadDays = aheadParsed.success ? aheadParsed.data : DEFAULT_AHEAD;

    const now = new Date();
    const timeMin = new Date(now.getTime() - pastDays * 86_400_000).toISOString();
    const timeMax = new Date(now.getTime() + aheadDays * 86_400_000).toISOString();

    // ── ESTABELECIMENTO (multi-profissional) ──────────────────────────────────
    // No estabelecimento o clone NÃO tem agenda própria: os eventos vivem nas
    // agendas de CADA colaborador (clone_colaboradores.gcal_calendar_id). Por isso
    // getGcalForSlot(slot) devolve agenda vazia. Aqui agregamos os eventos de TODAS
    // as agendas dos colaboradores (getGcalsForSlot, escopado por slot+tenant) e
    // marcamos cada evento com { colaborador_id, profissional_nome }.
    //
    // Gating estrito: só entra com a flag ESTABELECIMENTO_ENABLED ligada E o clone
    // sendo product_type='estabelecimento'. Qualquer outro caso cai no caminho
    // INDIVIDUAL abaixo — byte-a-byte como hoje (Cirilo/Samuel inalterados).
    if (config.ESTABELECIMENTO_ENABLED) {
      let isEstabelecimento = false;
      try {
        const scope = await cloneColaboradores.getScopeBySlot(slot);
        isEstabelecimento = scope.product_type === 'estabelecimento';
      } catch (err) {
        // Falha ao resolver o tipo → degrada pro caminho individual (seguro).
        log.warn(
          { slot, err: err instanceof Error ? err.message : 'erro' },
          'product_type indeterminado — caindo no caminho individual',
        );
      }

      if (isEstabelecimento) {
        return handleEstabelecimento(slot, timeMin, timeMax, reply);
      }
    }

    // ── INDIVIDUAL (single-agenda) — inalterado ───────────────────────────────
    const client = await gcal.getGcalForSlot(slot);
    if (!client) {
      // Clone sem GCal proprio (pre-setup ou nao configurado) — vazio, sem erro.
      return reply.code(200).send({ gcal_configured: false, count: 0, agendamentos: [] });
    }

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

  // ---- DELETE /portal/agendamentos/:eventId (Missão 023 W10 — cancelar) -------
  //
  // O dono cancela um horário pelo portal. Apaga o evento REAL na agenda GCal do
  // tenant (irreversível) — o front confirma com modal antes de chamar.
  //
  // Guarda de pertencimento (CRÍTICA, anti-IDOR): o deleteEvent do GCal é cego ao
  // tenant — qualquer eventId na MESMA agenda seria apagável. Antes de deletar,
  // re-listamos a agenda DO TENANT (resolvida por getGcalForSlot(slot), nunca por
  // input do cliente) numa janela ampla e confirmamos que o eventId está LÁ. Se
  // não está → 404 e NADA é apagado. Como cada clone tem Service Account/agenda
  // próprias (per-clone.ts, sem fallback pra matriz), um eventId de outro tenant
  // jamais aparece nessa listagem → cliente A nunca apaga evento de B.
  //
  // Janela de validação: -7/+60d (cobre os recentes que o GET mostra + futuro até
  // o limite de agendamento). Mesmo critério de isolamento do GET/POST.

  /** Quanto pra trás re-listar na validação de pertencimento (cobre passados recentes). */
  const DELETE_LOOKBACK_DAYS = 7;
  /** Quanto pra frente re-listar (alinha ao teto de agendamento de 60d). */
  const DELETE_LOOKAHEAD_DAYS = 60;
  /** eventId do GCal: alfanumérico (base32hex). Sanidade leve antes de ir ao GCal. */
  const eventIdParam = z.object({
    eventId: z
      .string()
      .trim()
      .min(1)
      .max(1024)
      .regex(/^[a-z0-9_-]+$/i, 'eventId invalido'),
  });

  app.delete('/portal/agendamentos/:eventId', { preHandler: withTenant }, async (req, reply) => {
    const { slot, userId } = requireTenant(req);

    const parsed = eventIdParam.safeParse(req.params ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'eventId_invalido' });
    }
    const { eventId } = parsed.data;

    const client = await gcal.getGcalForSlot(slot);
    if (!client) {
      return reply.code(422).send({ error: 'gcal_nao_configurado' });
    }

    const now = new Date();
    const timeMin = new Date(now.getTime() - DELETE_LOOKBACK_DAYS * 86_400_000).toISOString();
    const timeMax = new Date(now.getTime() + DELETE_LOOKAHEAD_DAYS * 86_400_000).toISOString();

    try {
      // Guarda de pertencimento: o eventId TEM que estar na agenda DESTE tenant.
      const events = await client.listEvents({ timeMin, timeMax });
      const pertence = events.some((e) => e.id === eventId);
      if (!pertence) {
        log.warn(
          { slot, userId, eventId },
          'cancelamento negado: eventId fora da agenda do tenant',
        );
        return reply.code(404).send({ error: 'evento_nao_encontrado' });
      }

      await client.deleteEvent(eventId);
      log.info({ slot, userId, eventId }, 'agendamento cancelado via portal');
      return reply.code(200).send({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'erro';
      // Idempotência: evento já removido (race entre a re-listagem e o delete, ou
      // dois cliques) → o Google devolve 404/410. Tratamos como sucesso: o estado
      // final desejado (evento ausente) foi atingido.
      if (/HTTP 4(0[49]|10)/.test(msg)) {
        log.info({ slot, userId, eventId }, 'cancelamento idempotente: evento ja ausente no GCal');
        return reply.code(200).send({ ok: true });
      }
      if (/40[13]/.test(msg)) gcal.invalidateGcalCache(slot);
      log.error({ slot, userId, eventId, err: msg }, 'cancelamento: falha no GCal');
      return reply.code(502).send({ error: 'nao foi possivel cancelar o agendamento agora' });
    }
  });

  // ---- PATCH /portal/agendamentos/:eventId (editar/remarcar) -----------------
  //
  // O dono edita um horário existente pelo portal: serviço, data/hora e/ou dados
  // do cliente. REMARCAR = PATCH no MESMO eventId — NUNCA delete+create (preserva
  // o vínculo do ledger de pacotes, ADR 0025 dívida 5; nenhuma baixa nova ocorre).
  //
  // Guarda anti-IDOR IDÊNTICA à do DELETE: re-lista a agenda DO TENANT (-7/+60d,
  // slot resolvido por getGcalForSlot(slot), nunca por input) e confirma que o
  // eventId está LÁ. Se não está → 404 e NADA muda. Como cada clone tem agenda/SA
  // próprias (sem fallback pra matriz), eventId de outro tenant jamais aparece.
  //
  // Anti-corrida: recheca a NOVA janela contra o GCal, IGNORANDO o próprio evento,
  // antes de aplicar → 409 estruturado se colidir; o front recarrega a grade.
  //
  // v1 = SÓ clone single-agenda (getGcalForSlot resolve a agenda principal — cobre
  // todos os clientes de hoje). Estabelecimento multi-colaborador (agenda por
  // barbeiro, mover entre colaboradores) é FOLLOW-UP explícito, fora de escopo.

  app.patch('/portal/agendamentos/:eventId', { preHandler: withTenant }, async (req, reply) => {
    const { slot, userId } = requireTenant(req);

    const paramParsed = eventIdParam.safeParse(req.params ?? {});
    if (!paramParsed.success) {
      return reply.code(400).send({ error: 'eventId_invalido' });
    }
    const { eventId } = paramParsed.data;

    const bodyParsed = editarAgendamentoSchema.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      return reply.code(400).send({
        error: 'payload_invalido',
        detalhe: bodyParsed.error.issues[0]?.message ?? 'payload invalido',
      });
    }
    const patch = bodyParsed.data;

    const client = await gcal.getGcalForSlot(slot);
    if (!client) {
      return reply.code(422).send({ error: 'gcal_nao_configurado' });
    }

    // Config do tenant — só precisamos validar serviço/horário se data/hora/serviço
    // mudaram. Mas a duração do serviço (atual ou novo) é necessária pra calcular a
    // nova janela quando data/hora mudam; então carregamos sempre que houver reagenda.
    const reagenda = patch.data !== undefined || patch.hora !== undefined;
    const mudaServico = patch.servico !== undefined;

    let config: Awaited<ReturnType<typeof loadScheduleConfig>> | null = null;
    if (reagenda || mudaServico) {
      try {
        config = await loadScheduleConfig(slot);
      } catch (err) {
        log.warn(
          { slot, err: err instanceof Error ? err.message : 'erro' },
          'editar agendamento: horarios/servicos nao configurados',
        );
        return reply.code(422).send({ error: 'config_ausente' });
      }
    }

    const now = new Date();
    const timeMinGuard = new Date(now.getTime() - DELETE_LOOKBACK_DAYS * 86_400_000).toISOString();
    const timeMaxGuard = new Date(now.getTime() + DELETE_LOOKAHEAD_DAYS * 86_400_000).toISOString();

    try {
      // Guarda de pertencimento: o eventId TEM que estar na agenda DESTE tenant.
      const events = await client.listEvents({ timeMin: timeMinGuard, timeMax: timeMaxGuard });
      const atual = events.find((e) => e.id === eventId);
      if (!atual) {
        log.warn({ slot, userId, eventId }, 'edicao negada: eventId fora da agenda do tenant');
        return reply.code(404).send({ error: 'evento_nao_encontrado' });
      }

      // Valida serviço (se mudou) contra a config do tenant.
      let svc: { name: string; min: number } | undefined;
      if (mudaServico && config) {
        const found = config.services.find(
          (s) => s.name.toLowerCase() === (patch.servico as string).toLowerCase(),
        );
        if (!found) {
          return reply.code(400).send({ error: 'servico_nao_encontrado' });
        }
        svc = found;
      }

      // Recompõe os campos do título a partir do summary atual + o que mudou.
      const parsedAtual = parseBotSummary(atual.summary ?? '');
      const novoNome = patch.cliente_nome ?? parsedAtual.nome;
      const novoServicoNome = svc?.name ?? parsedAtual.servico;
      const novoTelefone =
        patch.cliente_telefone !== undefined ? patch.cliente_telefone : parsedAtual.telefone;
      const mudaTitulo =
        patch.cliente_nome !== undefined || mudaServico || patch.cliente_telefone !== undefined;

      // ---- Reagendamento: calcula a nova janela e valida + anti-corrida --------
      let startISO: string | undefined;
      let endISO: string | undefined;

      if (reagenda) {
        // config é garantido aqui (reagenda => carregamos config acima).
        const cfg = config as Awaited<ReturnType<typeof loadScheduleConfig>>;
        // Deriva a data/hora ATUAL do evento pra preencher o lado que não mudou.
        const inicioAtualIso = atual.start?.dateTime ?? null;
        if (!inicioAtualIso) {
          // Evento all-day ou sem dateTime — não dá pra remarcar por hora. Raro
          // (o bot/portal sempre cria com dateTime). 422 explícito.
          return reply.code(422).send({ error: 'evento_sem_horario' });
        }
        const partsAtual = nowPartsInTz(new Date(inicioAtualIso));
        const dataAlvo = patch.data ?? partsAtual.dateKey;
        const horaAlvoMins = patch.hora !== undefined ? hhmmToMins(patch.hora) : partsAtual.mins;

        const wd = weekdayOfDateKey(dataAlvo);
        if (wd === null) {
          return reply.code(400).send({ error: 'payload_invalido', detalhe: 'data inexistente' });
        }

        // Duração: serviço novo (se mudou) senão o serviço do título atual (lookup
        // na config); fallback p/ duração do evento atual se o nome não casar.
        const duracaoMin =
          svc?.min ??
          cfg.services.find((s) => s.name.toLowerCase() === novoServicoNome.toLowerCase())?.min ??
          minutesBetween(atual.start?.dateTime, atual.end?.dateTime);
        if (!duracaoMin || duracaoMin <= 0) {
          return reply.code(422).send({ error: 'duracao_indeterminada' });
        }

        const startMins = horaAlvoMins;
        const endMins = startMins + duracaoMin;

        // Janela hoje..+60d + piso de 10min pra HOJE (mesma regra do POST).
        const agora = nowPartsInTz();
        const limite = nowPartsInTz(new Date(Date.now() + POST_MAX_AHEAD_DAYS * 86_400_000));
        if (dataAlvo > limite.dateKey) {
          return reply
            .code(400)
            .send({ error: 'data_fora_da_janela', max_dias: POST_MAX_AHEAD_DAYS });
        }
        if (
          dataAlvo < agora.dateKey ||
          (dataAlvo === agora.dateKey && startMins < agora.mins + POST_TODAY_FLOOR_MIN)
        ) {
          return reply.code(409).send({ error: 'conflito', reason: 'horario_passado' });
        }
        const janela = cfg.work[wd];
        if (!janela || startMins < janela[0] || endMins > janela[1]) {
          return reply.code(409).send({ error: 'conflito', reason: 'fora_do_horario' });
        }

        const startUtc = zonedWallTimeToUtc(dataAlvo, startMins);
        const endUtc = zonedWallTimeToUtc(dataAlvo, endMins);

        // Anti-corrida: recheca a NOVA janela IGNORANDO o próprio evento.
        const existing = await client.listEvents({
          timeMin: startUtc.toISOString(),
          timeMax: endUtc.toISOString(),
        });
        const conflito = existing.find((ev) => {
          if (ev.id === eventId) return false; // ignora o próprio evento (mesmo horário)
          const evStart = new Date(ev.start.dateTime ?? `${ev.start.date}T00:00:00`).getTime();
          const evEnd = new Date(ev.end.dateTime ?? `${ev.end.date}T00:00:00`).getTime();
          return evStart < endUtc.getTime() && evEnd > startUtc.getTime();
        });
        if (conflito) {
          log.warn(
            { slot, userId, eventId, data: dataAlvo, hora: minsToHHmm(startMins) },
            'edicao bloqueada: slot ocupado na nova janela',
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

        startISO = startUtc.toISOString();
        endISO = endUtc.toISOString();
      }

      // MESMO formato do bot SÓ se nome/servico/telefone mudaram; senão preserva o
      // título atual (não reescreve summary à toa).
      const summary = mudaTitulo
        ? novoTelefone
          ? `${novoNome} - ${novoServicoNome} | WhatsApp: ${novoTelefone}`
          : `${novoNome} - ${novoServicoNome}`
        : undefined;

      const updated = await client.patchEvent(eventId, {
        ...(summary !== undefined ? { summary } : {}),
        ...(startISO !== undefined ? { startISO } : {}),
        ...(endISO !== undefined ? { endISO } : {}),
        ...(startISO !== undefined || endISO !== undefined ? { timeZone: TZ } : {}),
      });

      log.info(
        {
          slot,
          userId,
          eventId,
          reagenda,
          mudaServico,
          mudaTitulo,
          phone: novoTelefone ? maskPhone(novoTelefone) : undefined,
        },
        'agendamento editado via portal',
      );

      const agendamento: AgendamentoOut = {
        id: updated.id ?? eventId,
        titulo: updated.summary ?? summary ?? atual.summary ?? '(sem titulo)',
        inicio: updated.start?.dateTime ?? updated.start?.date ?? atual.start?.dateTime ?? null,
        fim: updated.end?.dateTime ?? updated.end?.date ?? atual.end?.dateTime ?? null,
      };
      return reply.code(200).send({ ok: true, agendamento });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'erro';
      // Idempotência: evento sumiu entre a re-listagem e o patch → 404/410 do Google.
      if (/HTTP 4(0[49]|10)/.test(msg)) {
        log.info({ slot, userId, eventId }, 'edicao: evento ja ausente no GCal');
        return reply.code(404).send({ error: 'evento_nao_encontrado' });
      }
      if (/40[13]/.test(msg)) gcal.invalidateGcalCache(slot);
      log.error({ slot, userId, eventId, err: msg }, 'edicao: falha no GCal');
      return reply.code(502).send({ error: 'nao foi possivel editar o agendamento agora' });
    }
  });
};

/**
 * Agrega os eventos de TODAS as agendas dos colaboradores de um estabelecimento
 * numa única lista, marcando cada evento com { colaborador_id, profissional_nome }.
 *
 * Resolvido por gcal.getGcalsForSlot(slot) (PLURAL) — escopado por slot+tenant
 * dentro da própria integração (ADR 0024 §4: cada entry confere (slot, tenantId)).
 * Cada colaborador tem seu calendarId (mesma Service Account do clone). Listamos
 * em paralelo; a falha de UMA agenda NÃO derruba as outras (Promise.allSettled) —
 * o profissional com agenda quebrada simplesmente não aparece nesta janela.
 *
 * Estados:
 *   - sem colaborador resolvível (nenhum com GCal active) -> gcal_configured:false
 *     (mesmo contrato do individual em pré-setup: front mostra "agenda não
 *     conectada", não erro).
 *   - todas as listagens falharam (e havia colaborador) -> 502.
 */
async function handleEstabelecimento(
  slot: string,
  timeMin: string,
  timeMax: string,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const colaboradores = await gcal.getGcalsForSlot(slot);
  if (colaboradores.length === 0) {
    // Nenhum colaborador com agenda ativa (pré-setup do estabelecimento) — vazio.
    return reply.code(200).send({ gcal_configured: false, count: 0, agendamentos: [] });
  }

  // Lista as agendas em paralelo; uma falha não invalida as demais.
  const settled = await Promise.allSettled(
    colaboradores.map((c) => c.client.listEvents({ timeMin, timeMax })),
  );

  let houveSucesso = false;
  const agendamentos: AgendamentoOut[] = [];
  for (let i = 0; i < settled.length; i++) {
    const res = settled[i];
    const colab = colaboradores[i];
    if (res.status !== 'fulfilled') {
      log.warn(
        {
          slot,
          colaboradorId: colab.colaboradorId,
          err: res.reason instanceof Error ? res.reason.message : 'erro',
        },
        'estabelecimento: falha ao listar agenda de um colaborador (ignorado nesta janela)',
      );
      continue;
    }
    houveSucesso = true;
    for (const e of res.value) {
      agendamentos.push({
        id: e.id,
        titulo: e.summary ?? '(sem titulo)',
        inicio: e.start?.dateTime ?? e.start?.date ?? null,
        fim: e.end?.dateTime ?? e.end?.date ?? null,
        colaborador_id: colab.colaboradorId,
        profissional_nome: colab.nome,
      });
    }
  }

  // Havia colaboradores mas NENHUMA listagem deu certo → erro transitório do GCal.
  if (!houveSucesso) {
    log.error({ slot }, 'estabelecimento: todas as agendas de colaboradores falharam');
    return reply.code(502).send({ error: 'nao foi possivel buscar agendamentos agora' });
  }

  // Ordena por inicio ASC; eventos sem inicio (null) vao pro fim. Cap defensivo
  // (janela pequena, mas N agendas podem somar): mantém os mais próximos do início.
  const limitadas = agendamentos
    .sort((a, b) => (a.inicio ?? '￿').localeCompare(b.inicio ?? '￿'))
    .slice(0, MAX_EVENTS);

  return reply
    .code(200)
    .send({ gcal_configured: true, count: limitadas.length, agendamentos: limitadas });
}

/**
 * Quebra o summary do bot ("Nome - Servico | WhatsApp: numero") em partes pra
 * recompor o título quando só ALGUNS campos mudam. Tolerante: se o formato não
 * casar, devolve o texto inteiro como `nome` e os demais vazios (o caller só usa
 * os pedaços que vai sobrescrever; se o cliente mandou nome+servico+telefone, o
 * parse nem importa).
 */
function parseBotSummary(summary: string): { nome: string; servico: string; telefone?: string } {
  let telefone: string | undefined;
  let resto = summary;
  const waIdx = resto.indexOf('| WhatsApp:');
  if (waIdx >= 0) {
    const tel = resto
      .slice(waIdx + '| WhatsApp:'.length)
      .trim()
      .replace(/\D/g, '');
    telefone = tel.length > 0 ? tel : undefined;
    resto = resto.slice(0, waIdx).trim();
  }
  const sep = resto.indexOf(' - ');
  if (sep >= 0) {
    return { nome: resto.slice(0, sep).trim(), servico: resto.slice(sep + 3).trim(), telefone };
  }
  return { nome: resto.trim(), servico: '', telefone };
}

/** Diferença em minutos entre dois ISO dateTimes (ou 0 se faltar algum). */
function minutesBetween(startIso?: string, endIso?: string): number {
  if (!startIso || !endIso) return 0;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60_000) : 0;
}

/** Minutos-do-dia → "HH:mm" (só pra log estruturado). */
function minsToHHmm(mins: number): string {
  const h = Math.floor(mins / 60)
    .toString()
    .padStart(2, '0');
  const m = (mins % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}
