import { query } from '../client.js';

/**
 * Memória de chat persistente (substitui o memoryPostgresChat do n8n LangChain).
 *
 * Cada bot/projeto tem sua própria tabela:
 *   n8n_chat_histories (default)
 *   n8n_chat_histories_ricardo
 *   n8n_chat_histories_startap
 *   n8n_chat_histories_controle_de_pause
 *
 * Estrutura da tabela LangChain n8n:
 *   id SERIAL PRIMARY KEY
 *   session_id TEXT  (geralmente o telefone)
 *   message JSONB    ({ type: 'human' | 'ai' | 'system', data: { content, ... } })
 */

export type Role = 'human' | 'ai' | 'system';

export interface ChatTurn {
  role: Role;
  content: string;
}

/** Carrega últimas N mensagens (mais antigas primeiro, para enviar como contexto). */
export async function loadHistory(
  table: string,
  sessionId: string,
  limit = 30,
): Promise<ChatTurn[]> {
  if (!isKnownChatTable(table)) throw new Error(`Tabela inválida: ${table}`);
  const r = await query<{ message: { type: Role; data: { content: string } } }>(
    `SELECT message FROM ${table}
     WHERE session_id = $1
     ORDER BY id DESC
     LIMIT $2`,
    [sessionId, limit],
  );
  return r.rows
    .reverse()
    .map((x) => ({ role: x.message.type, content: x.message.data.content }));
}

export async function appendMessage(
  table: string,
  sessionId: string,
  role: Role,
  content: string,
): Promise<void> {
  if (!isKnownChatTable(table)) throw new Error(`Tabela inválida: ${table}`);
  await query(
    `INSERT INTO ${table} (session_id, message) VALUES ($1, $2)`,
    [sessionId, JSON.stringify({ type: role, data: { content } })],
  );
}

/** Limpa histórico (mantém só últimas N entradas) — usado pelo cleanup job. */
export async function pruneHistory(
  table: string,
  sessionId: string,
  keep = 50,
): Promise<number> {
  if (!isKnownChatTable(table)) throw new Error(`Tabela inválida: ${table}`);
  const r = await query(
    `DELETE FROM ${table}
     WHERE session_id = $1 AND id NOT IN (
       SELECT id FROM ${table} WHERE session_id = $1 ORDER BY id DESC LIMIT $2
     )`,
    [sessionId, keep],
  );
  return r.rowCount ?? 0;
}

const KNOWN_CHAT_TABLES = new Set([
  'n8n_chat_histories',
  'n8n_chat_histories_ricardo',
  'n8n_chat_histories_startap',
  'n8n_chat_histories_controle_de_pause',
  'n8n_chat_histories_controle_de_pausee',
  'n8n_chat_histories_controle_de_pauseee',
]);

function isKnownChatTable(table: string): boolean {
  return KNOWN_CHAT_TABLES.has(table);
}
