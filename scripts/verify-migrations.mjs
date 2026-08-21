import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), '..');
const out = (message) => process.stdout.write(`${message}\n`);
const fail = (message) => process.stderr.write(`${message}\n`);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1']);

function isDockerBridgeAddress(address) {
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 172 && second >= 16 && second <= 31;
}

export function validateDatabaseUrl(databaseUrl) {
  if (!databaseUrl) {
    throw new Error('PG_TEST_URL ausente; o gate exige um Postgres 16 efemero e vazio.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error('PG_TEST_URL invalida; esperado postgres://usuario:senha@localhost:porta/db.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsedUrl.protocol)) {
    throw new Error(`protocolo proibido na PG_TEST_URL: ${parsedUrl.protocol}`);
  }
  if (!LOCAL_HOSTS.has(parsedUrl.hostname)) {
    throw new Error(
      `PG_TEST_URL aponta para host nao-local (${parsedUrl.hostname}); recusando aplicar migrations.`,
    );
  }
  const firstParameter = parsedUrl.searchParams.keys().next().value;
  if (firstParameter !== undefined) {
    throw new Error(
      `parametro proibido na PG_TEST_URL: ${firstParameter}; query string nao e permitida no gate.`,
    );
  }
  return parsedUrl;
}

function parseManifest(rawManifest, manifestPath, expectedRange) {
  const entries = rawManifest
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line, index) => {
      const match = /^([a-f0-9]{64}) {2}([^/]+\.sql)$/u.exec(line);
      if (!match) {
        throw new Error(`manifest invalido em ${manifestPath}:${index + 1}`);
      }
      return { sha256: match[1], filename: match[2] };
    });
  if (entries.length === 0) throw new Error(`manifest vazio: ${manifestPath}`);
  const expectedCount = expectedRange.last - expectedRange.first + 1;
  if (entries.length !== expectedCount) {
    throw new Error(
      `manifest deve cobrir ${String(expectedRange.first).padStart(3, '0')}..${String(
        expectedRange.last,
      ).padStart(3, '0')}; recebeu ${entries.length}/${expectedCount} entradas`,
    );
  }
  for (const [index, entry] of entries.entries()) {
    const expectedNumber = expectedRange.first + index;
    const actualNumber = Number(entry.filename.slice(0, 3));
    if (actualNumber !== expectedNumber) {
      throw new Error(
        `manifest fora de sequencia: esperado prefixo ${String(expectedNumber).padStart(3, '0')}, recebeu ${entry.filename}`,
      );
    }
  }
  return entries;
}

export async function loadMigrationPlan(
  migrationsDir,
  manifestPath,
  expectedRange = { first: 1, last: 84 },
  baselinePath = undefined,
) {
  if (!manifestPath) throw new Error('manifest de migrations ausente');
  const filenames = (await readdir(migrationsDir))
    .filter((filename) => filename.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (filenames.length === 0) {
    throw new Error(`nenhuma migration encontrada em ${migrationsDir}.`);
  }
  const manifest = parseManifest(await readFile(manifestPath, 'utf8'), manifestPath, expectedRange);
  const sourcePaths = new Map(
    filenames.map((filename) => [filename, path.join(migrationsDir, filename)]),
  );
  if (baselinePath) sourcePaths.set(path.basename(baselinePath), baselinePath);
  const expectedFilenames = manifest.map((entry) => entry.filename);
  const actualFilenames = [...sourcePaths.keys()];
  const missing = expectedFilenames.filter((filename) => !actualFilenames.includes(filename));
  const extra = actualFilenames.filter((filename) => !expectedFilenames.includes(filename));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `manifest diverge do diretorio; ausentes: ${missing.join(', ') || 'nenhuma'}; extras: ${
        extra.join(', ') || 'nenhuma'
      }`,
    );
  }

  return Promise.all(
    manifest.map(async (expected) => {
      const sql = await readFile(sourcePaths.get(expected.filename), 'utf8');
      const actualHash = createHash('sha256').update(sql).digest('hex');
      if (actualHash !== expected.sha256) {
        throw new Error(
          `migration ${expected.filename} com hash divergente (esperado ${expected.sha256}, obtido ${actualHash})`,
        );
      }
      return { filename: expected.filename, sql, sha256: actualHash };
    }),
  );
}

export async function assertDatabaseEmpty(client) {
  const existing = await client.query(`
    WITH user_schemas AS (
      SELECT oid, nspname
      FROM pg_catalog.pg_namespace
      WHERE nspname <> 'information_schema'
        AND nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
    )
    SELECT n.nspname AS schema_name, NULL::name AS object_name, 'schema' AS object_kind
    FROM user_schemas n
    WHERE n.nspname <> 'public'

    UNION ALL

    SELECT n.nspname, c.relname,
      CASE c.relkind
        WHEN 'r' THEN 'table'
        WHEN 'p' THEN 'partitioned table'
        WHEN 'v' THEN 'view'
        WHEN 'm' THEN 'materialized view'
        WHEN 'S' THEN 'sequence'
        WHEN 'f' THEN 'foreign table'
        WHEN 'c' THEN 'composite type'
        ELSE c.relkind::text
      END
    FROM user_schemas n
    JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')

    UNION ALL

    SELECT n.nspname, p.proname,
      CASE p.prokind
        WHEN 'p' THEN 'procedure'
        WHEN 'a' THEN 'aggregate'
        WHEN 'w' THEN 'window function'
        ELSE 'function'
      END
    FROM user_schemas n
    JOIN pg_catalog.pg_proc p ON p.pronamespace = n.oid

    UNION ALL

    SELECT n.nspname, t.typname,
      CASE t.typtype
        WHEN 'c' THEN 'composite type'
        WHEN 'd' THEN 'domain'
        WHEN 'e' THEN 'enum type'
        WHEN 'r' THEN 'range type'
        WHEN 'm' THEN 'multirange type'
        ELSE 'type'
      END
    FROM user_schemas n
    JOIN pg_catalog.pg_type t ON t.typnamespace = n.oid
    WHERE t.typelem = 0

    UNION ALL

    SELECT n.nspname, e.extname, 'extension'
    FROM user_schemas n
    JOIN pg_catalog.pg_extension e ON e.extnamespace = n.oid

    UNION ALL

    SELECT n.nspname, o.oprname, 'operator'
    FROM user_schemas n
    JOIN pg_catalog.pg_operator o ON o.oprnamespace = n.oid

    UNION ALL

    SELECT n.nspname, coll.collname, 'collation'
    FROM user_schemas n
    JOIN pg_catalog.pg_collation coll ON coll.collnamespace = n.oid

    UNION ALL

    SELECT n.nspname, conv.conname, 'conversion'
    FROM user_schemas n
    JOIN pg_catalog.pg_conversion conv ON conv.connamespace = n.oid

    UNION ALL

    SELECT n.nspname, opc.opcname, 'operator class'
    FROM user_schemas n
    JOIN pg_catalog.pg_opclass opc ON opc.opcnamespace = n.oid

    UNION ALL

    SELECT n.nspname, opf.opfname, 'operator family'
    FROM user_schemas n
    JOIN pg_catalog.pg_opfamily opf ON opf.opfnamespace = n.oid

    UNION ALL

    SELECT n.nspname, cfg.cfgname, 'text search configuration'
    FROM user_schemas n
    JOIN pg_catalog.pg_ts_config cfg ON cfg.cfgnamespace = n.oid

    UNION ALL

    SELECT n.nspname, dict.dictname, 'text search dictionary'
    FROM user_schemas n
    JOIN pg_catalog.pg_ts_dict dict ON dict.dictnamespace = n.oid

    UNION ALL

    SELECT n.nspname, prs.prsname, 'text search parser'
    FROM user_schemas n
    JOIN pg_catalog.pg_ts_parser prs ON prs.prsnamespace = n.oid

    UNION ALL

    SELECT n.nspname, tmpl.tmplname, 'text search template'
    FROM user_schemas n
    JOIN pg_catalog.pg_ts_template tmpl ON tmpl.tmplnamespace = n.oid

    ORDER BY schema_name, object_name, object_kind
  `);
  if (existing.rowCount !== 0) {
    throw new Error(
      `banco de teste nao esta vazio; objetos/schemas de usuario: ${existing.rows
        .map((row) =>
          row.object_name
            ? `${row.schema_name}.${row.object_name} (${row.object_kind})`
            : `${row.schema_name} (${row.object_kind})`,
        )
        .join(', ')}`,
    );
  }
}

export function assertEffectiveLocalConnection(client) {
  const parameters = client.connectionParameters;
  if (!parameters || !LOCAL_HOSTS.has(parameters.host)) {
    throw new Error(
      `destino efetivo do pg nao e local (${parameters?.host ?? 'host ausente'}); recusando conectar.`,
    );
  }
  if (parameters.options) {
    throw new Error('connectionParameters.options deve estar vazio no gate de migrations.');
  }
}

export async function assertConnectedToLocalServer(client) {
  const result = await client.query(
    'SELECT host(inet_server_addr()) AS server_addr, host(inet_client_addr()) AS client_addr',
  );
  const serverAddress = result.rows[0]?.server_addr;
  const clientAddress = result.rows[0]?.client_addr;
  const loopback = serverAddress && LOOPBACK_ADDRESSES.has(serverAddress);
  // GitHub Actions publica o service Postgres via bridge Docker: o processo do
  // job conecta em localhost, mas o servidor enxerga ambos os lados em 172.16/12.
  // Aceitamos somente esse segundo transporte local e simétrico; endereço público
  // ou apenas um dos lados na bridge continua fail-closed.
  const localDockerBridge =
    serverAddress &&
    clientAddress &&
    isDockerBridgeAddress(serverAddress) &&
    isDockerBridgeAddress(clientAddress);
  if (!loopback && !localDockerBridge) {
    throw new Error(
      `Postgres conectado nao e local; inet_server_addr=${serverAddress ?? 'null'}, inet_client_addr=${clientAddress ?? 'null'}`,
    );
  }
}

export async function setSafeDdlSearchPath(client) {
  // Com apenas public explícito, o PostgreSQL antepõe pg_catalog implicitamente
  // para resolução, enquanto mantém public como destino do DDL não qualificado.
  await client.query('SET search_path TO public');
  const result = await client.query(`
    SELECT
      current_schema() AS current_schema,
      array_to_string(current_schemas(true), ',') AS effective_search_path
  `);
  const currentSchema = result.rows[0]?.current_schema;
  const effectiveSearchPath = result.rows[0]?.effective_search_path;
  if (currentSchema !== 'public' || effectiveSearchPath !== 'pg_catalog,public') {
    throw new Error(
      `search_path efetivo inseguro; current_schema=${currentSchema ?? 'null'}, efetivo=${
        effectiveSearchPath ?? 'null'
      }`,
    );
  }
}

export async function runMigrationGate({
  databaseUrl,
  repoRoot = defaultRepoRoot,
  ClientClass = Client,
  output = out,
}) {
  validateDatabaseUrl(databaseUrl);

  const migrationsDir = path.join(repoRoot, 'packages', 'db', 'migrations');
  const legacyBaselinePath = path.join(repoRoot, 'scripts', 'fixtures', '001_legacy_schema.sql');
  const manifestPath = path.join(repoRoot, 'scripts', 'fixtures', 'migrations-manifest.sha256');
  const inventory = await loadMigrationPlan(
    migrationsDir,
    manifestPath,
    { first: 1, last: 84 },
    legacyBaselinePath,
  );
  const [baseline, ...plan] = inventory;
  if (baseline?.filename !== '001_legacy_schema.sql') {
    throw new Error('manifest deve iniciar pelo baseline 001_legacy_schema.sql');
  }
  const client = new ClientClass({ connectionString: databaseUrl });
  assertEffectiveLocalConnection(client);

  try {
    await client.connect();
    await assertConnectedToLocalServer(client);
    await client.query('SET search_path TO pg_catalog, public');

    const server = await client.query('SHOW server_version_num');
    const version = Number(server.rows[0]?.server_version_num);
    if (!Number.isInteger(version) || version < 160000 || version >= 170000) {
      throw new Error(`Postgres 16 obrigatorio; servidor reportou ${version || 'versao invalida'}`);
    }

    await assertDatabaseEmpty(client);
    await setSafeDdlSearchPath(client);
    await client.query(`
      CREATE TABLE public.schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(baseline.sql);
    output(`BASELINE  ${baseline.filename}`);

    for (const migration of plan) {
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO public.schema_migrations (filename) VALUES ($1)', [
          migration.filename,
        ]);
        output(`APPLY OK  ${migration.filename}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`migration ${migration.filename} falhou: ${detail}`, { cause: error });
      }
    }

    const applied = await client.query(
      'SELECT COUNT(*)::int AS count FROM public.schema_migrations',
    );
    const appliedCount = applied.rows[0]?.count;
    if (appliedCount !== plan.length) {
      throw new Error(`registro incompleto: ${appliedCount}/${plan.length} migrations aplicadas`);
    }

    output(
      `Migrations OK: baseline 001 + ${appliedCount}/${plan.length} migrations aplicadas em Postgres 16 vazio.`,
    );
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  try {
    await runMigrationGate({ databaseUrl: process.env.PG_TEST_URL });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`FATAL: ${detail}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main();
}
