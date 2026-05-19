import { randomUUID } from 'node:crypto';
import { logger } from '@startap/core/logger';
import { flowExecutionLog } from '@startap/db';
/**
 * Worker — roda cron jobs.
 *
 * Substitui as triggers Schedule do automação visual antiga.
 */
import { Cron } from 'croner';
import { runAntibot } from './jobs/antibot.js';
import { runCleanupChat } from './jobs/cleanup-chat.js';
import { runCloseStaleRunning } from './jobs/close-stale-running.js';

const log = logger.child({ service: 'worker' });

async function main() {
  log.info('Worker startup');

  // Antibot: cada 1 minuto
  new Cron('* * * * *', { name: 'antibot' }, async () => {
    const executionId = randomUUID();
    const startedAt = Date.now();
    let jobResult: Awaited<ReturnType<typeof runAntibot>> | null = null;
    let jobError: unknown = null;
    await flowExecutionLog.logFlowEvent({
      executionId,
      flowId: 'worker:antibot',
      flowName: 'antibot',
      bot: 'worker',
      eventType: 'worker.job-started',
      status: 'running',
      message: 'Job antibot iniciado',
    });
    try {
      jobResult = await runAntibot();
      if (jobResult.blocked > 0) log.info({ ...jobResult }, 'antibot cycle');
    } catch (e) {
      jobError = e;
      log.error({ err: e }, 'antibot crashed');
    } finally {
      // Garante INSERT do status final mesmo que runAntibot lance exceção não capturada.
      await flowExecutionLog.logFlowEvent({
        executionId,
        flowId: 'worker:antibot',
        flowName: 'antibot',
        bot: 'worker',
        eventType: jobError ? 'worker.job-failed' : 'worker.job-finished',
        status: jobError ? 'error' : 'success',
        message: jobError ? 'Job antibot falhou' : 'Job antibot concluído',
        ...(jobResult ? { metadata: jobResult } : {}),
        ...(jobError ? { error: jobError } : {}),
        durationMs: Date.now() - startedAt,
      });
    }
  });

  // Cleanup: a cada 1 hora — cobre clones ativos que antes ficavam 12h sem limpar
  new Cron('0 * * * *', { name: 'cleanup-chat', timezone: 'America/Sao_Paulo' }, async () => {
    const executionId = randomUUID();
    const startedAt = Date.now();
    let cleanupResult: Awaited<ReturnType<typeof runCleanupChat>> | null = null;
    let cleanupError: unknown = null;
    await flowExecutionLog.logFlowEvent({
      executionId,
      flowId: 'worker:cleanup-chat',
      flowName: 'cleanup-chat',
      bot: 'worker',
      eventType: 'worker.job-started',
      status: 'running',
      message: 'Job cleanup-chat iniciado',
    });
    try {
      cleanupResult = await runCleanupChat();
      log.info({ ...cleanupResult }, 'cleanup cycle');
      const prunedLogs = await flowExecutionLog.pruneOldFlowEvents(14);
      // Fecha execuções presas em running há mais de 5 minutos (safety net).
      const closedStale = await flowExecutionLog.closeStaleRunning(5);
      if (closedStale > 0) log.warn({ closedStale }, 'Execuções presas em running fechadas');
      Object.assign(cleanupResult as object, { prunedFlowLogs: prunedLogs, closedStale });
    } catch (e) {
      cleanupError = e;
      log.error({ err: e }, 'cleanup crashed');
    } finally {
      // Garante INSERT do status final mesmo que runCleanupChat lance exceção não capturada.
      await flowExecutionLog.logFlowEvent({
        executionId,
        flowId: 'worker:cleanup-chat',
        flowName: 'cleanup-chat',
        bot: 'worker',
        eventType: cleanupError ? 'worker.job-failed' : 'worker.job-finished',
        status: cleanupError ? 'error' : 'success',
        message: cleanupError ? 'Job cleanup-chat falhou' : 'Job cleanup-chat concluído',
        ...(cleanupResult ? { metadata: cleanupResult } : {}),
        ...(cleanupError ? { error: cleanupError } : {}),
        durationMs: Date.now() - startedAt,
      });
    }
  });

  // Close-stale-running: a cada 15 min — fecha execs presas em running > CHAT_STALE_RUNNING_MAX_MINUTES (default 30)
  new Cron('*/15 * * * *', { name: 'close-stale-running' }, async () => {
    const executionId = randomUUID();
    const startedAt = Date.now();
    let staleResult: Awaited<ReturnType<typeof runCloseStaleRunning>> | null = null;
    let staleError: unknown = null;
    await flowExecutionLog.logFlowEvent({
      executionId,
      flowId: 'worker:close-stale-running',
      flowName: 'close-stale-running',
      bot: 'worker',
      eventType: 'worker.job-started',
      status: 'running',
      message: 'Job close-stale-running iniciado',
    });
    try {
      staleResult = await runCloseStaleRunning();
      if (staleResult.closed > 0) log.warn({ ...staleResult }, 'close-stale-running cycle');
    } catch (e) {
      staleError = e;
      log.error({ err: e }, 'close-stale-running crashed');
    } finally {
      await flowExecutionLog.logFlowEvent({
        executionId,
        flowId: 'worker:close-stale-running',
        flowName: 'close-stale-running',
        bot: 'worker',
        eventType: staleError ? 'worker.job-failed' : 'worker.job-finished',
        status: staleError ? 'error' : 'success',
        message: staleError ? 'Job close-stale-running falhou' : 'Job close-stale-running concluído',
        ...(staleResult ? { metadata: staleResult } : {}),
        ...(staleError ? { error: staleError } : {}),
        durationMs: Date.now() - startedAt,
      });
    }
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log.info({ sig }, 'shutdown');
      process.exit(0);
    });
  }
}

main().catch((e) => {
  log.error({ err: e }, 'fatal');
  process.exit(1);
});
