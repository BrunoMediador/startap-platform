/**
 * Router universal — substitui o workflow ROUTER_WAHA (n8n).
 *
 * Recebe payload da WAHA, extrai telefone (handling LID/PN addressingMode),
 * busca em routing_clientes qual bot atende esse número, e delega.
 *
 * Diferenças do n8n original:
 *  - Roteamento dinâmico via map de bots (não HTTP forward externo).
 *  - Suporta múltiplas sessões WAHA na mesma instância.
 *  - Antibot + pausa global aplicados aqui (antes de chegar nos bots).
 */
import { logger } from '@startap/core/logger';
import { extractPhone } from '@startap/core/phone';
import type { Bot, BotContext, IncomingMessage, WahaWebhookBody } from '@startap/core/types';
import { antibot, flowControl, flowExecutionLog, pausa, routing } from '@startap/db';
import type { RoutingRow } from '@startap/db';
import { waha, whisper } from '@startap/integrations';
import {
  STARTAP_WORKFLOW_ID,
  STARTAP_WORKFLOW_NAME,
  applyStartapManualCommand,
  getStartapManualCommand,
  isStartapSession,
} from './bots/startap.js';

const log = logger.child({ module: 'router' });

/** Mapa em memória dos bots disponíveis — key = workflow_id em routing_clientes. */
const botRegistry = new Map<string, Bot>();

export function registerBot(workflowId: string, bot: Bot): void {
  botRegistry.set(workflowId, bot);
  log.info({ workflowId, bot: bot.name }, 'Bot registrado');
}

/** Entry point — chamado pela rota /webhooks/waha. */
export async function handleWebhook(
  body: WahaWebhookBody,
  opts: { executionId: string; startedAt?: number },
): Promise<{ status: string }> {
  const startedAt = opts.startedAt ?? Date.now();
  const baseLog = {
    executionId: opts.executionId,
    session: body.session,
  };

  // 1. Ignora eventos não-mensagem
  if (!['message', 'message.any'].includes(body.event)) {
    await flowExecutionLog.logFlowEvent({
      ...baseLog,
      eventType: 'router.ignored',
      status: 'ignored',
      message: 'Evento WAHA ignorado',
      metadata: { reason: 'event', event: body.event },
      durationMs: Date.now() - startedAt,
    });
    return { status: 'ignored:event' };
  }

  const fromMe = !!body.payload?.fromMe;
  const startapManualCommand =
    fromMe && isStartapSession(body.session)
      ? getStartapManualCommand(body.payload?.body ?? '')
      : null;

  // 2. Ignora mensagens comuns enviadas pelo próprio bot.
  // Comandos manuais da Startap precisam passar para pausar/retomar a IA.
  if (fromMe && !startapManualCommand) {
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

  const sessao = body.session;
  const chatId = body.payload?.from ?? '';
  const phoneLog = { ...baseLog, telefone };

  if (startapManualCommand) {
    await applyStartapManualCommand(startapManualCommand, telefone);
    await flowExecutionLog.logFlowEvent({
      ...phoneLog,
      flowId: STARTAP_WORKFLOW_ID,
      flowName: STARTAP_WORKFLOW_NAME,
      bot: 'startap',
      eventType:
        startapManualCommand === 'pause' ? 'startap.manual-pause' : 'startap.manual-resume',
      status: 'success',
      message:
        startapManualCommand === 'pause'
          ? 'Atendente assumiu a conversa Startap'
          : 'Atendimento humano finalizado; IA Startap retomada',
      metadata: { pauseTable: 'pause_startap', source: 'fromMe' },
      durationMs: Date.now() - startedAt,
    });
    return { status: `ok:startap-manual-${startapManualCommand}` };
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
    },
  });

  // 4. Log para antibot
  await antibot.logMessage(telefone, sessao).catch((e) => log.warn(e, 'log msg failed'));

  // 5. Antibot: se está em bot_pausa, ignora
  const isBlocked = await pausa.isPaused('bot_pausa', telefone).catch(() => false);
  if (isBlocked) {
    log.info({ telefone }, 'Número em bot_pausa, ignorando');
    await flowExecutionLog.logFlowEvent({
      ...phoneLog,
      eventType: 'router.blocked',
      status: 'ignored',
      message: 'Número em bot_pausa, ignorando',
      metadata: { pauseTable: 'bot_pausa' },
      durationMs: Date.now() - startedAt,
    });
    return { status: 'ignored:bot-pausa' };
  }

  if (isStartapSession(sessao)) {
    const startapPaused = await pausa.isPaused('pause_startap', telefone).catch(() => false);
    if (startapPaused) {
      log.info({ telefone, sessao }, 'Número em pause_startap, ignorando sessão Startap');
      await flowExecutionLog.logFlowEvent({
        ...phoneLog,
        flowId: STARTAP_WORKFLOW_ID,
        flowName: STARTAP_WORKFLOW_NAME,
        bot: 'startap',
        eventType: 'router.startap-paused',
        status: 'ignored',
        message: 'Número em pause_startap, ignorando sessão Startap',
        metadata: { pauseTable: 'pause_startap' },
        durationMs: Date.now() - startedAt,
      });
      return { status: 'ignored:startap-paused' };
    }
  }

  // 6. Busca rota
  const route = await findRouteOrStartapFallback(telefone, sessao);
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

  await flowExecutionLog.logFlowEvent({
    ...phoneLog,
    flowId: route.workflow_id,
    flowName: route.workflow_name,
    eventType: 'router.route-found',
    status: 'running',
    message: 'Rota encontrada',
    metadata: { routeId: route.id, active: route.ativo },
  });

  const bot = botRegistry.get(route.workflow_id);
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

async function findRouteOrStartapFallback(
  telefone: string,
  sessao: string,
): Promise<RoutingRow | null> {
  if (isStartapSession(sessao)) {
    const active = await flowControl.isFlowActive(STARTAP_WORKFLOW_ID);
    if (!active) return null;
    return {
      id: 0,
      telefone,
      workflow_id: STARTAP_WORKFLOW_ID,
      workflow_name: STARTAP_WORKFLOW_NAME,
      webhook_url: null,
      nome_cliente: null,
      ativo: true,
      criado_em: new Date(),
      atualizado_em: new Date(),
    };
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

  if (!texto && payload?.hasMedia && payload?.media?.mimetype?.startsWith('audio/')) {
    try {
      const audio = await waha.downloadMedia(payload.media.url ?? '');
      texto = await whisper.transcribe(audio, payload.media.mimetype);
      wasAudio = true;
      log.info({ telefone, len: texto.length }, 'Áudio transcrito');
    } catch (e) {
      log.error({ err: e }, 'Falha ao transcrever áudio');
      texto = '[áudio não transcrito]';
    }
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
