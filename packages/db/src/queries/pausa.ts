import { query } from '../client.js';

/**
 * Tabelas de pausa por projeto, com colunas distintas:
 *   pausa_samuel, pausa_samuel_dev, pausa_cirilo, pause_ricardo, pause_startap → col `numero`
 *   bot_pausa → col `numero_cliente` + flag `pausado` boolean
 *   pausa (legacy) → col `chat_id`
 *
 * Telefone é salvo COM DDI (55...).
 */

interface TableSpec {
  col: string;
  /** Para tabelas com flag booleana de pausa ativo. */
  pausedFlag?: { name: string; value: boolean };
}

const TABLES: Record<string, TableSpec> = {
  pausa: { col: 'chat_id' },
  pausa_samuel: { col: 'numero' },
  pausa_samuel_dev: { col: 'numero' },
  pausa_cirilo: { col: 'numero' },
  pause_ricardo: { col: 'numero' },
  pause_startap: { col: 'numero' },
  bot_pausa: { col: 'numero_cliente', pausedFlag: { name: 'pausado', value: true } },
};

function getSpec(table: string): TableSpec {
  const spec = TABLES[table];
  if (!spec) throw new Error(`Tabela de pausa não permitida: ${table}`);
  return spec;
}

export async function isPaused(table: string, telefone: string): Promise<boolean> {
  const { col, pausedFlag } = getSpec(table);
  const where = pausedFlag
    ? `${col} = $1 AND ${pausedFlag.name} = ${pausedFlag.value}`
    : `${col} = $1`;
  const r = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table} WHERE ${where}`,
    [telefone],
  );
  return Number(r.rows[0]?.count ?? 0) > 0;
}

export async function addPause(table: string, telefone: string): Promise<void> {
  const { col, pausedFlag } = getSpec(table);
  if (pausedFlag) {
    await query(
      `INSERT INTO ${table} (${col}, ${pausedFlag.name}) VALUES ($1, ${pausedFlag.value})
       ON CONFLICT (${col}) DO UPDATE SET ${pausedFlag.name} = ${pausedFlag.value}`,
      [telefone],
    );
  } else {
    await query(`INSERT INTO ${table} (${col}) VALUES ($1) ON CONFLICT DO NOTHING`, [telefone]);
  }
}

export async function removePause(table: string, telefone: string): Promise<void> {
  const { col, pausedFlag } = getSpec(table);
  if (pausedFlag) {
    await query(`UPDATE ${table} SET ${pausedFlag.name} = ${!pausedFlag.value} WHERE ${col} = $1`, [
      telefone,
    ]);
  } else {
    await query(`DELETE FROM ${table} WHERE ${col} = $1`, [telefone]);
  }
}

export async function listPauses(table: string): Promise<string[]> {
  const { col, pausedFlag } = getSpec(table);
  const where = pausedFlag ? `WHERE ${pausedFlag.name} = ${pausedFlag.value}` : '';
  const r = await query<{ v: string }>(`SELECT ${col} AS v FROM ${table} ${where} ORDER BY ${col}`);
  return r.rows.map((x) => x.v);
}
