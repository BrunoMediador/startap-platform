/**
 * ADR 0044 — prova de atomicidade da operação+plano contra PostgreSQL real.
 *
 * Rodar com:
 *   PG_TEST_URL=postgres://user:pass@localhost:5432/test_db \
 *     npx vitest run agenda-bloqueio-operacoes.integration
 *
 * Sem PG_TEST_URL a suíte auto-skipa. Cada processo usa schema próprio.
 */
import type { Pool, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PG_TEST_URL = process.env.PG_TEST_URL;
const describeIf = PG_TEST_URL ? describe : describe.skip;
const SCHEMA = `itest_agenda_bloqueio_operacoes_${process.pid}`;

if (!PG_TEST_URL) {
  console.warn(
    '[agenda-bloqueio-operacoes.integration] PG_TEST_URL ausente — atomicidade PostgreSQL 16 PULADA.',
  );
}

type AgendaBloqueioOperacoesModule = typeof import('./agenda-bloqueio-operacoes.js');
type AgendaBloqueiosModule = typeof import('./agenda-bloqueios.js');

describeIf('ADR 0044 operação+plano atômicos contra PostgreSQL real', () => {
  let pgPool: Pool;
  let agendaBloqueioOperacoes: AgendaBloqueioOperacoesModule;
  let agendaBloqueios: AgendaBloqueiosModule;

  async function exec<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ) {
    return pgPool.query<T>(sql, params);
  }

  function input(
    overrides: Partial<Parameters<AgendaBloqueioOperacoesModule['createPlan']>[0]> = {},
  ) {
    return {
      operationId: '11111111-1111-4111-8111-111111111111',
      tenantId: '00000000-0000-4000-8000-000000000001',
      slot: 'clone_atomicidade',
      colaboradorId: 7,
      sessionHash: 'a'.repeat(64),
      payloadHash: 'b'.repeat(64),
      actorRole: 'owner' as const,
      actorUserId: 22,
      actorColaboradorId: null,
      timezone: 'America/Sao_Paulo',
      tipo: 'almoco' as const,
      motivo: 'intervalo',
      occurrences: [
        {
          ordinal: 1,
          inicioAt: '2026-08-22T12:00:00.000Z',
          fimAt: '2026-08-22T13:00:00.000Z',
          bloqueioId: '22222222-2222-4222-8222-222222222222',
          gcalEventId: 'bloq-atomicidade-1',
        },
        {
          ordinal: 2,
          inicioAt: '2026-08-29T12:00:00.000Z',
          fimAt: '2026-08-29T13:00:00.000Z',
          bloqueioId: '33333333-3333-4333-8333-333333333333',
          gcalEventId: 'bloq-atomicidade-2',
        },
      ],
      ...overrides,
    };
  }

  beforeAll(async () => {
    const url = new URL(PG_TEST_URL as string);
    process.env.PG_HOST = url.hostname;
    process.env.PG_PORT = url.port || '5432';
    process.env.PG_USER = decodeURIComponent(url.username);
    process.env.PG_PASS = decodeURIComponent(url.password);
    process.env.PG_DB = url.pathname.replace(/^\//, '');
    process.env.PG_SEARCH_PATH = SCHEMA;
    process.env.NODE_ENV = 'test';

    const pg = (await import('pg')).default;
    pgPool = new pg.Pool({
      host: process.env.PG_HOST,
      port: Number(process.env.PG_PORT),
      user: process.env.PG_USER,
      password: process.env.PG_PASS,
      database: process.env.PG_DB,
      max: 12,
      options: `-c search_path=${SCHEMA}`,
    });
    await exec(`CREATE SCHEMA ${SCHEMA}`);
    await exec(`CREATE TABLE agenda_bloqueio_operacoes (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL,
      slot TEXT NOT NULL,
      colaborador_key BIGINT NOT NULL,
      session_hash TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      actor_user_id BIGINT,
      actor_colaborador_id BIGINT,
      timezone TEXT NOT NULL,
      tipo TEXT NOT NULL,
      motivo TEXT,
      status TEXT NOT NULL DEFAULT 'planned',
      response_status INTEGER,
      response_body JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, slot, colaborador_key, session_hash, payload_hash)
    )`);
    await exec(`CREATE TABLE agenda_bloqueio_operacao_ocorrencias (
      operation_id UUID NOT NULL REFERENCES agenda_bloqueio_operacoes(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
      inicio_at TIMESTAMPTZ NOT NULL,
      fim_at TIMESTAMPTZ NOT NULL CHECK (fim_at > inicio_at),
      bloqueio_id UUID NOT NULL,
      gcal_event_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'planned',
      error_code TEXT,
      attempt_version INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (operation_id, ordinal)
    )`);
    await exec(`CREATE TABLE agenda_bloqueios (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL,
      slot TEXT NOT NULL,
      colaborador_id BIGINT,
      serie_id UUID,
      gcal_event_id TEXT,
      inicio_at TIMESTAMPTZ NOT NULL,
      fim_at TIMESTAMPTZ NOT NULL,
      timezone TEXT NOT NULL,
      tipo TEXT NOT NULL,
      motivo TEXT,
      status TEXT NOT NULL,
      created_by_role TEXT NOT NULL,
      created_by_user_id BIGINT,
      created_by_colaborador_id BIGINT,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    agendaBloqueioOperacoes = await import('./agenda-bloqueio-operacoes.js');
    agendaBloqueios = await import('./agenda-bloqueios.js');
  }, 30_000);

  afterAll(async () => {
    try {
      const db = await import('../client.js');
      await db.closePool();
    } finally {
      if (pgPool) {
        await pgPool.query(`DROP SCHEMA ${SCHEMA} CASCADE`).catch(() => {});
        await pgPool.end().catch(() => {});
      }
    }
  });

  it('uma violação no plano faz rollback da operação e de todas as ocorrências', async () => {
    const invalid = input({
      occurrences: [
        {
          ordinal: 1,
          inicioAt: '2026-08-22T12:00:00.000Z',
          fimAt: '2026-08-22T13:00:00.000Z',
          bloqueioId: '11111111-1111-4111-8111-111111111111',
          gcalEventId: 'bloq-valid-before-invalid',
        },
        {
          ordinal: 2,
          inicioAt: '2026-08-22T13:00:00.000Z',
          fimAt: '2026-08-22T12:00:00.000Z',
          bloqueioId: '22222222-2222-4222-8222-222222222222',
          gcalEventId: 'bloq-invalid',
        },
      ],
    });

    await expect(agendaBloqueioOperacoes.createPlan(invalid)).rejects.toThrow();
    const counts = await exec<{ operations: string; occurrences: string }>(
      `SELECT (SELECT count(*) FROM agenda_bloqueio_operacoes)::text AS operations,
              (SELECT count(*) FROM agenda_bloqueio_operacao_ocorrencias)::text AS occurrences`,
    );
    expect(counts.rows[0]).toEqual({ operations: '0', occurrences: '0' });
  });

  it('ordinal duplicado no input aborta operação e plano inteiros', async () => {
    const duplicateOrdinal = input({
      occurrences: [
        {
          ordinal: 1,
          inicioAt: '2026-08-22T12:00:00.000Z',
          fimAt: '2026-08-22T13:00:00.000Z',
          bloqueioId: '22222222-2222-4222-8222-222222222222',
          gcalEventId: 'bloq-duplicate-1',
        },
        {
          ordinal: 1,
          inicioAt: '2026-08-29T12:00:00.000Z',
          fimAt: '2026-08-29T13:00:00.000Z',
          bloqueioId: '33333333-3333-4333-8333-333333333333',
          gcalEventId: 'bloq-duplicate-2',
        },
      ],
    });

    await expect(agendaBloqueioOperacoes.createPlan(duplicateOrdinal)).rejects.toThrow();
    const counts = await exec<{ operations: string; occurrences: string }>(
      `SELECT (SELECT count(*) FROM agenda_bloqueio_operacoes)::text AS operations,
              (SELECT count(*) FROM agenda_bloqueio_operacao_ocorrencias)::text AS occurrences`,
    );
    expect(counts.rows[0]).toEqual({ operations: '0', occurrences: '0' });
  });

  it('lista vazia não cria operação nem plano', async () => {
    await expect(agendaBloqueioOperacoes.createPlan(input({ occurrences: [] }))).rejects.toThrow(
      'agenda_bloqueio_operacao_sem_ocorrencias',
    );
    const counts = await exec<{ operations: string; occurrences: string }>(
      `SELECT (SELECT count(*) FROM agenda_bloqueio_operacoes)::text AS operations,
              (SELECT count(*) FROM agenda_bloqueio_operacao_ocorrencias)::text AS occurrences`,
    );
    expect(counts.rows[0]).toEqual({ operations: '0', occurrences: '0' });
  });

  it.each([
    ['uma ocorrência', () => input({ occurrences: input().occurrences.slice(0, 1) })],
    [
      'vinte e cinco ocorrências',
      () =>
        input({
          occurrences: Array.from({ length: 25 }, (_, index) => ({
            ordinal: index + 1,
            inicioAt: `2026-08-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
            fimAt: `2026-08-${String(index + 1).padStart(2, '0')}T13:00:00.000Z`,
            bloqueioId: `80000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
            gcalEventId: `bloq-too-many-${index + 1}`,
          })),
        }),
    ],
  ])('%s não cria operação nem plano', async (_label, makeInput) => {
    await expect(agendaBloqueioOperacoes.createPlan(makeInput())).rejects.toThrow(
      'agenda_bloqueio_operacao_quantidade_ocorrencias_invalida',
    );
    const counts = await exec<{ operations: string; occurrences: string }>(
      `SELECT (SELECT count(*) FROM agenda_bloqueio_operacoes)::text AS operations,
              (SELECT count(*) FROM agenda_bloqueio_operacao_ocorrencias)::text AS occurrences`,
    );
    expect(counts.rows[0]).toEqual({ operations: '0', occurrences: '0' });
  });

  it('replay real retorna a mesma operação e preserva seu plano original', async () => {
    const first = input({ operationId: '66666666-6666-4666-8666-666666666666' });
    const replay = input({
      operationId: '77777777-7777-4777-8777-777777777777',
      occurrences: [
        {
          ordinal: 1,
          inicioAt: '2026-09-05T12:00:00.000Z',
          fimAt: '2026-09-05T13:00:00.000Z',
          bloqueioId: '88888888-8888-4888-8888-888888888888',
          gcalEventId: 'bloq-replay-must-not-exist-1',
        },
        {
          ordinal: 2,
          inicioAt: '2026-09-12T12:00:00.000Z',
          fimAt: '2026-09-12T13:00:00.000Z',
          bloqueioId: '99999999-9999-4999-8999-999999999999',
          gcalEventId: 'bloq-replay-must-not-exist-2',
        },
      ],
    });

    const created = await agendaBloqueioOperacoes.createPlan(first);
    const replayed = await agendaBloqueioOperacoes.createPlan(replay);

    expect(created).toEqual({
      created: true,
      operation: { id: first.operationId, status: 'planned' },
    });
    expect(replayed).toEqual({
      created: false,
      operation: { id: first.operationId, status: 'planned' },
    });
    const plan = await exec<{ gcal_event_ids: string[] }>(
      `SELECT array_agg(gcal_event_id ORDER BY ordinal) AS gcal_event_ids
         FROM agenda_bloqueio_operacao_ocorrencias
        WHERE operation_id = $1`,
      [first.operationId],
    );
    expect(plan.rows[0]?.gcal_event_ids).toEqual(
      first.occurrences.map((occurrence) => occurrence.gcalEventId),
    );
  });

  it('dois clients concorrentes convergem em uma operação e N ocorrências', async () => {
    const first = input({
      operationId: '44444444-4444-4444-8444-444444444444',
      sessionHash: 'c'.repeat(64),
      payloadHash: 'd'.repeat(64),
      occurrences: input().occurrences.map((occurrence) => ({
        ...occurrence,
        gcalEventId: `bloq-concurrent-${occurrence.ordinal}`,
      })),
    });
    const second = input({
      operationId: '55555555-5555-4555-8555-555555555555',
      sessionHash: 'c'.repeat(64),
      payloadHash: 'd'.repeat(64),
      occurrences: input().occurrences.map((occurrence) => ({
        ...occurrence,
        gcalEventId: `bloq-concurrent-${occurrence.ordinal}`,
      })),
    });

    const results = await Promise.all([
      agendaBloqueioOperacoes.createPlan(first),
      agendaBloqueioOperacoes.createPlan(second),
    ]);

    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(new Set(results.map((result) => result.operation.id))).toEqual(
      new Set([results[0]?.operation.id]),
    );
    const counts = await exec<{ operations: string; occurrences: string }>(
      `SELECT (SELECT count(*) FROM agenda_bloqueio_operacoes
                WHERE tenant_id = $1 AND slot = $2 AND colaborador_key = $3
                  AND session_hash = $4 AND payload_hash = $5)::text AS operations,
              (SELECT count(*) FROM agenda_bloqueio_operacao_ocorrencias occurrence
                JOIN agenda_bloqueio_operacoes operation ON operation.id = occurrence.operation_id
                WHERE operation.tenant_id = $1 AND operation.slot = $2
                  AND operation.colaborador_key = $3 AND operation.session_hash = $4
                  AND operation.payload_hash = $5)::text AS occurrences`,
      [first.tenantId, first.slot, first.colaboradorId, first.sessionHash, first.payloadHash],
    );
    expect(counts.rows[0]).toEqual({
      operations: '1',
      occurrences: String(first.occurrences.length),
    });
  });

  it('duas recoveries concorrentes só reivindicam uma ocorrência e não rebaixam active', async () => {
    const plan = input({
      operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sessionHash: 'e'.repeat(64),
      payloadHash: 'f'.repeat(64),
      occurrences: input().occurrences.map((occurrence) => ({
        ...occurrence,
        gcalEventId: `bloq-recovery-claim-${occurrence.ordinal}`,
      })),
    });
    await agendaBloqueioOperacoes.createPlan(plan);
    await exec(
      `UPDATE agenda_bloqueio_operacao_ocorrencias
          SET status='recovery_required'
        WHERE operation_id=$1 AND ordinal=1`,
      [plan.operationId],
    );

    const claims = await Promise.all([
      agendaBloqueioOperacoes.claimRecovery({
        tenantId: plan.tenantId,
        slot: plan.slot,
        operationId: plan.operationId,
        ordinal: 1,
      }),
      agendaBloqueioOperacoes.claimRecovery({
        tenantId: plan.tenantId,
        slot: plan.slot,
        operationId: plan.operationId,
        ordinal: 1,
      }),
    ]);
    expect(claims.filter((claim) => claim != null)).toHaveLength(1);

    await expect(
      agendaBloqueioOperacoes.markOccurrence({
        tenantId: plan.tenantId,
        slot: plan.slot,
        operationId: plan.operationId,
        ordinal: 1,
        status: 'active',
        expectedStatus: 'gcal_dispatch_started',
      }),
    ).resolves.toBe(true);
    await expect(
      agendaBloqueioOperacoes.markOccurrence({
        tenantId: plan.tenantId,
        slot: plan.slot,
        operationId: plan.operationId,
        ordinal: 1,
        status: 'recovery_required',
        expectedStatus: 'gcal_dispatch_started',
      }),
    ).resolves.toBe(false);
    const persisted = await exec<{ status: string }>(
      `SELECT status FROM agenda_bloqueio_operacao_ocorrencias
        WHERE operation_id=$1 AND ordinal=1`,
      [plan.operationId],
    );
    expect(persisted.rows[0]?.status).toBe('active');
  });

  it('dispatch normal órfão só pode ser recuperado depois da expiração da lease', async () => {
    const plan = input({
      operationId: 'abababab-abab-4bab-8bab-abababababab',
      sessionHash: 'g'.repeat(64),
      payloadHash: 'h'.repeat(64),
      occurrences: input().occurrences.map((occurrence) => ({
        ...occurrence,
        gcalEventId: `bloq-normal-crash-${occurrence.ordinal}`,
      })),
    });
    await agendaBloqueioOperacoes.createPlan(plan);
    await agendaBloqueioOperacoes.claimDispatch({
      tenantId: plan.tenantId,
      slot: plan.slot,
      operationId: plan.operationId,
      ordinal: 1,
    });

    await expect(
      agendaBloqueioOperacoes.claimRecovery({
        tenantId: plan.tenantId,
        slot: plan.slot,
        operationId: plan.operationId,
        ordinal: 1,
      }),
    ).resolves.toBeNull();
    await exec(
      `UPDATE agenda_bloqueio_operacao_ocorrencias
          SET updated_at=now() - interval '61 seconds'
        WHERE operation_id=$1 AND ordinal=1`,
      [plan.operationId],
    );
    await expect(
      agendaBloqueioOperacoes.claimRecovery({
        tenantId: plan.tenantId,
        slot: plan.slot,
        operationId: plan.operationId,
        ordinal: 1,
      }),
    ).resolves.toEqual(expect.objectContaining({ status: 'gcal_dispatch_started' }));
  });

  it('dispatch de recovery órfão também volta a ser recuperável só após a lease', async () => {
    const plan = input({
      operationId: 'bcbcbcbc-bcbc-4bcc-8bcc-bcbcbcbcbcbc',
      sessionHash: 'i'.repeat(64),
      payloadHash: 'j'.repeat(64),
      occurrences: input().occurrences.map((occurrence) => ({
        ...occurrence,
        gcalEventId: `bloq-recovery-crash-${occurrence.ordinal}`,
      })),
    });
    await agendaBloqueioOperacoes.createPlan(plan);
    await exec(
      `UPDATE agenda_bloqueio_operacao_ocorrencias
          SET status='recovery_required'
        WHERE operation_id=$1 AND ordinal=1`,
      [plan.operationId],
    );
    await agendaBloqueioOperacoes.claimRecovery({
      tenantId: plan.tenantId,
      slot: plan.slot,
      operationId: plan.operationId,
      ordinal: 1,
    });

    await expect(
      agendaBloqueioOperacoes.claimRecovery({
        tenantId: plan.tenantId,
        slot: plan.slot,
        operationId: plan.operationId,
        ordinal: 1,
      }),
    ).resolves.toBeNull();
    await exec(
      `UPDATE agenda_bloqueio_operacao_ocorrencias
          SET updated_at=now() - interval '61 seconds'
        WHERE operation_id=$1 AND ordinal=1`,
      [plan.operationId],
    );
    await expect(
      agendaBloqueioOperacoes.claimRecovery({
        tenantId: plan.tenantId,
        slot: plan.slot,
        operationId: plan.operationId,
        ordinal: 1,
      }),
    ).resolves.toEqual(expect.objectContaining({ status: 'gcal_dispatch_started' }));
  });

  it('detecta serie_id legada no escopo certo e ignora uma operação já durável', async () => {
    const scope = {
      tenantId: '00000000-0000-4000-8000-000000000001',
      slot: 'clone_legacy',
      colaboradorId: 7,
      inicioAt: '2026-10-01T12:00:00.000Z',
      fimAt: '2026-10-01T13:00:00.000Z',
      tipo: 'almoco' as const,
      motivo: 'intervalo',
    };
    await exec(
      `INSERT INTO agenda_bloqueios (
        id, tenant_id, slot, colaborador_id, serie_id, gcal_event_id,
        inicio_at, fim_at, timezone, tipo, motivo, status, created_by_role
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active','owner')`,
      [
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        scope.tenantId,
        scope.slot,
        scope.colaboradorId,
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        'legacy-event',
        scope.inicioAt,
        scope.fimAt,
        'America/Sao_Paulo',
        scope.tipo,
        scope.motivo,
      ],
    );
    await expect(agendaBloqueios.hasLegacySerieMatchingCreate(scope)).resolves.toBe(true);
    await expect(
      agendaBloqueios.hasLegacySerieMatchingCreate({ ...scope, slot: 'outro_slot' }),
    ).resolves.toBe(false);
    await expect(
      agendaBloqueios.hasLegacySerieMatchingCreate({ ...scope, colaboradorId: 8 }),
    ).resolves.toBe(false);

    const durable = input({
      operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      tenantId: scope.tenantId,
      slot: 'clone_duravel',
      colaboradorId: scope.colaboradorId,
      sessionHash: 'k'.repeat(64),
      payloadHash: 'l'.repeat(64),
      occurrences: input().occurrences.map((occurrence) => ({
        ...occurrence,
        gcalEventId: `bloq-duravel-${occurrence.ordinal}`,
      })),
    });
    await agendaBloqueioOperacoes.createPlan(durable);
    await exec(
      `INSERT INTO agenda_bloqueios (
        id, tenant_id, slot, colaborador_id, serie_id, gcal_event_id,
        inicio_at, fim_at, timezone, tipo, motivo, status, created_by_role
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'creating','owner')`,
      [
        'ffffffff-ffff-4fff-8fff-ffffffffffff',
        durable.tenantId,
        durable.slot,
        durable.colaboradorId,
        durable.operationId,
        'durable-event',
        scope.inicioAt,
        scope.fimAt,
        'America/Sao_Paulo',
        scope.tipo,
        scope.motivo,
      ],
    );
    await expect(
      agendaBloqueios.hasLegacySerieMatchingCreate({ ...scope, slot: durable.slot }),
    ).resolves.toBe(false);
  });

  it('fencing impede executor vencido de anexar, confirmar ou persistir resultado após takeover', async () => {
    const plan = input({
      operationId: '12121212-1212-4212-8212-121212121212',
      sessionHash: 'm'.repeat(64),
      payloadHash: 'n'.repeat(64),
      occurrences: input().occurrences.map((occurrence) => ({
        ...occurrence,
        gcalEventId: `bloq-fencing-${occurrence.ordinal}`,
      })),
    });
    await agendaBloqueioOperacoes.createPlan(plan);
    const oldAttempt = await agendaBloqueioOperacoes.claimDispatch({
      tenantId: plan.tenantId,
      slot: plan.slot,
      operationId: plan.operationId,
      ordinal: 1,
    });
    expect(oldAttempt).toEqual(expect.objectContaining({ attempt_version: 1 }));
    await exec(
      `UPDATE agenda_bloqueio_operacao_ocorrencias
          SET updated_at=now() - interval '61 seconds'
        WHERE operation_id=$1 AND ordinal=1`,
      [plan.operationId],
    );
    const newAttempt = await agendaBloqueioOperacoes.claimRecovery({
      tenantId: plan.tenantId,
      slot: plan.slot,
      operationId: plan.operationId,
      ordinal: 1,
    });
    expect(newAttempt).toEqual(expect.objectContaining({ attempt_version: 2 }));
    if (!oldAttempt || !newAttempt) throw new Error('claim de fencing inconsistente');
    await exec(
      `INSERT INTO agenda_bloqueios (
        id, tenant_id, slot, colaborador_id, serie_id, gcal_event_id,
        inicio_at, fim_at, timezone, tipo, motivo, status, created_by_role
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'creating','owner')`,
      [
        oldAttempt.bloqueio_id,
        plan.tenantId,
        plan.slot,
        plan.colaboradorId,
        plan.operationId,
        oldAttempt.gcal_event_id,
        oldAttempt.inicio_at,
        oldAttempt.fim_at,
        plan.timezone,
        plan.tipo,
        plan.motivo,
      ],
    );
    await expect(
      agendaBloqueios.attachGcalEventIdForDispatch({
        tenantId: plan.tenantId,
        slot: plan.slot,
        bloqueioId: oldAttempt.bloqueio_id,
        gcalEventId: oldAttempt.gcal_event_id,
        operationId: plan.operationId,
        ordinal: 1,
        attemptVersion: oldAttempt.attempt_version,
      }),
    ).resolves.toBeNull();
    await expect(
      agendaBloqueioOperacoes.markOccurrence({
        tenantId: plan.tenantId,
        slot: plan.slot,
        operationId: plan.operationId,
        ordinal: 1,
        status: 'recovery_required',
        expectedStatus: 'gcal_dispatch_started',
        attemptVersion: oldAttempt.attempt_version,
      }),
    ).resolves.toBe(false);
    await expect(
      agendaBloqueioOperacoes.markOperationResult({
        tenantId: plan.tenantId,
        slot: plan.slot,
        operationId: plan.operationId,
        colaboradorId: plan.colaboradorId,
        status: 'recovery_required',
        responseStatus: 207,
        responseBody: { ok: false },
        expectedAttemptVersion: oldAttempt.attempt_version,
      }),
    ).resolves.toBe(false);

    await expect(
      agendaBloqueios.attachGcalEventIdForDispatch({
        tenantId: plan.tenantId,
        slot: plan.slot,
        bloqueioId: newAttempt.bloqueio_id,
        gcalEventId: newAttempt.gcal_event_id,
        operationId: plan.operationId,
        ordinal: 1,
        attemptVersion: newAttempt.attempt_version,
      }),
    ).resolves.toEqual(expect.objectContaining({ status: 'active' }));
    await expect(
      agendaBloqueioOperacoes.markOccurrence({
        tenantId: plan.tenantId,
        slot: plan.slot,
        operationId: plan.operationId,
        ordinal: 1,
        status: 'active',
        expectedStatus: 'gcal_dispatch_started',
        attemptVersion: newAttempt.attempt_version,
      }),
    ).resolves.toBe(true);
    await expect(
      agendaBloqueioOperacoes.markOperationResult({
        tenantId: plan.tenantId,
        slot: plan.slot,
        operationId: plan.operationId,
        colaboradorId: plan.colaboradorId,
        status: 'complete',
        responseStatus: 201,
        responseBody: { ok: true },
        expectedAttemptVersion: newAttempt.attempt_version,
      }),
    ).resolves.toBe(true);
  });
});
