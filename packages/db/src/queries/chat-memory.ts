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

// ── Retenção por IDADE (SCRUM-136, LGPD) ─────────────────────────────────────
// Diferente do prune por QUANTIDADE (pruneAllHistories = memória do bot, últimas N
// por sessão): aqui removemos conversa VELHA. Fonte de idade = coluna created_at
// (migration 076, DEFAULT now() — linhas pré-existentes ficam carimbadas na hora da
// migration, então só envelhecem depois; conservador de propósito).

export interface AgeRetentionResult {
  /** Nome da tabela (sem PII). */
  table: string;
  /** Linhas que a política MARCA para remoção (o que a dry-run mostra). */
  matched: number;
  /** Linhas EFETIVAMENTE apagadas (0 quando dryRun). */
  deleted: number;
}

/**
 * Descobre TODAS as tabelas de histórico de chat a partir do catálogo do Postgres —
 * inclusive tabelas ÓRFÃS de clones já excluídos (caso Seven 7), que não aparecem em
 * flow_clones. Filtra pelo mesmo padrão seguro de nome (defesa contra SQL injection).
 * Usa current_schema() para respeitar o search_path (isolamento das suítes de integração).
 */
export async function listChatTablesFromCatalog(): Promise<string[]> {
  const r = await query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = current_schema()
       AND tablename ~ '^chat_histories(_[a-z0-9_]+)?$'
     ORDER BY tablename`,
    [],
  );
  return r.rows.map((row) => row.tablename).filter(isValidChatTableName);
}

/**
 * Predicado de retenção por idade (compartilhado por count e delete):
 *   apaga linha ANTIGA (created_at < cutoff) SE
 *     - a SESSÃO está morta (última msg da sessão também < cutoff) → remove a conversa velha INTEIRA; OU
 *     - a sessão está ATIVA mas a linha está ALÉM das últimas `keep` (id DESC) → memória do bot preservada.
 * Ou seja: sessão ativa NUNCA perde as últimas `keep` mensagens, mesmo que sejam velhas
 * (cliente que conversa devagar há meses). A retenção é ADICIONAL ao prune por quantidade.
 */
function ageRetentionRankedCte(table: string): string {
  return `SELECT id,
                 (created_at < $1) AS is_old,
                 ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY id DESC) AS rn,
                 (MAX(created_at) OVER (PARTITION BY session_id) < $1) AS session_dead
          FROM ${table}`;
}

/**
 * Aplica a retenção por idade numa tabela. `dryRun=true` só CONTA (não apaga).
 * @param cutoff data-limite: mensagens com created_at < cutoff são candidatas.
 * @param keep   últimas N mensagens por sessão a preservar em sessões ativas.
 */
export async function applyAgeRetention(
  table: string,
  cutoff: Date,
  keep: number,
  opts: { dryRun: boolean },
): Promise<AgeRetentionResult> {
  if (!isKnownChatTable(table)) throw new Error(`Tabela inválida: ${table}`);
  const safeKeep = Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : 50;

  if (opts.dryRun) {
    const r = await query<{ matched: string }>(
      `SELECT count(*)::bigint AS matched
       FROM ( ${ageRetentionRankedCte(table)} ) ranked
       WHERE is_old AND (session_dead OR rn > $2)`,
      [cutoff, safeKeep],
    );
    return { table, matched: Number(r.rows[0]?.matched ?? 0), deleted: 0 };
  }

  const r = await query(
    `DELETE FROM ${table}
     WHERE id IN (
       SELECT id
       FROM ( ${ageRetentionRankedCte(table)} ) ranked
       WHERE is_old AND (session_dead OR rn > $2)
     )`,
    [cutoff, safeKeep],
  );
  const deleted = r.rowCount ?? 0;
  return { table, matched: deleted, deleted };
}

// Tabelas canônicas de histórico de chat. Clones ativos são listados
// dinamicamente via getDynamicChatTables() (flow_clones.chat_table).
// As 3 entradas com typo (controle_de_pause/ee/eee) foram removidas em
// 2026-05-19: nunca foram criadas via migration e não existem em prod.
const KNOWN_CHAT_TABLES = new Set([
  'chat_histories',
  'chat_histories_ricardo',
  'chat_histories_vendas_barbearia',
  'chat_histories_startap',
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
