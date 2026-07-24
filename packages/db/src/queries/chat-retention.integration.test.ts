/**
 * Teste de INTEGRAÇÃO da retenção por IDADE (SCRUM-136) — roda SQL REAL.
 *
 * POR QUÊ: apagar chat é IRREVERSÍVEL e a lógica (sessão morta sai inteira × sessão ativa
 * preserva as últimas N × dry-run só conta) mora no SQL. Um unit com pg mockado só olharia a
 * string. Aqui executamos applyAgeRetention / listChatTablesFromCatalog contra um Postgres de
 * verdade e conferimos as linhas resultantes.
 *
 * COMO RODAR:
 *   PG_TEST_URL=postgres://user:pass@localhost:5432/test_db npx vitest run chat-retention.integration
 * Sem PG_TEST_URL o suite AUTO-SKIPA (não derruba o CI local). No CI roda com Postgres efêmero.
 * NUNCA toca produção: cria tabelas chat_histories* mínimas dentro de um schema PRÓPRIO e o dropa.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const PG_TEST_URL = process.env.PG_TEST_URL;
const describeIf = PG_TEST_URL ? describe : describe.skip;

if (!PG_TEST_URL) {
  console.warn(
    '[chat-retention.integration] PG_TEST_URL ausente — suite de integração PULADO ' +
      '(SQL real não exercitado). Defina PG_TEST_URL para rodar.',
  );
}

describeIf('retenção por idade contra Postgres REAL (SCRUM-136)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: pg + módulo importados dinamicamente.
  let pgPool: any;
  // biome-ignore lint/suspicious/noExplicitAny: idem.
  let chat: any;

  const SCHEMA = 'itest_chat_retention';
  const MAIN = 'chat_histories'; // tabela padrão
  const ORPHAN = 'chat_histories_seven7'; // tabela órfã (clone excluído)
  const KEEP = 30;

  async function exec(sql: string, params?: unknown[]) {
    return pgPool.query(sql, params);
  }

  async function createTable(name: string) {
    await exec(`CREATE TABLE IF NOT EXISTS ${name} (
      id SERIAL PRIMARY KEY,
      session_id TEXT,
      message JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  }

  /** Insere n msgs com created_at explícito (dias no passado). */
  async function seed(table: string, sessionId: string, daysAgo: number, n = 1) {
    for (let i = 0; i < n; i++) {
      await exec(
        `INSERT INTO ${table} (session_id, message, created_at)
         VALUES ($1, $2, now() - ($3 || ' days')::interval)`,
        [sessionId, JSON.stringify({ type: 'human', data: { content: 'x' } }), daysAgo],
      );
    }
  }

  async function countRows(table: string, sessionId?: string): Promise<number> {
    const r = sessionId
      ? await exec(`SELECT count(*)::int AS c FROM ${table} WHERE session_id = $1`, [sessionId])
      : await exec(`SELECT count(*)::int AS c FROM ${table}`);
    return r.rows[0].c;
  }

  beforeAll(async () => {
    const url = new URL(PG_TEST_URL as string);
    process.env.PG_HOST = url.hostname;
    process.env.PG_PORT = url.port || '5432';
    process.env.PG_USER = decodeURIComponent(url.username);
    process.env.PG_PASS = decodeURIComponent(url.password);
    process.env.PG_DB = url.pathname.replace(/^\//, '');
    process.env.PG_SEARCH_PATH = SCHEMA;
    const pg = await import('pg');
    pgPool = new pg.default.Pool({
      host: process.env.PG_HOST,
      port: Number(process.env.PG_PORT),
      user: process.env.PG_USER,
      password: process.env.PG_PASS,
      database: process.env.PG_DB,
      max: 6,
      options: `-c search_path=${SCHEMA}`,
    });
    await exec(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    chat = await import('./chat-memory.js');
    await createTable(MAIN);
    await createTable(ORPHAN);
  }, 30_000);

  afterAll(async () => {
    if (pgPool) {
      await exec(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
      await pgPool.end().catch(() => {});
    }
    try {
      const client = await import('../client.js');
      await client.closePool();
    } catch {
      /* noop */
    }
  });

  beforeEach(async () => {
    await exec(`TRUNCATE ${MAIN} RESTART IDENTITY`);
    await exec(`TRUNCATE ${ORPHAN} RESTART IDENTITY`);
  });

  const cutoff = () => new Date(Date.now() - 180 * 86_400_000);

  it('listChatTablesFromCatalog acha a tabela padrão E a órfã', async () => {
    const tables = await chat.listChatTablesFromCatalog();
    expect(tables).toContain(MAIN);
    expect(tables).toContain(ORPHAN);
  });

  it('DRY-RUN conta o que apagaria e NÃO apaga', async () => {
    // sessão morta antiga (5 msgs, 300 dias) — candidata inteira.
    await seed(MAIN, 'sessao_morta', 300, 5);
    // sessão ativa recente (2 msgs, 1 dia) — nada a apagar.
    await seed(MAIN, 'sessao_ativa', 1, 2);

    const before = await countRows(MAIN);
    const res = await chat.applyAgeRetention(MAIN, cutoff(), KEEP, { dryRun: true });

    expect(res.matched).toBe(5); // as 5 da sessão morta
    expect(res.deleted).toBe(0); // dry-run não apaga
    expect(await countRows(MAIN)).toBe(before); // banco intacto
  });

  it('ENABLED apaga só o mais velho que X dias (sessão morta sai inteira)', async () => {
    await seed(MAIN, 'sessao_morta', 300, 5);
    await seed(MAIN, 'sessao_ativa', 1, 2);

    const res = await chat.applyAgeRetention(MAIN, cutoff(), KEEP, { dryRun: false });

    expect(res.deleted).toBe(5);
    expect(await countRows(MAIN, 'sessao_morta')).toBe(0); // conversa velha inteira apagada
    expect(await countRows(MAIN, 'sessao_ativa')).toBe(2); // recente intacta
  });

  it('sessão ATIVA preserva as últimas N mesmo com mensagens velhas', async () => {
    // Sessão que conversa devagar: 40 msgs velhas (200 dias) + 1 recente (agora).
    // A sessão está ATIVA (tem msg recente), então as últimas KEEP=30 são preservadas.
    await seed(MAIN, 'sessao_lenta', 200, 40);
    await seed(MAIN, 'sessao_lenta', 0, 1); // recente → sessão ativa

    const res = await chat.applyAgeRetention(MAIN, cutoff(), KEEP, { dryRun: false });

    // Total 41. Últimas 30 (por id DESC) preservadas; as 11 velhas além disso saem.
    expect(res.deleted).toBe(11);
    expect(await countRows(MAIN, 'sessao_lenta')).toBe(30);
  });

  it('tabela ÓRFÃ de clone excluído é varrida', async () => {
    await seed(ORPHAN, 'ex_cliente', 400, 8);

    const res = await chat.applyAgeRetention(ORPHAN, cutoff(), KEEP, { dryRun: false });

    expect(res.deleted).toBe(8);
    expect(await countRows(ORPHAN)).toBe(0);
  });

  it('idempotente: rodar de novo não apaga mais nada', async () => {
    await seed(MAIN, 'sessao_morta', 300, 5);
    await chat.applyAgeRetention(MAIN, cutoff(), KEEP, { dryRun: false });
    const second = await chat.applyAgeRetention(MAIN, cutoff(), KEEP, { dryRun: false });
    expect(second.deleted).toBe(0);
  });

  it('nome de tabela inválido é recusado (defesa SQL injection)', async () => {
    await expect(
      chat.applyAgeRetention('chat_histories; DROP TABLE x', cutoff(), KEEP, { dryRun: true }),
    ).rejects.toThrow(/inválida/i);
  });
});
