import { randomUUID } from 'node:crypto';
import { logger } from '@startap/core/logger';
import { flowExecutionLog } from '@startap/db';
/**
 * Worker — roda cron jobs.
 *
 * Substitui as triggers Schedule do n8n.
 */
import { Cron } from 'croner';
import { runAntibot } from './jobs/antibot.js';
import { runCleanupChat } from './jobs/cleanup-chat.js';

const log = logger.child({ service: 'worker' });

async function main() {
  log.info('Worker startup');

  // Antibot: cada 1 minuto
  new Cron('* * * * *', { name: 'antibot' }, async () => {
    const executionId = randomUUID();
    const startedAt = Date.now();
    try {
      await flowExecutionLog.logFlowEvent({
        executionId,
        flowId: 'worker:antibot',
        flowName: 'antibot',
        bot: 'worker',
        eventType: 'worker.job-started',
        status: 'running',
        message: 'Job antibot iniciado',
      });
      const r = await runAntibot();
      if (r.blocked > 0) log.info({ ...r }, 'antibot cycle');
      await flowExecutionLog.logFlowEvent({
        executionId,
        flowId: 'worker:antibot',
        flowName: 'antibot',
        bot: 'worker',
        eventType: 'worker.job-finished',
        status: 'success',
        message: 'Job antibot concluído',
        metadata: r,
        durationMs: Date.now() - startedAt,
      });
    } catch (e) {
      log.error({ err: e }, 'antibot crashed');
      await flowExecutionLog.logFlowEvent({
        executionId,
        flowId: 'worker:antibot',
        flowName: 'antibot',
        bot: 'worker',
        eventType: 'worker.job-failed',
        status: 'error',
        message: 'Job antibot falhou',
        error: e,
        durationMs: Date.now() - startedAt,
      });
    }
  });

  // Cleanup: a cada 12 horas (replica n8n Limpar_Historico_Chat)
  new Cron('0 */12 * * *', { name: 'cleanup-chat', timezone: 'America/Sao_Paulo' }, async () => {
    const executionId = randomUUID();
    const startedAt = Date.now();
    try {
      await flowExecutionLog.logFlowEvent({
        executionId,
        flowId: 'worker:cleanup-chat',
        flowName: 'cleanup-chat',
        bot: 'worker',
        eventType: 'worker.job-started',
        status: 'running',
        message: 'Job cleanup-chat iniciado',
      });
      const r = await runCleanupChat();
      log.info({ ...r }, 'cleanup cycle');
      const prunedLogs = await flowExecutionLog.pruneOldFlowEvents(14);
      await flowExecutionLog.logFlowEvent({
        executionId,
        flowId: 'worker:cleanup-chat',
        flowName: 'cleanup-chat',
        bot: 'worker',
        eventType: 'worker.job-finished',
        status: 'success',
        message: 'Job cleanup-chat concluído',
        metadata: { ...r, prunedFlowLogs: prunedLogs },
        durationMs: Date.now() - startedAt,
      });
    } catch (e) {
      log.error({ err: e }, 'cleanup crashed');
      await flowExecutionLog.logFlowEvent({
        executionId,
        flowId: 'worker:cleanup-chat',
        flowName: 'cleanup-chat',
        bot: 'worker',
        eventType: 'worker.job-failed',
        status: 'error',
        message: 'Job cleanup-chat falhou',
        error: e,
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
