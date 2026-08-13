import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  assertConnectedToLocalServer,
  assertDatabaseEmpty,
  assertEffectiveLocalConnection,
  loadMigrationPlan,
  validateDatabaseUrl,
} from './verify-migrations.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function fixtureWithManifest(files, manifestEntries) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'startap-migration-gate-'));
  const migrationsDir = path.join(root, 'migrations');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(migrationsDir);
  await Promise.all(
    Object.entries(files).map(([filename, sql]) =>
      writeFile(path.join(migrationsDir, filename), sql, 'utf8'),
    ),
  );
  const manifestPath = path.join(root, 'manifest.sha256');
  await writeFile(
    manifestPath,
    manifestEntries
      .map((entry) => `${entry.sha256}  ${entry.filename}`)
      .join('\n')
      .concat('\n'),
    'utf8',
  );
  return { migrationsDir, manifestPath };
}

describe('verify-migrations — alvo local efetivo', () => {
  it('rejeita override de host na query mesmo quando a autoridade diz localhost', () => {
    expect(() =>
      validateDatabaseUrl('postgres://user:pass@localhost:5432/db?host=example.com'),
    ).toThrow(/parametro.*host/i);
  });

  it('rejeita options na query que poderia sobrescrever search_path', () => {
    expect(() =>
      validateDatabaseUrl(
        'postgres://user:pass@localhost:5432/db?options=-c%20search_path%3Dshadow',
      ),
    ).toThrow(/parametro.*options/i);
  });

  it('revalida o host resolvido por pg em connectionParameters', () => {
    const client = new pg.Client({
      connectionString: 'postgres://user:pass@localhost:5432/db?host=example.com',
    });
    expect(() => assertEffectiveLocalConnection(client)).toThrow(/destino efetivo.*example\.com/i);
  });

  it('rejeita servidor remoto pela prova pós-conexão inet_server_addr', async () => {
    const client = {
      query: async () => ({
        rows: [{ server_addr: '203.0.113.10', client_addr: '203.0.113.20' }],
      }),
    };
    await expect(assertConnectedToLocalServer(client)).rejects.toThrow(
      /inet_server_addr=203\.0\.113\.10/i,
    );
  });

  it('aceita bridge Docker local quando servidor e cliente estão em 172.16/12', async () => {
    const client = {
      query: async () => ({
        rows: [{ server_addr: '172.17.0.2', client_addr: '172.17.0.1' }],
      }),
    };
    await expect(assertConnectedToLocalServer(client)).resolves.toBeUndefined();
  });
});

describe('verify-migrations — banco realmente vazio', () => {
  it('rejeita objeto em schema alternativo antes de qualquer escrita', async () => {
    const writes = [];
    const client = {
      async query(sql) {
        const statement = String(sql);
        if (/CREATE|INSERT|ALTER|DROP|TRUNCATE/i.test(statement)) writes.push(statement);
        if (statement.includes("schemaname = 'public'")) return { rowCount: 0, rows: [] };
        return {
          rowCount: 1,
          rows: [{ schema_name: 'shadow', object_name: 'already_here', object_kind: 'table' }],
        };
      },
    };

    await expect(assertDatabaseEmpty(client)).rejects.toThrow(/shadow.*already_here/i);
    expect(writes).toEqual([]);
  });
});

describe('verify-migrations — manifest imutável', () => {
  it('falha quando uma migration esperada foi removida', async () => {
    const sql002 = 'SELECT 2;\n';
    const sql003 = 'SELECT 3;\n';
    const { migrationsDir, manifestPath } = await fixtureWithManifest({ '002_first.sql': sql002 }, [
      { filename: '002_first.sql', sha256: sha256(sql002) },
      { filename: '003_second.sql', sha256: sha256(sql003) },
    ]);

    await expect(
      loadMigrationPlan(migrationsDir, manifestPath, { first: 2, last: 3 }),
    ).rejects.toThrow(/003_second\.sql.*ausente|manifest.*diverge/i);
  });

  it('falha quando o conteúdo de uma migration foi alterado', async () => {
    const original = 'SELECT 2;\n';
    const { migrationsDir, manifestPath } = await fixtureWithManifest(
      { '002_first.sql': 'SELECT 999;\n' },
      [{ filename: '002_first.sql', sha256: sha256(original) }],
    );

    await expect(
      loadMigrationPlan(migrationsDir, manifestPath, { first: 2, last: 2 }),
    ).rejects.toThrow(/002_first\.sql.*hash/i);
  });
});
