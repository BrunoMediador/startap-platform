/**
 * Teste de INTEGRAÇÃO dos aniversariantes do CRM — roda SQL REAL.
 *
 * POR QUÊ: o bug bloqueante era de calendário em SQL (`02-31` e `02-29` em ano não bissexto),
 * então os unitários de string não bastam. Aqui garantimos que a query real não explode em 500,
 * filtra legado inválido e calcula a próxima ocorrência bissexta correta a partir da data atual.
 *
 * COMO RODAR:
 *   PG_TEST_URL=postgres://user:pass@localhost:5432/test_db \
 *     npx vitest run clientes-aniversariantes.integration
 * Sem PG_TEST_URL a suíte AUTO-SKIPA.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const PG_TEST_URL = process.env.PG_TEST_URL;
const describeIf = PG_TEST_URL ? describe : describe.skip;

if (!PG_TEST_URL) {
  console.warn(
    '[clientes-aniversariantes.integration] PG_TEST_URL ausente — suite de integração PULADA ' +
      '(calendário real dos aniversariantes não exercitado). Defina PG_TEST_URL para rodar.',
  );
}

describeIf('aniversariantes contra Postgres REAL', () => {
  // biome-ignore lint/suspicious/noExplicitAny: pg importado dinamicamente para suite PG opcional.
  let pgPool: any;
  // biome-ignore lint/suspicious/noExplicitAny: módulo sob teste importado dinamicamente.
  let clientes: any;

  const SCHEMA = 'itest_clientes_aniversariantes';
  const SLOT = 'itest_slot_aniversarios';
  const TENANT = '00000000-0000-0000-0000-0000000000dd';
  const TZ = 'America/Sao_Paulo';
  const COLAB_ID = 9;

  async function exec(sql: string, params?: unknown[]) {
    return pgPool.query(sql, params);
  }

  async function createSchema() {
    await exec(`CREATE TABLE IF NOT EXISTS clientes (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL,
      slot TEXT NOT NULL,
      telefone_canonico TEXT NOT NULL,
      telefone_raw TEXT NOT NULL,
      nome TEXT,
      nome_personalizado TEXT,
      aniversario_mmdd TEXT,
      cidade TEXT,
      nota_interna TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

    await exec(`CREATE TABLE IF NOT EXISTS clone_colaboradores (
      id BIGINT PRIMARY KEY,
      slot TEXT NOT NULL,
      nome TEXT NOT NULL)`);

    await exec(`CREATE TABLE IF NOT EXISTS atendimentos (
      id BIGINT PRIMARY KEY,
      slot TEXT NOT NULL,
      tenant_id UUID NOT NULL,
      colaborador_id BIGINT,
      cliente_telefone_canonico TEXT,
      cliente_nome TEXT,
      cliente_contato TEXT,
      servico_nome TEXT,
      valor_cents INTEGER NOT NULL DEFAULT 0,
      desconto_cents INTEGER NOT NULL DEFAULT 0,
      forma_pagamento TEXT,
      status VARCHAR(16) NOT NULL DEFAULT 'realizado',
      origem VARCHAR(16) NOT NULL DEFAULT 'manual',
      data DATE NOT NULL,
      inicio_at TIMESTAMPTZ,
      fim_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ)`);
  }

  async function dropSchema() {
    await exec(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  }

  async function seedData() {
    await exec(
      `INSERT INTO clientes (
        id, tenant_id, slot, telefone_canonico, telefone_raw, nome, aniversario_mmdd
      ) VALUES
        ('11111111-1111-4111-8111-111111111111', $1, $2, '553199998855', '31999998855', 'Ana', '02-29'),
        ('22222222-2222-4222-8222-222222222222', $1, $2, '553199998844', '31999998844', 'Legado Invalido', '02-31')`,
      [TENANT, SLOT],
    );
    await exec(
      `INSERT INTO clone_colaboradores (id, slot, nome)
       VALUES ($1, $2, 'Bene')`,
      [COLAB_ID, SLOT],
    );
    await exec(
      `INSERT INTO atendimentos (
        id, slot, tenant_id, colaborador_id, cliente_telefone_canonico, cliente_nome,
        cliente_contato, servico_nome, status, origem, data, inicio_at, fim_at, deleted_at
      ) VALUES
        (1, $1, $2, $3, '553199998855', 'Ana', '31999998855', 'Corte', 'realizado', 'agenda',
          DATE '2026-08-20', TIMESTAMPTZ '2026-08-20 13:00:00+00', TIMESTAMPTZ '2026-08-20 13:30:00+00', NULL),
        (2, $1, $2, $3, '553199998844', 'Legado Invalido', '31999998844', 'Barba', 'realizado', 'manual',
          DATE '2026-08-19', NULL, NULL, NULL)`,
      [SLOT, TENANT, COLAB_ID],
    );
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
      max: 4,
      options: `-c search_path=${SCHEMA}`,
    });

    await exec(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    clientes = await import('./clientes.js');
    await createSchema();
  }, 30_000);

  afterAll(async () => {
    if (pgPool) {
      await dropSchema().catch(() => {});
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
    await exec('DELETE FROM atendimentos');
    await exec('DELETE FROM clone_colaboradores');
    await exec('DELETE FROM clientes');
    await seedData();
  });

  it('owner filtra 02-31 e mantém 02-29 com próxima ocorrência bissexta em ano atual não bissexto', async () => {
    const result = await clientes.listClientesAniversariantesForOwner({
      slot: SLOT,
      tenantId: TENANT,
      timezone: TZ,
      mode: 'mes',
      mes: 2,
      limit: 50,
      offset: 0,
    });

    expect(result.total).toBe(1);
    expect(result.clientes).toHaveLength(1);
    expect(result.clientes[0]).toMatchObject({
      nome: 'Ana',
      aniversario_mmdd: '02-29',
      proxima_ocorrencia_local_date: '2028-02-29',
      ultimo_profissional_nome: 'Bene',
    });
  });

  it('colaborador roda a mesma query real sem 500 e mantém só aniversários válidos visíveis', async () => {
    const result = await clientes.listClientesAniversariantesForColaborador({
      slot: SLOT,
      tenantId: TENANT,
      colaboradorId: COLAB_ID,
      timezone: TZ,
      mode: 'mes',
      mes: 2,
      limit: 50,
      offset: 0,
    });

    expect(result.total).toBe(1);
    expect(result.clientes).toHaveLength(1);
    expect(result.clientes[0]).toMatchObject({
      nome: 'Ana',
      aniversario_mmdd: '02-29',
      proxima_ocorrencia_local_date: '2028-02-29',
    });
  });
});
