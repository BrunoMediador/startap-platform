/**
 * Job de limpeza de bot_pausa — roda a cada 1h junto com cleanup-chat.
 *
 * Remove entradas com created_at < now() - BOT_PAUSA_RETENTION_DAYS dias.
 * Requer migration 025 (ADD COLUMN created_at em bot_pausa).
 *
 * BOT_PAUSA_RETENTION_DAYS: dias de retenção (default 30).
 */
import { logger } from '@startap/core/logger';
import { antibot } from '@startap/db';

const log = logger.child({ job: 'cleanup-bot-pausa' });
const DEFAULT_DAYS = Number.parseInt(process.env.BOT_PAUSA_RETENTION_DAYS ?? '30', 10);

export interface CleanupBotPausaResult extends Record<string, unknown> {
  deleted: number;
}

export async function runCleanupBotPausa(daysOverride?: number): Promise<CleanupBotPausaResult> {
  const days =
    daysOverride ?? (Number.isFinite(DEFAULT_DAYS) && DEFAULT_DAYS > 0 ? DEFAULT_DAYS : 30);

  const deleted = await antibot.pruneOldBotPausa(days).catch((err: unknown) => {
    log.error({ err }, 'Falha ao limpar bot_pausa — migration 025 aplicada?');
    return 0;
  });

  if (deleted > 0) {
    log.info({ deleted, days }, `[cleanup-bot-pausa] deleted=${deleted} retention=${days}d`);
  }

  return { deleted };
}
