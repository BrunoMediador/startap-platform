import { logger } from '@startap/core/logger';
import pg from 'pg';

const { Pool } = pg;

const log = logger.child({ module: 'db-client' });

const STATEMENT_TIMEOUT_MS = Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 10_000);
const QUERY_TIMEOUT_MS = Number(process.env.PG_QUERY_TIMEOUT_MS ?? 12_000);
const CONNECTION_TIMEOUT_MS = Number(process.env.PG_CONNECTION_TIMEOUT_MS ?? 5_000);

// Identificador (ou lista simples separada por vírgula) de schema — nada de espaço, aspas, `-c`
// ou qualquer coisa injetável no startup option `-c search_path=...`.
const SEARCH_PATH_WHITELIST = /^[a-zA-Z0-9_][a-zA-Z0-9_,]*$/;

/**
 * PG_SEARCH_PATH: ISOLAMENTO por schema das suítes de INTEGRAÇÃO (SCRUM-90) — sem ele, suítes em
 * paralelo criam/dropam as MESMAS tabelas globais (flow_clones/atendimentos/flow_pauses) e se
 * atropelam. Passado como startup option da conexão -> toda query do pool resolve nomes não-
 * qualificados no schema. UNSET -> search_path default (public), byte-idêntico ao de hoje.
 *
 * Fail-safe DUPLO (endurecimento pedido pelo arquiteto):
 *  1) só honrado sob marcador de TESTE (NODE_ENV=test | VITEST) — uma linha perdida no .env de
 *     prod NÃO repontaria TODAS as queries pra schema errado silenciosamente;
 *  2) WHITELIST do valor antes de interpolar — mata injeção via env. Inválido = ignora + warn
 *     (comporta-se como unset).
 *
 * Exportada pra o unit test cobrir o guard sem subir pool. Lê a env a CADA chamada.
 */
export function resolveSearchPath(): string | undefined {
  const raw = process.env.PG_SEARCH_PATH;
  if (!raw) return undefined;
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    log.warn('PG_SEARCH_PATH definido fora de contexto de teste — IGNORADO (fail-safe SCRUM-90)');
    return undefined;
  }
  if (!SEARCH_PATH_WHITELIST.test(raw)) {
    log.warn('PG_SEARCH_PATH com valor inválido (fora da whitelist) — IGNORADO (SCRUM-90)');
    return undefined;
  }
  return raw;
}

const SEARCH_PATH = resolveSearchPath();

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
  ...(SEARCH_PATH ? { options: `-c search_path=${SEARCH_PATH}` } : {}),
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
