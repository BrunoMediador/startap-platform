/**
 * Worker — roda cron jobs.
 *
 * Substitui as triggers Schedule do n8n.
 */
import { Cron } from 'croner';
import { logger } from '@startap/core/logger';
import { runAntibot } from './jobs/antibot.js';
import { runCleanupChat } from './jobs/cleanup-chat.js';

const log = logger.child({ service: 'worker' });

async function main() {
  log.info('Worker startup');

  // Antibot: cada 1 minuto
  new Cron('* * * * *', { name: 'antibot' }, async () => {
    try {
      const r = await runAntibot();
      if (r.blocked > 0) log.info({ ...r }, 'antibot cycle');
    } catch (e) {
      log.error({ err: e }, 'antibot crashed');
    }
  });

  // Cleanup: a cada 12 horas (replica n8n Limpar_Historico_Chat)
  new Cron(
    '0 */12 * * *',
    { name: 'cleanup-chat', timezone: 'America/Sao_Paulo' },
    async () => {
      try {
        const r = await runCleanupChat();
        log.info({ ...r }, 'cleanup cycle');
      } catch (e) {
        log.error({ err: e }, 'cleanup crashed');
      }
    },
  );

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
