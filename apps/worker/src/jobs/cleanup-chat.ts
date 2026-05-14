/**
 * Job de limpeza de historico de chat — roda a cada 12h.
 *
 * Substitui Limpar_Historico_Chat do n8n. Replica comportamento literal:
 * apaga TUDO da tabela n8n_chat_histories (usada pela Barbearia Cirilo).
 * As outras tabelas (_ricardo, _startap, _controle_de_pauseee) NAO sao limpas.
 */
import { logger } from '@startap/core/logger';
import { query } from '@startap/db';

const log = logger.child({ job: 'cleanup-chat' });

export async function runCleanupChat(): Promise<{ deleted: number }> {
  try {
    const r = await query('DELETE FROM n8n_chat_histories');
    const deleted = r.rowCount ?? 0;
    if (deleted > 0) log.info({ deleted }, 'n8n_chat_histories limpo');
    return { deleted };
  } catch (e) {
    log.error({ err: e }, 'cleanup-chat falhou');
    return { deleted: 0 };
  }
}
