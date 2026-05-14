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
import { antibot, pausa, routing } from '@startap/db';
import { waha, whisper } from '@startap/integrations';

const log = logger.child({ module: 'router' });

/** Mapa em memória dos bots disponíveis — key = workflow_id em routing_clientes. */
const botRegistry = new Map<string, Bot>();

export function registerBot(workflowId: string, bot: Bot): void {
  botRegistry.set(workflowId, bot);
  log.info({ workflowId, bot: bot.name }, 'Bot registrado');
}

/** Entry point — chamado pela rota /webhooks/waha. */
export async function handleWebhook(body: WahaWebhookBody): Promise<{ status: string }> {
  // 1. Ignora mensagens enviadas pelo próprio bot
  if (body.payload?.fromMe) return { status: 'ignored:fromMe' };

  // 2. Ignora eventos não-mensagem
  if (!['message', 'message.any'].includes(body.event)) return { status: 'ignored:event' };

  // 3. Extrai telefone real
  const telefone = extractPhone(body);
  if (!telefone) {
    log.warn({ payload: body.payload }, 'Não foi possível extrair telefone');
    return { status: 'ignored:no-phone' };
  }

  const sessao = body.session;
  const chatId = body.payload?.from ?? '';

  // 4. Log para antibot
  await antibot.logMessage(telefone, sessao).catch((e) => log.warn(e, 'log msg failed'));

  // 5. Antibot: se está em bot_pausa, ignora
  const isBlocked = await pausa.isPaused('bot_pausa', telefone).catch(() => false);
  if (isBlocked) {
    log.info({ telefone }, 'Número em bot_pausa, ignorando');
    return { status: 'ignored:bot-pausa' };
  }

  // 6. Busca rota
  const route = await routing.findRouting(telefone);
  if (!route) {
    log.debug({ telefone, sessao }, 'Telefone sem roteamento configurado');
    return { status: 'ignored:no-routing' };
  }

  const bot = botRegistry.get(route.workflow_id);
  if (!bot) {
    log.warn({ workflowId: route.workflow_id, telefone }, 'Bot não encontrado no registry');
    return { status: 'error:bot-not-registered' };
  }

  // 7. Constrói mensagem normalizada
  const message = await buildIncomingMessage({ body, telefone, sessao, chatId });

  // 8. Marca como lida + processa
  await waha.sendSeen(sessao, chatId).catch(() => {});

  const ctx: BotContext = { message };
  try {
    await bot.handle(ctx);
    log.info({ bot: bot.name, telefone }, 'Mensagem processada');
    return { status: 'ok' };
  } catch (e) {
    log.error({ err: e, bot: bot.name, telefone }, 'Bot falhou');
    return { status: 'error:bot-failed' };
  }
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
