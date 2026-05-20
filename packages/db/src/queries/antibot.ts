import { query } from '../client.js';

/**
 * Antibot (substitui Monitor_AntiBot do automação visual antiga).
 *
 * Detecta numeros que enviam 6+ mensagens em 60 segundos e os bloqueia
 * inserindo na tabela bot_pausa.
 *
 * Tabela real:
 *   message_log (id, phone, chat_id, created_at)
 */

export async function logMessage(telefone: string, sessao: string): Promise<void> {
  await query('INSERT INTO message_log (phone, chat_id, created_at) VALUES ($1, $2, NOW())', [
    telefone,
    sessao,
  ]);
}

export interface SuspectRow {
  telefone: string;
  total: number;
  /** Sessão WAHA — valor de message_log.chat_id. Usado para resolver flow_id via bot_config. */
  session: string;
}

export async function findSuspects(thresholdCount = 6, windowSeconds = 60): Promise<SuspectRow[]> {
  const r = await query<{ phone: string; total: string; chat_id: string }>(
    `SELECT phone, chat_id, COUNT(*)::text AS total
     FROM message_log
     WHERE created_at > NOW() - ($1 || ' seconds')::INTERVAL
     GROUP BY phone, chat_id
     HAVING COUNT(*) >= $2`,
    [String(windowSeconds), thresholdCount],
  );
  return r.rows.map((x) => ({ telefone: x.phone, total: Number(x.total), session: x.chat_id }));
}

export async function pruneOldLogs(hoursToKeep = 24): Promise<number> {
  const r = await query(
    "DELETE FROM message_log WHERE created_at < NOW() - ($1 || ' hours')::INTERVAL",
    [String(hoursToKeep)],
  );
  return r.rowCount ?? 0;
}

/**
 * Remove entradas antigas de bot_pausa (já desbloqueadas ou ativas há muito tempo).
 * Requer coluna created_at adicionada em migration 025.
 * Controlado por BOT_PAUSA_RETENTION_DAYS (default 30).
 */
export async function pruneOldBotPausa(daysToKeep = 30): Promise<number> {
  const r = await query(
    "DELETE FROM bot_pausa WHERE created_at < NOW() - ($1 || ' days')::INTERVAL",
    [String(daysToKeep)],
  );
  return r.rowCount ?? 0;
}
