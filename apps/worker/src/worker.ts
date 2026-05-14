/**
 * Worker — roda cron jobs.
 *
 * Substitui as triggers Schedule do n8n (Monitor_AntiBot a cada 1min,
 * Limpar_Historico_Chat diário, RELATORIO_BARBEARIA_SAMUEL etc).
 *
 * Usa `croner` para cron schedules. BullMQ pode ser adicionado depois pra
 * filas assíncronas / retry, mas pra cron simples isso basta.
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

  // Cleanup: todo dia 03:00 BRT
  new Cron(
    '0 3 * * *',
    { name: 'cleanup-chat', timezone: 'America/Sao_Paulo' },
    async () => {
      try {
        const r = await runCleanupChat(30);
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
