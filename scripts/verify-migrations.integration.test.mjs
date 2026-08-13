import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runMigrationGate } from './verify-migrations.mjs';

const pgTestUrl = process.env.PG_TEST_URL;
const describePg = pgTestUrl ? describe : describe.skip;

describePg('verify-migrations — Postgres 16 real', () => {
  it('schema alternativo não-vazio falha antes de escrever em public', async () => {
    const baseUrl = new URL(pgTestUrl);
    const databaseName = `migration_gate_${randomUUID().replaceAll('-', '')}`;
    const adminUrl = new URL(baseUrl);
    adminUrl.pathname = '/postgres';
    const targetUrl = new URL(baseUrl);
    targetUrl.pathname = `/${databaseName}`;

    const admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);
    await admin.end();

    const seed = new pg.Client({ connectionString: targetUrl.toString() });
    await seed.connect();
    await seed.query('CREATE SCHEMA shadow');
    await seed.query('CREATE TABLE shadow.already_here (id integer)');
    await seed.end();

    await expect(
      runMigrationGate({ databaseUrl: targetUrl.toString(), output: () => {} }),
    ).rejects.toThrow(/shadow\.already_here/i);

    const proof = new pg.Client({ connectionString: targetUrl.toString() });
    await proof.connect();
    const publicObjects = await proof.query(`
      SELECT COUNT(*)::int AS count
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    `);
    const searchPath = await proof.query('SHOW search_path');
    await proof.end();

    expect(publicObjects.rows[0]?.count).toBe(0);
    // O SET é por conexão: o verificador não pode contaminar a conexão de prova.
    expect(searchPath.rows[0]?.search_path).toBe('"$user", public');
  });
});
