/**
 * Router universal — substitui o workflow ROUTER_WAHA (automação visual antiga).
 *
 * Recebe payload da WAHA, extrai telefone (handling LID/PN addressingMode),
 * busca em routing_clientes qual bot atende esse número, e delega.
 *
 * Diferenças do automação visual antiga original:
 *  - Roteamento dinâmico via map de bots (não HTTP forward externo).
 *  - Suporta múltiplas sessões WAHA na mesma instância.
 *  - Antibot + pausa global aplicados aqui (antes de chegar nos bots).
 */
import { logger } from '@startap/core/logger';
import { extractPhone, isGroupChat } from '@startap/core/phone';
import type { Bot, BotContext, IncomingMessage, WahaWebhookBody } from '@startap/core/types';
import { antibot, clientBilling, flowClones, flowExecutionLog, pausa, routing } from '@startap/db';
import type { RoutingRow } from '@startap/db';
import { waha, whisper } from '@startap/integrations';
import { checkAndMarkDuplicate } from './lib/idempotency.js';
import { applyFlowManualCommand, getFlowManualCommandForFlow } from './lib/manual-pause.js';
import { handleSessionStatusEvent } from './lib/trial-pairing.js';
import {
  type BotEntry,
  buildCloneRoute,
  buildFallbackRoute,
  findBotByFlowId,
  findBotBySession,
  registerBotEntry,
} from './registry.js';

/** Tipo de fábrica de bot clone: recebe slotOverride, retorna instância Bot. */
export type CloneBotFactory = (slotOverride: string) => Bot;

/** Map de matrizSlot -> factory. Registrado em server.ts. */
const cloneFactories = new Map<string, CloneBotFactory>();

/** Registra uma factory de clone para uma matriz. Chamado em server.ts. */
export function registerCloneFactory(matrizSlot: string, factory: CloneBotFactory): void {
  cloneFactories.set(matrizSlot, factory);
  log.info({ matrizSlot }, 'Clone factory registrada');
}

/**
 * Resolve um bot clone dinamicamente a partir do workflow_id (slot do clone).
 * Consulta flow_clones para descobrir matriz_slot e instancia o bot com override.
 * Retorna null se não encontrar a factory ou o registro no DB.
 */
async function resolveCloneBot(cloneSlot: string): Promise<Bot | null> {
  const cloneRow = await flowClones.getCloneBySlot(cloneSlot).catch(() => null);
  if (!cloneRow) {
    log.warn({ cloneSlot }, 'Clone não encontrado em flow_clones');
    return null;
  }
  const factory = cloneFactories.get(cloneRow.matriz_slot);
  if (!factory) {
    log.warn(
      { cloneSlot, matrizSlot: cloneRow.matriz_slot },
      'Nenhuma factory registrada para matriz do clone',
    );
    return null;
  }
  return factory(cloneSlot);
}

const log = logger.child({ module: 'router' });

/**
 * Registra um bot sem sessão própria (lookup via routing_clientes).
 * Bots com sessão própria (ex: Startap) registram-se via registerBotEntry
 * diretamente ao serem importados.
 */
export function registerBot(
  workflowId: string,
  bot: Bot,
  legacyPauseTable: string | null = null,
): void {
  registerBotEntry({
    workflowId,
    workflowName: workflowId,
    ownedSessions: [],
    legacyPauseTable,
    getManualCommand: () => null,
    applyManualCommand: async () => {},
    bot,
  });
  log.info({ workflowId, bot: bot.name }, 'Bot registrado');
}

/** Entry point — chamado pela rota /webhooks/waha. */
export async function handleWebhook(
  body: WahaWebhookBody,
  // skipDedup (ADR 0021): no caminho ASSÍNCRONO (WEBHOOK_ASYNC) a rota roda o
  // dedup ANTES do ACK-early — não pode reprocessar retry da WAHA. Para não
  // deduplicar 2x, a rota passa skipDedup=true e o bloco 1b vira no-op. No
  // caminho SÍNCRONO (flag OFF, default) o opts não traz skipDedup → o dedup
  // segue rodando aqui, idêntico ao de hoje.
  opts: { executionId: string; startedAt?: number; skipDedup?: boolean },
): Promise<{ status: string }> {
  const startedAt = opts.startedAt ?? Date.now();
  const baseLog = {
    executionId: opts.executionId,
    session: body.session,
  };

  // 0. Eventos de status de sessão alimentam o hook de trial do pareamento
  // (Missão 020 F1): 1º WORKING de clone em trial consome o trial_ledger e
  // inicia os 10 dias. Clones com trial_status='none' (Cirilo, matrizes,
  // clones manuais) são no-op absoluto — comportamento atual intacto.
  if (body.event === 'session.status') {
    return handleSessionStatusEvent(body, { executionId: opts.executionId, startedAt });
  }

  // 1. Aceita qualquer evento de mensagem nova (`message`, `message.any` e
  // variantes que algumas engines WAHA usam para audio/midia tipo
  // `message.media`, `message.audio`). Rejeita ack/revoked/reaction que sao
  // mudancas de estado, nao mensagens novas.
  //
  // Bruno 2026-05-21: cliente reportou que audio "nem disparou" — hipotese
  // de que a engine atual envia audio sob evento diferente de `message`. Em
  // vez de hardcoded whitelist, usamos prefix `message.` com blacklist de
  // sub-eventos que sabemos serem nao-incoming. Para diagnostico, quando
  // dropar, logamos o event + estrutura do payload.
  const NON_INCOMING_EVENT_SUFFIXES = new Set([
    'ack',
    'revoke',
    'revoked',
    'reaction',
    'edited',
    'waiting',
  ]);
  const isMessageEvent =
    body.event === 'message' ||
    body.event === 'message.any' ||
    (typeof body.event === 'string' &&
      body.event.startsWith('message.') &&
      !NON_INCOMING_EVENT_SUFFIXES.has(body.event.slice('message.'.length)));
  if (!isMessageEvent) {
    await flowExecutionLog.logFlowEvent({
      ...baseLog,
      eventType: 'router.ignored',
      status: 'ignored',
      message: 'Evento WAHA ignorado',
      metadata: {
        reason: 'event',
        event: body.event,
        // Diagnostico audio: se evento rejeitado tem cara de audio, mostra
        // estrutura do payload para identificar como aceitar futuramente.
        payloadKeys: body.payload ? Object.keys(body.payload) : [],
        dataMsgKeys: dumpDataMessageKeys(body.payload),
        audioMsgPresent: hasAudioMessageNode(body.payload),
      },
      durationMs: Date.now() - startedAt,
    });
    return { status: 'ignored:event' };
  }

  // 1b. Dedup de evento de mensagem (ADR 0019, passo 2) — FLAG-GATED, FAIL-OPEN.
  // Default OFF: este bloco e no-op e o fluxo segue identico ao de hoje. ON: faz
  // SET NX EX no Redis com chave (sessao, messageId); se o evento ja foi visto
  // (retry/duplicata da WAHA, ou a outra instancia no scale-out) -> PULA o
  // processamento e retorna 200 (WAHA nao retenta). Redis down/timeout/sem id ->
  // fail-open (processa mesmo assim, com warn) — nunca cala o bot por hiccup de
  // Redis. Posicionado ANTES de qualquer efeito (resposta WAHA, GCal, antibot).
  // Le a flag direto do process.env (mesmo padrao do gate BILLING_OVERDUE_SILENCE):
  // permite OFF instantaneo em runtime, sem rebuild. TTL/timeout vem do config
  // (parseados no boot — nao precisam de toggle a quente).
  // skipDedup: o ACK-early do webhook async (ADR 0021) JÁ rodou este dedup na
  // rota, ANTES de aceitar o processamento — aqui seria deduplicar 2x.
  if (process.env.IDEMPOTENCY_DEDUP === 'true' && !opts.skipDedup) {
    const messageId = body.payload?.id ?? '';
    const dedup = await checkAndMarkDuplicate(body.session, messageId);
    if (dedup.duplicate) {
      log.info({ ...baseLog }, 'Evento de mensagem duplicado ignorado (dedup)');
      await flowExecutionLog.logFlowEvent({
        ...baseLog,
        eventType: 'router.ignored',
        status: 'ignored',
        message: 'Evento de mensagem duplicado ignorado (dedup)',
        metadata: { reason: 'dedup', event: body.event },
        durationMs: Date.now() - startedAt,
      });
      return { status: 'ignored:dedup' };
    }
    // dedup.degraded === true -> Redis indisponivel ou sem messageId: ja logado
    // como warn no modulo; seguimos processando (fail-open).
  }

  const fromMe = !!body.payload?.fromMe;
  // Detecta bot por sessão antes de extrair telefone — necessário para comandos
  // manuais de bots com sessão própria (ex: Startap), cujo trigger pode chegar
  // antes de qualquer informação de roteamento.
  const sessionEntry = findBotBySession(body.session);
  const sessionManualCommand =
    fromMe && sessionEntry ? sessionEntry.getManualCommand(body.payload?.body ?? '') : null;

  // 2. Mensagens fromMe com texto podem ser comando manual por fluxo.
  // A decisão final vem depois de extrair o telefone e descobrir o fluxo.
  if (fromMe && !sessionManualCommand && !body.payload?.body) {
    await flowExecutionLog.logFlowEvent({
      ...baseLog,
      eventType: 'router.ignored',
      status: 'ignored',
      message: 'Mensagem enviada pelo próprio bot',
      metadata: { reason: 'fromMe' },
      durationMs: Date.now() - startedAt,
    });
    return { status: 'ignored:fromMe' };
  }

  // 3. Extrai telefone real
  const telefone = extractPhone(body);
  if (!telefone) {
    log.warn({ payload: body.payload }, 'Não foi possível extrair telefone');
    await flowExecutionLog.logFlowEvent({
      ...baseLog,
      eventType: 'router.no-phone',
      status: 'ignored',
      message: 'Não foi possível extrair telefone',
      metadata: {
        hasPayload: !!body.payload,
        from: body.payload?.from ? '[present]' : null,
        addressingMode: body.payload?._data?.key?.addressingMode ?? null,
      },
      durationMs: Date.now() - startedAt,
    });
    return { status: 'ignored:no-phone' };
  }

  // 3a. Filtro de grupo — deve vir ANTES de qualquer log com telefone,
  // antibot ou chamada de bot. Mensagens de grupo são ignoradas em TODOS os
  // clones (Ricardo, Cirilo, Lola, matrizes de teste). Critérios:
  //  - payload.from termina em @g.us (chatId de grupo explícito)
  //  - payload.from começa com 120363 (JID grupo padrão NOWEB/Baileys)
  //  - campo participant presente e não vazio (exclusivo de msgs em grupo)
  // IDs de 22+ dígitos (ex: 5592813522781591200729) são LIDs de participante
  // de grupo — sempre acompanhados de participant, cobertos pelo critério 3.
  if (isGroupChat(body)) {
    const groupFrom = body.payload?.from ?? 'unknown';
    log.info({ ...baseLog, groupFrom }, 'Mensagem de grupo ignorada');
    await flowExecutionLog.logFlowEvent({
      ...baseLog,
      eventType: 'router.ignored',
      status: 'ignored',
      message: 'Mensagem de grupo ignorada',
      metadata: {
        reason: 'group-chat',
        groupFrom,
      },
      durationMs: Date.now() - startedAt,
    });
    return { status: 'ignored:group-chat' };
  }

  const sessao = body.session;
  const chatId = body.payload?.from ?? '';
  const phoneLog = { ...baseLog, telefone };

  // Comando manual de bot com sessão própria (ex: "ola!souicaro..." do Startap).
  // Diferente dos comandos genéricos de fluxo abaixo, este é interpretado pelo
  // próprio bot sem passar por routing_clientes.
  if (sessionManualCommand && sessionEntry) {
    await sessionEntry.applyManualCommand(sessionManualCommand, telefone, {
      session: sessao,
      source: 'fromMe',
    });
    await flowExecutionLog.logFlowEvent({
      ...phoneLog,
      flowId: sessionEntry.workflowId,
      flowName: sessionEntry.workflowName,
      bot: sessionEntry.bot.name,
      eventType:
        sessionManualCommand === 'pause'
          ? `${sessionEntry.bot.name}.manual-pause`
          : `${sessionEntry.bot.name}.manual-resume`,
      status: 'success',
      message:
        sessionManualCommand === 'pause'
          ? 'Atendente assumiu a conversa'
          : 'Atendimento humano finalizado; IA retomada',
      metadata: { pauseTable: sessionEntry.legacyPauseTable, source: 'fromMe' },
      durationMs: Date.now() - startedAt,
    });
    return { status: `ok:${sessionEntry.bot.name}-manual-${sessionManualCommand}` };
  }

  if (fromMe) {
    const route = await findRoute(telefone, sessao, sessionEntry);
    const flowManualCommand = route
      ? await getFlowManualCommandForFlow(route.workflow_id, body.payload?.body ?? '')
      : null;
    if (!route) {
      await flowExecutionLog.logFlowEvent({
        ...phoneLog,
        eventType: 'router.manual-pause-no-routing',
        status: 'ignored',
        message: 'Comando manual recebido, mas telefone sem rota ativa',
        metadata: { command: flowManualCommand, source: 'fromMe' },
        durationMs: Date.now() - startedAt,
      });
      return { status: 'ignored:manual-pause-no-routing' };
    }
    if (!flowManualCommand) {
      await flowExecutionLog.logFlowEvent({
        ...phoneLog,
        flowId: route.workflow_id,
        flowName: route.workflow_name,
        eventType: 'router.ignored',
        status: 'ignored',
        message: 'Mensagem enviada pelo próprio bot',
        metadata: { reason: 'fromMe', routeId: route.id },
        durationMs: Date.now() - startedAt,
      });
      return { status: 'ignored:fromMe' };
    }

    await applyFlowManualCommand({
      command: flowManualCommand,
      flowId: route.workflow_id,
      flowName: route.workflow_name,
      telefone,
      session: sessao,
      source: 'fromMe',
      reason: 'Comando manual no WhatsApp',
    });
    await flowExecutionLog.logFlowEvent({
      ...phoneLog,
      flowId: route.workflow_id,
      flowName: route.workflow_name,
      eventType: flowManualCommand === 'pause' ? 'router.manual-pause' : 'router.manual-resume',
      status: 'success',
      message:
        flowManualCommand === 'pause'
          ? 'Atendente assumiu a conversa neste fluxo'
          : 'Atendimento humano finalizado; IA do fluxo retomada',
      metadata: { pauseScope: 'flow', source: 'fromMe' },
      durationMs: Date.now() - startedAt,
    });
    return { status: `ok:manual-${flowManualCommand}` };
  }

  await flowExecutionLog.logFlowEvent({
    ...phoneLog,
    eventType: 'router.phone-extracted',
    status: 'running',
    message: 'Telefone extraído e mensagem aceita para roteamento',
    metadata: {
      hasText: !!body.payload?.body,
      hasMedia: !!body.payload?.hasMedia,
      mediaType: body.payload?.media?.mimetype ?? null,
      // Diagnostico audio: estrutura completa do payload pra identificar
      // onde a engine WAHA atual coloca o audio. Volatil — remover apos
      // bug resolvido. Bruno 2026-05-21.
      payloadKeys: body.payload ? Object.keys(body.payload) : [],
      dataMsgKeys: dumpDataMessageKeys(body.payload),
      rootMimeType: (body.payload as Record<string, unknown> | null | undefined)?.mimeType ?? null,
      audioMsgPresent: hasAudioMessageNode(body.payload),
    },
  });

  // 4. Log para antibot
  await antibot.logMessage(telefone, sessao).catch((e) => log.warn(e, 'log msg failed'));

  // Bots com sessão própria têm tabela de pausa legada verificada aqui.
  // Isso preserva o comportamento anterior onde pause_startap bloqueava
  // mensagens recebidas na sessão Startap antes do roteamento.
  if (sessionEntry?.legacyPauseTable) {
    const sessionPaused =
      (await pausa
        .isFlowPaused({ flowId: sessionEntry.workflowId, telefone })
        .catch(() => false)) ||
      (await pausa.isPaused(sessionEntry.legacyPauseTable, telefone).catch(() => false));
    if (sessionPaused) {
      log.info({ telefone, sessao }, 'Número em pausa de sessão própria, ignorando');
      await flowExecutionLog.logFlowEvent({
        ...phoneLog,
        flowId: sessionEntry.workflowId,
        flowName: sessionEntry.workflowName,
        bot: sessionEntry.bot.name,
        eventType: 'router.session-paused',
        status: 'ignored',
        message: 'Número em pausa de sessão própria, ignorando',
        metadata: { pauseTable: sessionEntry.legacyPauseTable },
        durationMs: Date.now() - startedAt,
      });
      return { status: 'ignored:session-paused' };
    }
  }

  // 6. Busca rota
  const route = await findRoute(telefone, sessao, sessionEntry);
  if (!route) {
    log.debug({ telefone, sessao }, 'Telefone sem roteamento configurado');
    await flowExecutionLog.logFlowEvent({
      ...phoneLog,
      eventType: 'router.no-routing',
      status: 'ignored',
      message: 'Telefone sem roteamento configurado',
      durationMs: Date.now() - startedAt,
    });
    return { status: 'ignored:no-routing' };
  }

  // 6a. Antibot/pausa por fluxo: gate isolado, não afeta outros bots
  const isFlowPaused = await pausa
    .isFlowPaused({ flowId: route.workflow_id, telefone })
    .catch(() => false);
  if (isFlowPaused) {
    log.info({ telefone, flowId: route.workflow_id }, 'Número em pausa de fluxo, ignorando');
    await flowExecutionLog.logFlowEvent({
      ...phoneLog,
      flowId: route.workflow_id,
      flowName: route.workflow_name,
      eventType: 'router.blocked',
      status: 'ignored',
      message: 'Número em pausa de fluxo, ignorando',
      metadata: { flowId: route.workflow_id },
      durationMs: Date.now() - startedAt,
    });
    return { status: 'ignored:flow-paused' };
  }

  // 6b. Gate de silêncio do bot por PERFIL DE COBRANÇA (ADR 0016).
  // Aplica apenas para clones (slot prefixado com "clone_").
  // Dois eixos em OR — ambos silenciam total, sessão WAHA permanece intacta:
  //   (a) suspensão MANUAL: flow_clones.flow_enabled === false (toggle do gestão);
  //   (b) VENCIDO além da carência: daysUntilDue(next_due_date) < -GRACE_DAYS,
  //       só quando há billing (next_due_date E amount_cents>0). DERIVADO no ato,
  //       nunca escreve flow_enabled — perdão (data pro futuro) volta o bot sem UPDATE.
  // Eixo (b) atrás da flag BILLING_OVERDUE_SILENCE (env). OFF (default) = comportamento
  // legado: só (a) cala. getCloneBySlot já traz next_due_date/amount_cents via LEFT JOIN
  // (cache TTL 60s) — sem query nova no hot path.
  if (route.workflow_id.startsWith('clone_')) {
    const cloneForGate = await flowClones.getCloneBySlot(route.workflow_id).catch(() => null);

    if (cloneForGate) {
      const suspensaoManual = cloneForGate.flow_enabled === false;

      const overdueSilenceOn = process.env.BILLING_OVERDUE_SILENCE === 'true';
      // Guard duro: só há cobrança quando data E valor>0 estão presentes.
      const temBilling =
        cloneForGate.next_due_date != null && (cloneForGate.billing_amount_cents ?? 0) > 0;
      const diasRestantes = temBilling
        ? clientBilling.daysUntilDue(cloneForGate.next_due_date)
        : null;
      const vencidoComCarencia =
        overdueSilenceOn &&
        temBilling &&
        diasRestantes != null &&
        diasRestantes < -clientBilling.GRACE_DAYS;

      // Suspensão manual tem precedência no log (eixo explícito do operador).
      if (suspensaoManual) {
        log.info(
          {
            telefone,
            flowId: route.workflow_id,
            suspendedReason: cloneForGate.suspended_reason,
            suspendedAt: cloneForGate.suspended_at,
          },
          'Fluxo suspenso (manual), ignorando',
        );
        await flowExecutionLog.logFlowEvent({
          ...phoneLog,
          flowId: route.workflow_id,
          flowName: route.workflow_name,
          eventType: 'router.flow-suspended',
          status: 'ignored',
          message: 'Fluxo suspenso, ignorando',
          metadata: {
            flowId: route.workflow_id,
            suspendedReason: cloneForGate.suspended_reason,
            suspendedAt: cloneForGate.suspended_at?.toISOString() ?? null,
          },
          durationMs: Date.now() - startedAt,
        });
        return { status: 'ignored:flow-suspended' };
      }

      if (vencidoComCarencia) {
        log.info(
          {
            telefone,
            flowId: route.workflow_id,
            nextDueDate: cloneForGate.next_due_date,
            diasRestantes,
            graceDays: clientBilling.GRACE_DAYS,
          },
          'Fluxo silenciado por inadimplência (vencido além da carência), ignorando',
        );
        await flowExecutionLog.logFlowEvent({
          ...phoneLog,
          flowId: route.workflow_id,
          flowName: route.workflow_name,
          eventType: 'router.billing-overdue',
          status: 'ignored',
          message: 'Fluxo silenciado por inadimplência, ignorando',
          metadata: {
            flowId: route.workflow_id,
            nextDueDate: cloneForGate.next_due_date,
            diasRestantes,
            graceDays: clientBilling.GRACE_DAYS,
          },
          durationMs: Date.now() - startedAt,
        });
        return { status: 'ignored:billing-overdue' };
      }
    }
  }

  await flowExecutionLog.logFlowEvent({
    ...phoneLog,
    flowId: route.workflow_id,
    flowName: route.workflow_name,
    eventType: 'router.route-found',
    status: 'running',
    message: 'Rota encontrada',
    metadata: { routeId: route.id, active: route.ativo },
  });

  const entry = findBotByFlowId(route.workflow_id);
  // Clones têm slot prefixado com "clone_" e não estão no registry estático.
  // São resolvidos dinamicamente via flow_clones + factory da matriz.
  const bot: Bot | null =
    entry?.bot ??
    (route.workflow_id.startsWith('clone_') ? await resolveCloneBot(route.workflow_id) : null);

  if (!bot) {
    log.warn({ workflowId: route.workflow_id, telefone }, 'Bot não encontrado no registry');
    await flowExecutionLog.logFlowEvent({
      ...phoneLog,
      flowId: route.workflow_id,
      flowName: route.workflow_name,
      eventType: 'router.bot-not-registered',
      status: 'error',
      message: 'Bot não encontrado no registry',
      durationMs: Date.now() - startedAt,
    });
    return { status: 'error:bot-not-registered' };
  }

  // 7. Constrói mensagem normalizada
  const message = await buildIncomingMessage({ body, telefone, sessao, chatId });

  // 8. Marca como lida + processa
  await waha.sendSeen(sessao, chatId).catch(() => {});

  const ctx: BotContext = {
    message,
    executionId: opts.executionId,
    flowId: route.workflow_id,
    flowName: route.workflow_name,
  };
  try {
    await flowExecutionLog.logFlowEvent({
      ...phoneLog,
      flowId: route.workflow_id,
      flowName: route.workflow_name,
      bot: bot.name,
      eventType: 'bot.started',
      status: 'running',
      message: 'Bot iniciou processamento',
    });
    await bot.handle(ctx);
    log.info({ bot: bot.name, telefone }, 'Mensagem processada');
    await flowExecutionLog.logFlowEvent({
      ...phoneLog,
      flowId: route.workflow_id,
      flowName: route.workflow_name,
      bot: bot.name,
      eventType: 'bot.finished',
      status: 'success',
      message: 'Mensagem processada',
      durationMs: Date.now() - startedAt,
    });
    return { status: 'ok' };
  } catch (e) {
    log.error({ err: e, bot: bot.name, telefone }, 'Bot falhou');
    await flowExecutionLog.logFlowEvent({
      ...phoneLog,
      flowId: route.workflow_id,
      flowName: route.workflow_name,
      bot: bot.name,
      eventType: 'bot.failed',
      status: 'error',
      message: 'Bot falhou',
      error: e,
      durationMs: Date.now() - startedAt,
    });
    return { status: 'error:bot-failed' };
  }
}

/**
 * Prioridade de roteamento:
 *  1. Sessão própria (bot com ownedSessions, ex: Startap/Lola) → RoutingRow sintética via buildFallbackRoute.
 *  2. Sessão de clone (waha_sessao em flow_clones) → RoutingRow sintética via buildCloneRoute.
 *  3. Router por telefone via routing_clientes (matrizes de teste).
 */
async function findRoute(
  telefone: string,
  sessao: string,
  sessionEntry: BotEntry | null,
): Promise<RoutingRow | null> {
  if (sessionEntry) {
    return buildFallbackRoute(sessionEntry, telefone);
  }

  const clone = await flowClones.getCloneBySession(sessao).catch((e) => {
    log.warn({ err: e, sessao }, 'Erro ao buscar clone por sessao');
    return null;
  });
  if (clone) {
    return buildCloneRoute(clone, telefone);
  }

  return routing.findRouting(telefone);
}

async function buildIncomingMessage(input: {
  body: WahaWebhookBody;
  telefone: string;
  sessao: string;
  chatId: string;
}): Promise<IncomingMessage> {
  const { body, telefone, sessao, chatId } = input;
  const payload = body.payload;
  const pushName = payload?._data?.pushName ?? '';
  const messageId = payload?.id ?? '';
  const timestampRaw = payload?._data?.messageTimestamp;
  const timestamp =
    typeof timestampRaw === 'string'
      ? Number(timestampRaw)
      : (timestampRaw ?? Math.floor(Date.now() / 1000));
  const fromMe = !!payload?.fromMe;

  // Texto ou transcrição de áudio
  let texto = payload?.body ?? '';
  let wasAudio = false;

  // WAHA tem 3 engines (WEBJS, NOWEB, GOWS) e cada uma coloca audio em
  // lugar diferente do payload. Tentamos descobrir mime+url andando por
  // varios caminhos conhecidos. Bug previo (PR #167): so checava
  // payload.media.mimetype, perdia messages com payload em _data.message.*.
  const audioInfo = detectAudio(payload);
  if (audioInfo.isAudio) {
    if (!audioInfo.url) {
      log.warn(
        {
          telefone,
          hasMedia: payload?.hasMedia,
          mimetype: audioInfo.mimetype,
          payloadKeys: payload ? Object.keys(payload) : [],
          dataMsgKeys: getDataMessageKeys(payload),
        },
        'Audio detectado mas sem URL para baixar — verificar payload do WAHA',
      );
      texto = '[audio recebido mas sem url para baixar]';
      wasAudio = true;
    } else {
      try {
        const audio = await waha.downloadMedia(audioInfo.url);
        const transcribed = await whisper.transcribe(audio, audioInfo.mimetype ?? 'audio/ogg');
        const cleaned = transcribed.trim();
        if (cleaned.length > 0) {
          texto = cleaned;
          wasAudio = true;
          log.info({ telefone, len: cleaned.length, source: audioInfo.source }, 'Áudio transcrito');
        } else {
          log.warn(
            { telefone, source: audioInfo.source },
            'Whisper devolveu texto vazio para audio',
          );
          texto = '[audio sem fala identificada]';
          wasAudio = true;
        }
      } catch (e) {
        log.error(
          { err: e, telefone, source: audioInfo.source, url: audioInfo.url.slice(0, 80) },
          'Falha ao transcrever áudio',
        );
        texto = '[áudio não transcrito]';
        wasAudio = true;
      }
    }
  } else if (payload?.hasMedia) {
    // hasMedia=true mas nao detectamos audio — pode ser imagem/video (ok)
    // ou audio em campo novo que ainda nao conhecemos. Loga estrutura.
    log.info(
      {
        telefone,
        mediaMime: payload?.media?.mimetype,
        dataMsgKeys: getDataMessageKeys(payload),
        payloadKeys: payload ? Object.keys(payload) : [],
      },
      'hasMedia=true mas nao classificado como audio',
    );
  }

  return {
    sessao,
    telefone,
    chatId,
    pushName,
    texto,
    fromMe,
    messageId,
    timestamp,
    wasAudio,
    raw: body,
  };
}

// --- Detecção de audio em payloads WAHA (multi-engine) ----------------------

interface AudioInfo {
  isAudio: boolean;
  mimetype?: string;
  url?: string;
  /** Caminho do payload onde foi encontrado (para log/debug). */
  source?: string;
}

/**
 * Anda pelos caminhos conhecidos onde WAHA coloca info de audio, dependendo da
 * engine (WEBJS/NOWEB/GOWS) e versao. Retorna a primeira combinacao valida de
 * mimetype audio/* + URL para download.
 */
function detectAudio(payload: unknown): AudioInfo {
  if (!payload || typeof payload !== 'object') return { isAudio: false };
  const p = payload as Record<string, unknown>;

  // Candidatos: objetos do payload que podem conter audio.
  const _data = (p._data ?? {}) as Record<string, unknown>;
  const _msg = (_data.message ?? {}) as Record<string, unknown>;

  type Cand = { node: Record<string, unknown> | undefined; source: string };
  const cands: Cand[] = [
    { node: p.media as Record<string, unknown> | undefined, source: 'payload.media' },
    {
      node: _msg.audioMessage as Record<string, unknown> | undefined,
      source: '_data.message.audioMessage',
    },
    {
      node: _msg.pttMessage as Record<string, unknown> | undefined,
      source: '_data.message.pttMessage',
    },
    // Algumas versoes serializam direto na raiz do payload
    { node: p, source: 'payload (raiz)' },
  ];

  for (const c of cands) {
    if (!c.node || typeof c.node !== 'object') continue;
    const node = c.node;
    const mime = pickString(node.mimetype) ?? pickString(node.mime) ?? pickString(node.mimeType);
    if (!mime || !mime.startsWith('audio/')) continue;
    const url =
      pickString(node.url) ??
      pickString(node.fileUrl) ??
      pickString(node.directPath) ??
      pickString(node.mediaUrl) ??
      pickString((p.media as Record<string, unknown> | undefined)?.url) ??
      '';
    return { isAudio: true, mimetype: mime, url, source: c.source };
  }

  // Sinal indireto: pttMessage / audioMessage existe (mesmo sem mimetype legivel).
  if (_msg.audioMessage || _msg.pttMessage) {
    const node = (_msg.audioMessage ?? _msg.pttMessage) as Record<string, unknown>;
    const url = pickString(node.url) ?? pickString(node.mediaUrl) ?? '';
    return {
      isAudio: true,
      mimetype: pickString(node.mimetype) ?? 'audio/ogg',
      url,
      source: _msg.audioMessage
        ? '_data.message.audioMessage (sem mime)'
        : '_data.message.pttMessage (sem mime)',
    };
  }

  return { isAudio: false };
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Diagnostico audio (volatil — remover quando bug resolvido): dump das
 * chaves de payload._data.message com tipos basicos. Util para identificar
 * em que engine do WAHA estamos e onde audio esta no payload.
 */
function dumpDataMessageKeys(payload: unknown): Record<string, string> {
  if (!payload || typeof payload !== 'object') return {};
  const _data = (payload as Record<string, unknown>)._data;
  if (!_data || typeof _data !== 'object') return {};
  const msg = (_data as Record<string, unknown>).message;
  if (!msg || typeof msg !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(msg as Record<string, unknown>)) {
    if (v === null) out[k] = 'null';
    else if (typeof v === 'object') {
      const subKeys = Object.keys(v as Record<string, unknown>).slice(0, 8);
      out[k] = `object{${subKeys.join(',')}}`;
    } else out[k] = typeof v;
  }
  return out;
}

function hasAudioMessageNode(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const _data = (payload as Record<string, unknown>)._data;
  if (!_data || typeof _data !== 'object') return false;
  const msg = (_data as Record<string, unknown>).message;
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  return !!(m.audioMessage || m.pttMessage);
}

/** Lista chaves de payload._data.message — util para diagnostico. */
function getDataMessageKeys(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const _data = (payload as Record<string, unknown>)._data;
  if (!_data || typeof _data !== 'object') return [];
  const msg = (_data as Record<string, unknown>).message;
  if (!msg || typeof msg !== 'object') return [];
  return Object.keys(msg);
}
