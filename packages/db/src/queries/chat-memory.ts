import { query } from '../client.js';

/**
 * Memória de chat persistente (substitui o memoryPostgresChat do LangChain legado).
 *
 * Cada bot/projeto tem sua própria tabela:
 *   chat_histories (default)
 *   chat_histories_ricardo
 *   chat_histories_vendas_barbearia
 *   chat_histories_startap
 *   chat_histories_controle_de_pause
 *
 * Estrutura da tabela LangChain legado:
 *   id SERIAL PRIMARY KEY
 *   session_id TEXT  (geralmente o telefone)
 *   message JSONB    ({ type: 'human' | 'ai' | 'system', data: { content, ... } })
 */

export type Role = 'human' | 'ai' | 'system';

export interface ChatTurn {
  role: Role;
  content: string;
}

interface RawChatMessage {
  type?: Role;
  data?: { content?: unknown };
  content?: unknown;
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
    .map((x) => parseChatMessage(x.message))
    .filter((turn): turn is ChatTurn => turn !== null);
}

function parseChatMessage(message: RawChatMessage | null): ChatTurn | null {
  if (!message || !message.type) return null;
  const content = message.data?.content ?? message.content;
  if (typeof content !== 'string') return null;
  if (!['human', 'ai', 'system'].includes(message.type)) return null;
  return { role: message.type, content };
}

export async function appendMessage(
  table: string,
  sessionId: string,
  role: Role,
  content: string,
): Promise<void> {
  if (!isKnownChatTable(table)) throw new Error(`Tabela inválida: ${table}`);
  await query(`INSERT INTO ${table} (session_id, message) VALUES ($1, $2)`, [
    sessionId,
    JSON.stringify({ type: role, data: { content } }),
  ]);
}

/** Limpa histórico (mantém só últimas N entradas) — usado pelo cleanup job. */
export async function pruneHistory(table: string, sessionId: string, keep = 50): Promise<number> {
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

export async function pruneAllHistories(table: string, keep = 50): Promise<number> {
  if (!isKnownChatTable(table)) throw new Error(`Tabela inválida: ${table}`);
  const r = await query(
    `DELETE FROM ${table}
     WHERE id IN (
       SELECT id
       FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY id DESC) AS row_num
         FROM ${table}
       ) ranked
       WHERE row_num > $1
     )`,
    [keep],
  );
  return r.rowCount ?? 0;
}

export function listKnownChatTables(): string[] {
  return [...KNOWN_CHAT_TABLES];
}

const KNOWN_CHAT_TABLES = new Set([
  'chat_histories',
  'chat_histories_ricardo',
  'chat_histories_vendas_barbearia',
  'chat_histories_startap',
  'chat_histories_controle_de_pause',
  'chat_histories_controle_de_pausee',
  'chat_histories_controle_de_pauseee',
]);

/** Aceita chat_histories ou chat_histories_<sufixo alfanumérico>. Defesa contra SQL injection. */
export function isValidChatTableName(table: string): boolean {
  return /^chat_histories(_[a-z0-9_]+)?$/.test(table);
}

/** Tabelas de clones ativos registradas em flow_clones.chat_table. */
export async function getDynamicChatTables(): Promise<string[]> {
  const r = await query<{ chat_table: string }>(
    `SELECT DISTINCT chat_table FROM flow_clones WHERE chat_table IS NOT NULL AND status = 'active'`,
    [],
  );
  return r.rows.map((row) => row.chat_table).filter(isValidChatTableName);
}

/** União de tabelas estáticas conhecidas + tabelas de clones ativos. */
export async function listAllChatTables(): Promise<string[]> {
  const dynamic = await getDynamicChatTables();
  const merged = new Set([...KNOWN_CHAT_TABLES, ...dynamic]);
  return [...merged];
}

function isKnownChatTable(table: string): boolean {
  // Valida tanto contra o set estático quanto contra o padrão de nome seguro,
  // pois loadHistory/appendMessage/pruneHistory são chamados em runtime com a
  // tabela já resolvida (pode vir de um clone dinâmico).
  return KNOWN_CHAT_TABLES.has(table) || isValidChatTableName(table);
}
