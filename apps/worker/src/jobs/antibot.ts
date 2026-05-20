/**
 * Job antibot — roda a cada 1 minuto.
 *
 * Substitui Monitor_AntiBot do automação visual antiga.
 *
 * Detecta números enviando 6+ mensagens em 60s, insere em bot_pausa,
 * grava em flow_pauses (source=antibot) e notifica dev + dono via WhatsApp.
 */
import { logger } from '@startap/core/logger';
import { toChatId } from '@startap/core/phone';
import { antibot, pausa } from '@startap/db';
import { waha } from '@startap/integrations';
import { config } from '../config.js';

const log = logger.child({ job: 'antibot' });

const THRESHOLD = 6; // mensagens (>= dispara pausa)
const WINDOW_SEC = 60;
const ALERT_DEV = config.ALERT_DEV_PHONE ?? '';
const ALERT_OWNER = config.ALERT_OWNER_PHONE ?? '';
const ALERT_SESSION = config.ALERT_SESSION;

export async function runAntibot(): Promise<{ blocked: number; pruned: number }> {
  const suspects = await antibot.findSuspects(THRESHOLD, WINDOW_SEC);
  let blocked = 0;

  for (const s of suspects) {
    log.warn(
      { telefone: s.telefone, total: s.total, session: s.session },
      'Suspeito bot detectado',
    );
    await pausa.addPause('bot_pausa', s.telefone);
    blocked++;

    // Dupla gravação: registra pausa também em flow_pauses para gates por fluxo
    const flowId = await pausa.findFlowIdBySession(s.session);
    if (flowId) {
      await pausa.addFlowPause({
        flowId,
        telefone: s.telefone,
        session: s.session,
        source: 'antibot',
        reason: `flood: ${s.total} msgs em ${WINDOW_SEC}s`,
      });
    } else {
      log.warn(
        { session: s.session, telefone: s.telefone },
        'antibot: flow_id nao encontrado para session — gravando apenas em bot_pausa',
      );
    }

    const msg = `🤖 *BOT DETECTADO — AntiBot*\n\nO número \`${s.telefone}\` foi bloqueado automaticamente por enviar ${s.total} mensagens em ${WINDOW_SEC}s.\n\nInserido na lista de pausa.`;

    if (ALERT_DEV) {
      await waha
        .sendText({ sessao: ALERT_SESSION, chatId: toChatId(ALERT_DEV), texto: msg, typing: false })
        .catch((e) => log.error(e, 'failed to alert dev'));
    }
    if (ALERT_OWNER && ALERT_OWNER !== ALERT_DEV) {
      await waha
        .sendText({
          sessao: ALERT_SESSION,
          chatId: toChatId(ALERT_OWNER),
          texto: msg,
          typing: false,
        })
        .catch((e) => log.error(e, 'failed to alert owner'));
    }
  }

  // Limpa logs com mais de 24h
  const pruned = await antibot.pruneOldLogs(24);
  if (blocked > 0 || pruned > 0) log.info({ blocked, pruned }, 'Antibot pass complete');
  return { blocked, pruned };
}
