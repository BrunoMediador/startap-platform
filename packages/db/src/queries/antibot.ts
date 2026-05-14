import { query } from '../client.js';

/**
 * Antibot (substitui Monitor_AntiBot do n8n).
 *
 * Detecta números que enviam >10 mensagens em 60 segundos e os bloqueia
 * inserindo na tabela bot_pausa.
 *
 * Tabelas relacionadas:
 *   message_log - log de mensagens (created_at timestamp, telefone TEXT)
 *   bot_pausa   - lista de bloqueio automático
 */

export async function logMessage(telefone: string, sessao: string): Promise<void> {
  await query(
    `INSERT INTO message_log (telefone, sessao, created_at) VALUES ($1, $2, NOW())`,
    [telefone, sessao],
  );
}

export interface SuspectRow {
  telefone: string;
  total: number;
}

/** Retorna telefones que enviaram > threshold mensagens nos últimos N segundos. */
export async function findSuspects(
  thresholdCount = 10,
  windowSeconds = 60,
): Promise<SuspectRow[]> {
  const r = await query<{ telefone: string; total: string }>(
    `SELECT telefone, COUNT(*)::text AS total
     FROM message_log
     WHERE created_at > NOW() - ($1 || ' seconds')::INTERVAL
     GROUP BY telefone
     HAVING COUNT(*) > $2`,
    [String(windowSeconds), thresholdCount],
  );
  return r.rows.map((x) => ({ telefone: x.telefone, total: Number(x.total) }));
}

/** Limpa logs antigos (mantém só últimas X horas). */
export async function pruneOldLogs(hoursToKeep = 24): Promise<number> {
  const r = await query(
    `DELETE FROM message_log WHERE created_at < NOW() - ($1 || ' hours')::INTERVAL`,
    [String(hoursToKeep)],
  );
  return r.rowCount ?? 0;
}
