import { query } from '../client.js';

/**
 * As tabelas de pausa têm nomes diferentes por projeto:
 *   pausa_samuel, pausa_cirilo, pause_ricardo, pause_startap, bot_pausa, etc.
 *
 * Aqui parametrizamos a tabela para reuso. As mais usadas têm helpers dedicados.
 *
 * Convenção: o telefone é sempre salvo COM DDI (55...), conforme padrão antigo n8n.
 */

/** Verifica se um telefone está pausado. */
export async function isPaused(table: string, telefone: string): Promise<boolean> {
  // Whitelist de tabelas conhecidas para evitar SQL injection via parâmetro
  if (!isKnownPauseTable(table)) {
    throw new Error(`Tabela de pausa não permitida: ${table}`);
  }
  const r = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table} WHERE telefone = $1`,
    [telefone],
  );
  return Number(r.rows[0]?.count ?? 0) > 0;
}

export async function addPause(table: string, telefone: string): Promise<void> {
  if (!isKnownPauseTable(table)) throw new Error(`Tabela inválida: ${table}`);
  await query(
    `INSERT INTO ${table} (telefone) VALUES ($1) ON CONFLICT DO NOTHING`,
    [telefone],
  );
}

export async function removePause(table: string, telefone: string): Promise<void> {
  if (!isKnownPauseTable(table)) throw new Error(`Tabela inválida: ${table}`);
  await query(`DELETE FROM ${table} WHERE telefone = $1`, [telefone]);
}

export async function listPauses(table: string): Promise<string[]> {
  if (!isKnownPauseTable(table)) throw new Error(`Tabela inválida: ${table}`);
  const r = await query<{ telefone: string }>(
    `SELECT telefone FROM ${table} ORDER BY telefone`,
  );
  return r.rows.map((x) => x.telefone);
}

const KNOWN_PAUSE_TABLES = new Set([
  'pausa',
  'pausa_samuel',
  'pausa_samuel_dev',
  'pausa_cirilo',
  'pause_ricardo',
  'pause_startap',
  'bot_pausa',
]);

function isKnownPauseTable(table: string): boolean {
  return KNOWN_PAUSE_TABLES.has(table);
}
