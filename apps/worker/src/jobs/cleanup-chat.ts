/**
 * Job de limpeza de histórico de chat — roda a cada 1h.
 *
 * Itera todas as tabelas conhecidas + tabelas de clones ativos registradas
 * em flow_clones.chat_table, mantendo memória curta por sessão.
 */
import { logger } from '@startap/core/logger';
import { chatMemory } from '@startap/db';

const log = logger.child({ job: 'cleanup-chat' });
const DEFAULT_KEEP = Number.parseInt(process.env.CHAT_MEMORY_RETENTION ?? '50', 10);

export interface CleanupResult extends Record<string, unknown> {
  deleted: number;
  tables: number;
  per_table: Record<string, number>;
}

export async function runCleanupChat(keepOverride?: number): Promise<CleanupResult> {
  const keep =
    keepOverride ?? (Number.isFinite(DEFAULT_KEEP) && DEFAULT_KEEP > 0 ? DEFAULT_KEEP : 50);

  let deleted = 0;
  const per_table: Record<string, number> = {};

  let tables: string[];
  try {
    tables = await chatMemory.listAllChatTables();
  } catch (e) {
    log.error({ err: e }, 'Falha ao listar tabelas de chat');
    return { deleted: 0, tables: 0, per_table: {} };
  }

  for (const table of tables) {
    const tableDeleted = await chatMemory.pruneAllHistories(table, keep).catch((err: unknown) => {
      // Tabela de clone ainda não criada em produção: warning, não para o loop.
      log.warn({ err, table }, 'Falha ao podar tabela de memória — tabela pode não existir');
      return 0;
    });
    if (tableDeleted > 0) {
      per_table[table] = tableDeleted;
      deleted += tableDeleted;
    }
  }

  log.info(
    { tables: tables.length, total_deleted: deleted, per_table },
    `[cleanup] tables=${tables.length} total_deleted=${deleted} per_table=${JSON.stringify(per_table)}`,
  );

  return { deleted, tables: tables.length, per_table };
}
