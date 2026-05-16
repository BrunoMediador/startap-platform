import pg from 'pg';

const { Pool } = pg;

const STATEMENT_TIMEOUT_MS = Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 10_000);
const QUERY_TIMEOUT_MS = Number(process.env.PG_QUERY_TIMEOUT_MS ?? 12_000);
const CONNECTION_TIMEOUT_MS = Number(process.env.PG_CONNECTION_TIMEOUT_MS ?? 5_000);

export const pool = new Pool({
  host: process.env.PG_HOST ?? 'postgres',
  port: Number(process.env.PG_PORT ?? 5432),
  user: process.env.PG_USER ?? 'startap_user',
  password: process.env.PG_PASS ?? '',
  database: process.env.PG_DB ?? 'startap_database',
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  statement_timeout: STATEMENT_TIMEOUT_MS,
  query_timeout: QUERY_TIMEOUT_MS,
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
