import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.PG_HOST ?? 'postgres',
  port: Number(process.env.PG_PORT ?? 5432),
  user: process.env.PG_USER ?? 'startap_user',
  password: process.env.PG_PASS ?? '',
  database: process.env.PG_DB ?? 'startap_database',
  max: 10,
  idleTimeoutMillis: 30_000,
});

/** Helper para query tipada. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never);
}

/** Encerra o pool (usado em testes/shutdown). */
export async function closePool(): Promise<void> {
  await pool.end();
}
