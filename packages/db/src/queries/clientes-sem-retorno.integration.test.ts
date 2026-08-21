/**
 * Teste de INTEGRAÇÃO do ranking "sem retorno" (Missão 035) — roda SQL REAL.
 *
 * POR QUÊ: os unitários de clientes mockam o driver pg e validam string/params, mas não provam
 * que o planner usa os índices tenant+slot do ranking. Esta suíte executa a leitura real contra
 * Postgres e roda EXPLAIN (FORMAT JSON) na query espelhada para garantir uso dos índices
 * `ix_atendimentos_cliente_sem_retorno_agenda` e `ix_atendimentos_cliente_sem_retorno_manual`.
 *
 * COMO RODAR:
 *   PG_TEST_URL=postgres://user:pass@localhost:5432/test_db \
 *     npx vitest run clientes-sem-retorno.integration
 * Sem PG_TEST_URL a suíte AUTO-SKIPA. Isso mantém o CI/local sem infra nova, mas deixa um caminho
 * seguro e repetível para validar o plano em Postgres efêmero real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const PG_TEST_URL = process.env.PG_TEST_URL;
const describeIf = PG_TEST_URL ? describe : describe.skip;

if (!PG_TEST_URL) {
  console.warn(
    '[clientes-sem-retorno.integration] PG_TEST_URL ausente — suite de integração PULADA ' +
      '(EXPLAIN real dos índices do ranking não exercitado). Defina PG_TEST_URL para rodar.',
  );
}

interface ExplainNode {
  'Node Type'?: string;
  'Index Name'?: string;
  Plans?: ExplainNode[];
}

function planUsesIndex(node: ExplainNode | undefined, indexName: string): boolean {
  if (!node) return false;
  if (node['Index Name'] === indexName) return true;
  return Array.isArray(node.Plans) && node.Plans.some((child) => planUsesIndex(child, indexName));
}

describeIf('ranking sem retorno contra Postgres REAL', () => {
  // biome-ignore lint/suspicious/noExplicitAny: pg importado dinamicamente para suite PG opcional.
  let pgPool: any;
  // biome-ignore lint/suspicious/noExplicitAny: módulos sob teste importados dinamicamente.
  let clientes: any;

  const SCHEMA = 'itest_clientes_sem_retorno';
  const SLOT = 'itest_slot_ranking';
  const TENANT = '00000000-0000-0000-0000-0000000000bb';
  const TZ = 'America/Sao_Paulo';

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
      aniversario_mmdd TEXT,
      cidade TEXT,
      nota_interna TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_clientes_tenant_phone
         ON clientes (tenant_id, telefone_canonico)`,
    );

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

    await exec(`CREATE INDEX IF NOT EXISTS ix_atendimentos_cliente_sem_retorno_agenda
      ON atendimentos (
        tenant_id,
        slot,
        cliente_telefone_canonico,
        COALESCE(fim_at, inicio_at) DESC,
        id DESC
      )
      WHERE deleted_at IS NULL
        AND status <> 'cancelado'
        AND origem = 'agenda'
        AND cliente_telefone_canonico IS NOT NULL`);

    await exec(`CREATE INDEX IF NOT EXISTS ix_atendimentos_cliente_sem_retorno_manual
      ON atendimentos (
        tenant_id,
        slot,
        cliente_telefone_canonico,
        data DESC,
        id DESC
      )
      WHERE deleted_at IS NULL
        AND status <> 'cancelado'
        AND origem = 'manual'
        AND cliente_telefone_canonico IS NOT NULL`);
  }

  async function dropSchema() {
    await exec(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  }

  async function seedData() {
    await exec(
      `INSERT INTO clientes (
        id, tenant_id, slot, telefone_canonico, telefone_raw, nome
      ) VALUES
        ('11111111-1111-4111-8111-111111111111', $1, $2, '553199998888', '31999998888', 'Maria'),
        ('22222222-2222-4222-8222-222222222222', $1, $2, '553199997777', '31999997777', 'Carlos')`,
      [TENANT, SLOT],
    );
    await exec(
      `INSERT INTO clone_colaboradores (id, slot, nome)
       VALUES (9, $1, 'Bene')`,
      [SLOT],
    );
    await exec(
      `INSERT INTO atendimentos (
        id, slot, tenant_id, colaborador_id, cliente_telefone_canonico, cliente_nome,
        cliente_contato, servico_nome, status, origem, data, inicio_at, fim_at, deleted_at
      ) VALUES
        (1, $1, $2, 9, '553199998888', 'Maria', '31999998888', 'Corte', 'realizado', 'agenda',
          DATE '2026-08-01', TIMESTAMPTZ '2026-08-01 13:00:00+00', TIMESTAMPTZ '2026-08-01 13:30:00+00', NULL),
        (2, $1, $2, 9, '553199997777', 'Carlos', '31999997777', 'Barba', 'realizado', 'manual',
          DATE '2026-08-05', NULL, NULL, NULL),
        (3, $1, $2, 9, '553199998888', 'Maria', '31999998888', 'Futuro', 'agendado', 'agenda',
          DATE '2099-01-01', TIMESTAMPTZ '2099-01-01 13:00:00+00', TIMESTAMPTZ '2099-01-01 13:30:00+00', NULL),
        (4, $1, $2, 9, '553199997777', 'Carlos', '31999997777', 'Cancelado', 'cancelado', 'manual',
          DATE '2026-08-02', NULL, NULL, NULL),
        (5, $1, $2, 9, '553199997777', 'Carlos', '31999997777', 'Deletado', 'realizado', 'manual',
          DATE '2026-08-03', NULL, NULL, NOW())`,
      [SLOT, TENANT],
    );
  }

  async function explainOwnerPlan() {
    const sql = `EXPLAIN (FORMAT JSON)
      WITH elegiveis AS (
        SELECT c.id,
               c.nome,
               c.telefone_canonico,
               CASE
                 WHEN a.origem = 'agenda' THEN COALESCE(a.fim_at, a.inicio_at)
                 ELSE (a.data::timestamp AT TIME ZONE $3)
               END AS ultimo_atendimento_at,
               CASE
                 WHEN a.origem = 'agenda' THEN (COALESCE(a.fim_at, a.inicio_at) AT TIME ZONE $3)::date
                 ELSE a.data
               END AS referencia_local_date,
               cc.nome AS ultimo_profissional_nome,
               ROW_NUMBER() OVER (
                 PARTITION BY c.id
                 ORDER BY
                   CASE
                     WHEN a.origem = 'agenda' THEN COALESCE(a.fim_at, a.inicio_at)
                     ELSE (a.data::timestamp AT TIME ZONE $3)
                   END DESC,
                   a.id DESC
               ) AS rn
          FROM clientes c
          JOIN atendimentos a
            ON a.slot = c.slot
           AND a.tenant_id = c.tenant_id
           AND a.deleted_at IS NULL
           AND a.status <> 'cancelado'
           AND a.cliente_telefone_canonico = c.telefone_canonico
           AND (
             (a.origem = 'agenda' AND COALESCE(a.fim_at, a.inicio_at) <= NOW())
             OR
             (a.origem = 'manual' AND a.data <= (NOW() AT TIME ZONE $3)::date)
           )
          LEFT JOIN clone_colaboradores cc
            ON cc.id = a.colaborador_id AND cc.slot = a.slot
         WHERE c.slot = $1
           AND c.tenant_id = $2
      )
      SELECT id,
             nome,
             telefone_canonico,
             ultimo_atendimento_at,
             GREATEST(0, ((NOW() AT TIME ZONE $3)::date - referencia_local_date))::int AS dias_sem_retorno,
             ultimo_profissional_nome,
             COUNT(*) OVER()::bigint AS total_count
        FROM elegiveis
       WHERE rn = 1
       ORDER BY ultimo_atendimento_at ASC, id ASC
       LIMIT $4 OFFSET $5`;
    const res = await exec(sql, [SLOT, TENANT, TZ, 50, 0]);
    return res.rows[0]['QUERY PLAN'][0].Plan as ExplainNode;
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

  it('executa a leitura real e devolve só atendimentos passados elegíveis', async () => {
    const result = await clientes.listClientesSemRetornoForOwner({
      slot: SLOT,
      tenantId: TENANT,
      timezone: TZ,
      limit: 50,
      offset: 0,
    });

    expect(result.total).toBe(2);
    expect(result.limit).toBe(50);
    expect(result.clientes.map((c: { nome: string }) => c.nome)).toEqual(['Maria', 'Carlos']);
    expect(result.clientes[0]?.telefone_masked).toBe('+55 31 •••••-••88');
  });

  it('EXPLAIN usa os índices tenant+slot do ranking para agenda e manual', async () => {
    await exec('SET enable_seqscan = off');
    const plan = await explainOwnerPlan();

    expect(planUsesIndex(plan, 'ix_atendimentos_cliente_sem_retorno_agenda')).toBe(true);
    expect(planUsesIndex(plan, 'ix_atendimentos_cliente_sem_retorno_manual')).toBe(true);
  });
});
