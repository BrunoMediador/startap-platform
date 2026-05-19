/**
 * Job close-stale-running — roda a cada 15 minutos.
 *
 * Fecha execuções presas em status='running' há mais de
 * CHAT_STALE_RUNNING_MAX_MINUTES minutos (default 30).
 *
 * Protege contra crashes de processo que ocorrem antes do
 * bot.finished(), impedindo que running_executions infle no painel.
 *
 * Conforme ADR 0010: croner over BullMQ.
 */
import { logger } from '@startap/core/logger';
import { flowExecutionLog } from '@startap/db';
import { config } from '../config.js';

const log = logger.child({ job: 'close-stale-running' });

const MAX_AGE_MINUTES = Math.max(1, config.CHAT_STALE_RUNNING_MAX_MINUTES);

export interface CloseStaleResult extends Record<string, unknown> {
  closed: number;
  maxAgeMinutes: number;
}

export async function runCloseStaleRunning(): Promise<CloseStaleResult> {
  const closed = await flowExecutionLog.closeStaleRunning(MAX_AGE_MINUTES);
  if (closed > 0) {
    log.warn({ closed, maxAgeMinutes: MAX_AGE_MINUTES }, 'Execuções presas em running fechadas');
  }
  return { closed, maxAgeMinutes: MAX_AGE_MINUTES };
}
