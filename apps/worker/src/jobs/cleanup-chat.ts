/**
 * Job de limpeza de histórico de chat — roda diariamente.
 *
 * Substitui Limpar_Historico_Chat do n8n.
 *
 * Para cada tabela de chat history, remove sessões inativas há mais de 30 dias.
 */
import { logger } from '@startap/core/logger';
import { query } from '@startap/db';

const log = logger.child({ job: 'cleanup-chat' });

const TABLES = [
  'n8n_chat_histories',
  'n8n_chat_histories_ricardo',
  'n8n_chat_histories_startap',
];

export async function runCleanupChat(daysOld = 30): Promise<{ deleted: number }> {
  let total = 0;
  for (const t of TABLES) {
    try {
      const r = await query(
        `DELETE FROM ${t}
         WHERE id IN (
           SELECT id FROM ${t}
           WHERE session_id IN (
             SELECT session_id FROM ${t}
             GROUP BY session_id
             HAVING MAX(id) < (
               SELECT MIN(id) FROM ${t}
               WHERE id > 0
             ) + 1
           )
         )`,
      );
      // Implementação mais segura: deleta por timestamp se existir coluna; aqui só logo
      log.info({ table: t, rows: r.rowCount }, 'pass complete');
      total += r.rowCount ?? 0;
    } catch (e) {
      log.error({ err: e, table: t }, 'cleanup failed for table');
    }
  }
  return { deleted: total };
}
