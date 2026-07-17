/**
 * Teste de INTEGRAÇÃO do reconciler GCal→atendimentos (SCRUM-89 / ADR 0031) — roda SQL REAL.
 *
 * POR QUÊ: os unit tests MOCKAM o driver pg e só validam a STRING do SQL. Uma classe de defeito é
 * invisível assim: o índice parcial ux_atend_event_ativo, o filtro por updated_at/inicio_at, a
 * preservação de forma/valor no UPDATE sem pagamento (bug DOBRA), o soft-delete idempotente. Este
 * arquivo executa as funções REAIS contra um Postgres de verdade.
 *
 * COMO RODAR (local / smoke do devops):
 *   PG_TEST_URL=postgres://user:pass@localhost:5432/test_db npx vitest run atendimentos.gcal-sync.integration
 * Sem PG_TEST_URL o suite AUTO-SKIPA (o CI hoje não tem Postgres efêmero — SCRUM-50). NUNCA toca o
 * banco de produção: cria/dropa só as tabelas autocontidas (flow_clones mínimo + atendimentos).
 *
 * O que cobre (SQL real):
 *  - candidatos: retorna só as linhas origem='agenda' na janela com updated_at antigo; NUNCA a manual;
 *    grace (updated_at recente) e fora-da-janela (inicio_at) excluídos.
 *  - softDeleteAtendimentoByEvent: seta deleted_at; re-rodar = no-op (idempotência); a manual fica.
 *  - upsert idempotente: INSERT aplica valor; 2º call (mesmo event, sem formaPagamento) PRESERVA
 *    forma/valor (bug DOBRA não reabre); soft-deletada + novo upsert = NOVA linha (índice parcial).
 *  - ux_atend_event_ativo: 2 ativos mesmo event/slot = violação; soft-deletado + novo ativo convivem.
 *  - loadSlotPricing sobre servicos JSONB real (uniforme).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const PG_TEST_URL = process.env.PG_TEST_URL;
const describeIf = PG_TEST_URL ? describe : describe.skip;

if (!PG_TEST_URL) {
  console.warn(
    '[atendimentos.gcal-sync.integration] PG_TEST_URL ausente — suite de integração PULADO ' +
      '(SQL real não exercitado). Defina PG_TEST_URL para rodar.',
  );
}

describeIf('reconciler GCal→atendimentos contra Postgres REAL', () => {
  // biome-ignore lint/suspicious/noExplicitAny: pg importado dinamicamente.
  let pgPool: any;
  // biome-ignore lint/suspicious/noExplicitAny: módulo importado dinamicamente.
  let atend: any;

  const SLOT = 'itest_slot_gcal_sync';
  // SCRUM-90: schema PRÓPRIO desta suíte — isola das outras integrações que rodam em paralelo no
  // MESMO banco efêmero (flow_clones/atendimentos são globais e cada suíte as cria/dropa). O
  // teardown dropa só ESTE schema (CASCADE), nunca tabela global.
  const SCHEMA = 'itest_gcal_sync';
  const TENANT = '00000000-0000-0000-0000-0000000000bb';
  const now = Date.now();
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const DAY = 86_400_000;

  async function exec(sql: string, params?: unknown[]) {
    return pgPool.query(sql, params);
  }

  async function createSchema() {
    await exec(`CREATE TABLE IF NOT EXISTS flow_clones (
      slot TEXT PRIMARY KEY,
      tenant_id UUID,
      timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
      product_type TEXT DEFAULT 'individual',
      servicos JSONB,
      billing_from_agenda_enabled BOOLEAN NOT NULL DEFAULT FALSE)`);
    // atendimentos autocontido: sem as FKs externas (clone_colaboradores) — as funções sob teste
    // não dependem delas. Mesmas colunas/tipos de 058+059 + o índice parcial ux_atend_event_ativo.
    await exec(`CREATE TABLE IF NOT EXISTS atendimentos (
      id BIGSERIAL PRIMARY KEY,
      slot TEXT NOT NULL,
      tenant_id UUID NOT NULL,
      gcal_event_id TEXT,
      cliente_nome VARCHAR(160),
      cliente_contato VARCHAR(64),
      servico_nome VARCHAR(160),
      valor_cents INTEGER NOT NULL DEFAULT 0,
      desconto_cents INTEGER NOT NULL DEFAULT 0,
      forma_pagamento VARCHAR(24),
      colaborador_id BIGINT,
      comissao_pct NUMERIC(5,2),
      comissao_cents INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(16) NOT NULL DEFAULT 'realizado',
      data DATE NOT NULL DEFAULT (now()::date),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      origem VARCHAR(12) NOT NULL DEFAULT 'manual',
      dirty_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
      inicio_at TIMESTAMPTZ,
      fim_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      deleted_reason TEXT,
      deleted_by TEXT)`);
    await exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_atend_event_ativo
      ON atendimentos (slot, gcal_event_id)
      WHERE gcal_event_id IS NOT NULL AND deleted_at IS NULL`);
    await exec(
      `INSERT INTO flow_clones (slot, tenant_id, timezone, servicos, billing_from_agenda_enabled)
       VALUES ($1,$2,'America/Sao_Paulo',$3::jsonb,TRUE)
       ON CONFLICT (slot) DO UPDATE SET servicos = EXCLUDED.servicos`,
      [
        SLOT,
        TENANT,
        JSON.stringify([
          { nome: 'Sessão', preco_cents: 11000 },
          { nome: 'Retorno', preco_cents: 11000 },
        ]),
      ],
    );
  }

  async function dropSchema() {
    // Dropa só o schema DESTA suíte (CASCADE derruba flow_clones + atendimentos locais). Nunca
    // toca tabela de outra suíte — fim da corrida de teardown (SCRUM-90).
    await exec(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  }

  /** Insere uma linha de atendimento crua, controlando origem/updated_at/inicio_at. */
  async function seed(row: {
    eventId: string | null;
    origem: string;
    inicioOffsetMs: number | null;
    updatedOffsetMs: number;
    forma?: string | null;
    valor?: number;
    dirty?: string[];
  }) {
    await exec(
      `INSERT INTO atendimentos
         (slot, tenant_id, gcal_event_id, origem, forma_pagamento, valor_cents, dirty_fields,
          status, data, inicio_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'agendado',
               COALESCE($8::timestamptz::date, now()::date), $8::timestamptz,
               now() + ($9 || ' milliseconds')::interval)`,
      [
        SLOT,
        TENANT,
        row.eventId,
        row.origem,
        row.forma ?? null,
        row.valor ?? 0,
        JSON.stringify(row.dirty ?? []),
        row.inicioOffsetMs == null ? null : iso(row.inicioOffsetMs),
        String(row.updatedOffsetMs),
      ],
    );
  }

  beforeAll(async () => {
    const url = new URL(PG_TEST_URL as string);
    process.env.PG_HOST = url.hostname;
    process.env.PG_PORT = url.port || '5432';
    process.env.PG_USER = decodeURIComponent(url.username);
    process.env.PG_PASS = decodeURIComponent(url.password);
    process.env.PG_DB = url.pathname.replace(/^\//, '');
    // Liga o pool do módulo sob teste (client.ts) ao MESMO schema — antes de importá-lo.
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
    atend = await import('./atendimentos.js');
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
      /* ignore */
    }
  });

  beforeEach(async () => {
    await exec('DELETE FROM atendimentos WHERE slot = $1', [SLOT]);
  });

  const delFrom = () => iso(-62 * DAY);
  const delTo = () => iso(60 * DAY);
  const updatedBefore = () => iso(-120_000); // início do ciclo - 120s (grace)

  it('candidatos: só agenda na janela com updated_at antigo; NUNCA a manual; grace e fora-janela excluídos', async () => {
    await seed({
      eventId: 'ev_pix',
      origem: 'agenda',
      inicioOffsetMs: -5 * DAY,
      updatedOffsetMs: -3600_000,
      forma: 'pix',
      valor: 11000,
    });
    await seed({
      eventId: 'ev_prev',
      origem: 'agenda',
      inicioOffsetMs: 5 * DAY,
      updatedOffsetMs: -3600_000,
    });
    await seed({
      eventId: 'ev_sticky',
      origem: 'agenda',
      inicioOffsetMs: -2 * DAY,
      updatedOffsetMs: -3600_000,
      dirty: ['valor_cents'],
      valor: 9000,
    });
    await seed({
      eventId: null,
      origem: 'manual',
      inicioOffsetMs: null,
      updatedOffsetMs: -3600_000,
    }); // walk-in
    await seed({
      eventId: 'ev_recent',
      origem: 'agenda',
      inicioOffsetMs: -1 * DAY,
      updatedOffsetMs: -1_000,
    }); // grace: recente
    await seed({
      eventId: 'ev_out',
      origem: 'agenda',
      inicioOffsetMs: -200 * DAY,
      updatedOffsetMs: -3600_000,
    }); // fora da janela

    const rows = await atend.listAgendaAtendimentosInWindow(
      SLOT,
      delFrom(),
      delTo(),
      updatedBefore(),
    );
    const ids = rows.map((r: { gcal_event_id: string }) => r.gcal_event_id).sort();
    expect(ids).toEqual(['ev_pix', 'ev_prev', 'ev_sticky']);
    // valor/forma vêm coeridos p/ o log de auditoria.
    const pix = rows.find((r: { gcal_event_id: string }) => r.gcal_event_id === 'ev_pix');
    expect(pix.valor_cents).toBe(11000);
    expect(pix.forma_pagamento).toBe('pix');
  });

  it('softDeleteAtendimentoByEvent: seta deleted_at, idempotente, não toca a manual', async () => {
    await seed({
      eventId: 'ev_del',
      origem: 'agenda',
      inicioOffsetMs: -1 * DAY,
      updatedOffsetMs: -3600_000,
    });
    await seed({
      eventId: null,
      origem: 'manual',
      inicioOffsetMs: null,
      updatedOffsetMs: -3600_000,
    });

    const first = await atend.softDeleteAtendimentoByEvent(SLOT, 'ev_del');
    expect(first).not.toBeNull();
    const again = await atend.softDeleteAtendimentoByEvent(SLOT, 'ev_del'); // idempotente
    expect(again).toBeNull();

    const active = await exec(
      "SELECT COUNT(*)::int AS n FROM atendimentos WHERE slot = $1 AND origem = 'manual' AND deleted_at IS NULL",
      [SLOT],
    );
    expect(active.rows[0].n).toBe(1); // a manual permanece ativa.
  });

  it('SCRUM-90: audit carimba deleted_reason/deleted_by na MESMA linha; sem audit → NULL', async () => {
    await seed({
      eventId: 'ev_audit',
      origem: 'agenda',
      inicioOffsetMs: -1 * DAY,
      updatedOffsetMs: -3600_000,
      forma: 'pix',
      valor: 11000,
    });
    await seed({
      eventId: 'ev_plain',
      origem: 'agenda',
      inicioOffsetMs: -1 * DAY,
      updatedOffsetMs: -3600_000,
    });

    // Com audit (variante do reconciler): carimba reason/by no mesmo UPDATE do deleted_at.
    await atend.softDeleteAtendimentoByEvent(SLOT, 'ev_audit', {
      reason: 'gcal_sync_absent',
      by: 'gcal-atend-sync',
    });
    const stamped = await exec(
      'SELECT deleted_at, deleted_reason, deleted_by FROM atendimentos WHERE slot = $1 AND gcal_event_id = $2',
      [SLOT, 'ev_audit'],
    );
    expect(stamped.rows[0].deleted_at).not.toBeNull();
    expect(stamped.rows[0].deleted_reason).toBe('gcal_sync_absent');
    expect(stamped.rows[0].deleted_by).toBe('gcal-atend-sync');
    // O id CRU segue na linha (investigação intacta — o hash fica só no LOG).
    const raw = await exec(
      'SELECT gcal_event_id FROM atendimentos WHERE slot = $1 AND deleted_reason = $2',
      [SLOT, 'gcal_sync_absent'],
    );
    expect(raw.rows[0].gcal_event_id).toBe('ev_audit');

    // Sem audit: colunas ficam NULL (deleção legada / caminho não instrumentado).
    await atend.softDeleteAtendimentoByEvent(SLOT, 'ev_plain');
    const plain = await exec(
      'SELECT deleted_reason, deleted_by FROM atendimentos WHERE slot = $1 AND gcal_event_id = $2',
      [SLOT, 'ev_plain'],
    );
    expect(plain.rows[0].deleted_reason).toBeNull();
    expect(plain.rows[0].deleted_by).toBeNull();
  });

  it('upsert: INSERT aplica valor; 2º call sem forma PRESERVA; soft-deletada + novo upsert = NOVA linha', async () => {
    const base = {
      slot: SLOT,
      tenantId: TENANT,
      gcalEventId: 'ev_up',
      servicoNome: 'Sessão',
      inicioAt: iso(2 * DAY),
      fimAt: iso(2 * DAY + 1800_000),
      timezone: 'America/Sao_Paulo',
    };
    const r1 = await atend.upsertAtendimentoFromEvent({ ...base, valorCents: 9900 });
    expect(r1.valor_cents).toBe(9900);
    expect(r1.origem).toBe('agenda');

    // 2º call SEM formaPagamento e com valor diferente → PRESERVA valor (não reabre bug DOBRA).
    const r2 = await atend.upsertAtendimentoFromEvent({ ...base, valorCents: 100 });
    expect(r2.id).toBe(r1.id); // mesma linha (ON CONFLICT)
    expect(r2.valor_cents).toBe(9900); // preservado

    // soft-delete + novo upsert → NOVA linha (índice parcial só cobre ativos).
    await atend.softDeleteAtendimentoByEvent(SLOT, 'ev_up');
    const r3 = await atend.upsertAtendimentoFromEvent({ ...base, valorCents: 5000 });
    expect(r3.id).not.toBe(r1.id);
    expect(r3.valor_cents).toBe(5000);

    const cnt = await exec(
      'SELECT COUNT(*)::int AS n FROM atendimentos WHERE slot = $1 AND gcal_event_id = $2',
      [SLOT, 'ev_up'],
    );
    expect(cnt.rows[0].n).toBe(2); // 1 deletada + 1 ativa
  });

  it('ux_atend_event_ativo: 2 ativos mesmo event/slot = violação; deletado + ativo convivem', async () => {
    await seed({
      eventId: 'ev_ux',
      origem: 'agenda',
      inicioOffsetMs: -1 * DAY,
      updatedOffsetMs: -3600_000,
    });
    // 2º ativo com o MESMO event/slot → viola o índice parcial (23505).
    await expect(
      seed({
        eventId: 'ev_ux',
        origem: 'agenda',
        inicioOffsetMs: -1 * DAY,
        updatedOffsetMs: -3600_000,
      }),
    ).rejects.toMatchObject({ code: '23505' });

    // soft-delete o ativo e re-inserir um ativo: agora convivem (deletado não conta no índice).
    await atend.softDeleteAtendimentoByEvent(SLOT, 'ev_ux');
    await seed({
      eventId: 'ev_ux',
      origem: 'agenda',
      inicioOffsetMs: -1 * DAY,
      updatedOffsetMs: -3600_000,
    });
    const cnt = await exec(
      'SELECT COUNT(*)::int AS n FROM atendimentos WHERE slot = $1 AND gcal_event_id = $2',
      [SLOT, 'ev_ux'],
    );
    expect(cnt.rows[0].n).toBe(2);
  });

  it('loadSlotPricing sobre servicos JSONB real → uniforme detectado', async () => {
    const pricing = await atend.loadSlotPricing(SLOT);
    expect(pricing.uniformPriceCents).toBe(11000);
    expect(pricing.byNameLower.get('sessão')).toBe(11000);
  });
});
