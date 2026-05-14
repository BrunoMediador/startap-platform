import { query } from '../client.js';

/**
 * Antibot (substitui Monitor_AntiBot do n8n).
 *
 * Detecta numeros que enviam >10 mensagens em 60 segundos e os bloqueia
 * inserindo na tabela bot_pausa.
 *
 * Tabela real:
 *   message_log (id, phone, chat_id, created_at)
 */

export async function logMessage(telefone: string, sessao: string): Promise<void> {
  await query(
    'INSERT INTO message_log (phone, chat_id, created_at) VALUES ($1, $2, NOW())',
    [telefone, sessao],
  );
}

export interface SuspectRow {
  telefone: string;
  total: number;
}

export async function findSuspects(
  thresholdCount = 10,
  windowSeconds = 60,
): Promise<SuspectRow[]> {
  const r = await query<{ phone: string; total: string }>(
    `SELECT phone, COUNT(*)::text AS total
     FROM message_log
     WHERE created_at > NOW() - ($1 || ' seconds')::INTERVAL
     GROUP BY phone
     HAVING COUNT(*) > $2`,
    [String(windowSeconds), thresholdCount],
  );
  return r.rows.map((x) => ({ telefone: x.phone, total: Number(x.total) }));
}

export async function pruneOldLogs(hoursToKeep = 24): Promise<number> {
  const r = await query(
    "DELETE FROM message_log WHERE created_at < NOW() - ($1 || ' hours')::INTERVAL",
    [String(hoursToKeep)],
  );
  return r.rowCount ?? 0;
}
