/**
 * Job de limpeza de historico de chat — roda a cada 12h.
 *
 * Mantem a memoria curta por sessao em todas as tabelas conhecidas,
 * evitando crescimento indefinido e consumo desnecessario de contexto.
 */
import { logger } from '@startap/core/logger';
import { chatMemory } from '@startap/db';

const log = logger.child({ job: 'cleanup-chat' });
const DEFAULT_KEEP = Number.parseInt(process.env.CHAT_MEMORY_RETENTION ?? '50', 10);

export async function runCleanupChat(): Promise<{ deleted: number }> {
  const keep = Number.isFinite(DEFAULT_KEEP) && DEFAULT_KEEP > 0 ? DEFAULT_KEEP : 50;
  let deleted = 0;

  try {
    for (const table of chatMemory.listKnownChatTables()) {
      const tableDeleted = await chatMemory.pruneAllHistories(table, keep).catch((err) => {
        log.warn({ err, table }, 'Falha ao podar tabela de memoria');
        return 0;
      });
      deleted += tableDeleted;
      if (tableDeleted > 0) log.info({ table, deleted: tableDeleted, keep }, 'Memoria podada');
    }
    return { deleted };
  } catch (e) {
    log.error({ err: e }, 'cleanup-chat falhou');
    return { deleted: 0 };
  }
}
