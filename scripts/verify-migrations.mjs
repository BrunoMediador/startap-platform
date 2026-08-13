import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const databaseUrl = process.env.PG_TEST_URL;
const out = (message) => process.stdout.write(`${message}\n`);
const fail = (message) => process.stderr.write(`${message}\n`);

if (!databaseUrl) {
  fail('FATAL: PG_TEST_URL ausente; o gate exige um Postgres 16 efemero e vazio.');
  process.exit(1);
}

const parsedUrl = new URL(databaseUrl);
if (!['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname)) {
  fail(
    `FATAL: PG_TEST_URL aponta para host nao-local (${parsedUrl.hostname}); recusando aplicar migrations.`,
  );
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(repoRoot, 'packages', 'db', 'migrations');
const legacyBaselinePath = path.join(repoRoot, 'scripts', 'fixtures', '001_legacy_schema.sql');
const filenames = (await readdir(migrationsDir))
  .filter((filename) => filename.endsWith('.sql'))
  .sort((left, right) => left.localeCompare(right, 'en'));

if (filenames.length === 0) {
  fail(`FATAL: nenhuma migration encontrada em ${migrationsDir}.`);
  process.exit(1);
}

const client = new Client({ connectionString: databaseUrl });

try {
  await client.connect();

  const server = await client.query('SHOW server_version_num');
  const version = Number(server.rows[0]?.server_version_num);
  if (!Number.isInteger(version) || version < 160000 || version >= 170000) {
    throw new Error(`Postgres 16 obrigatorio; servidor reportou ${version || 'versao invalida'}`);
  }

  const existing = await client.query(`
    SELECT tablename
    FROM pg_catalog.pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);
  if (existing.rowCount !== 0) {
    throw new Error(
      `banco de teste nao esta vazio; tabelas em public: ${existing.rows
        .map((row) => row.tablename)
        .join(', ')}`,
    );
  }

  await client.query(`
    CREATE TABLE schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // O repositorio nasceu sobre duas tabelas legadas preexistentes; a historia
  // versionada comeca em 002. Materializar esse baseline no banco efemero permite
  // validar a cadeia 002..N sem reescrever migrations ja aplicadas em producao.
  await client.query(await readFile(legacyBaselinePath, 'utf8'));
  out('BASELINE  001_legacy_schema.sql');

  for (const filename of filenames) {
    const sql = await readFile(path.join(migrationsDir, filename), 'utf8');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
      out(`APPLY OK  ${filename}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`migration ${filename} falhou: ${detail}`, { cause: error });
    }
  }

  const applied = await client.query('SELECT COUNT(*)::int AS count FROM schema_migrations');
  const appliedCount = applied.rows[0]?.count;
  if (appliedCount !== filenames.length) {
    throw new Error(
      `registro incompleto: ${appliedCount}/${filenames.length} migrations aplicadas`,
    );
  }

  out(
    `Migrations OK: baseline 001 + ${appliedCount}/${filenames.length} migrations aplicadas em Postgres 16 vazio.`,
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  fail(`FATAL: ${detail}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
