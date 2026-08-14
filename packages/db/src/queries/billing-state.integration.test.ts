/**
 * SCRUM-170 — prova as transições de billing/owner contra PostgreSQL real.
 *
 * Rodar com:
 *   PG_TEST_URL=postgres://user:pass@localhost:5432/test_db \
 *     npx vitest run billing-state.integration
 *
 * Sem PG_TEST_URL a suíte auto-skipa. Cada processo usa schema próprio; nenhum dado
 * fora desse schema é lido ou alterado.
 */
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PG_TEST_URL = process.env.PG_TEST_URL;
const describeIf = PG_TEST_URL ? describe : describe.skip;
const SCHEMA = `itest_billing_state_${process.pid}`;

if (!PG_TEST_URL) {
  console.warn(
    '[billing-state.integration] PG_TEST_URL ausente — suíte PostgreSQL 16 PULADA; ' +
      'concorrência/locks não foram exercitados localmente.',
  );
}

type BillingPaymentsModule = typeof import('./billing-payments.js');
type BillingWebhookModule = typeof import('./billing-webhook-events.js');
type FlowClonesModule = typeof import('./flow-clones.js');

describeIf('SCRUM-170 billing + estado composto contra PostgreSQL real', () => {
  let pgPool: Pool;
  let billingPayments: BillingPaymentsModule;
  let billingWebhookEvents: BillingWebhookModule;
  let flowClones: FlowClonesModule;

  async function exec<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ) {
    return pgPool.query<T>(sql, params);
  }

  function dateFromToday(days: number): string {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  async function seedSlot(input: {
    slot: string;
    flowEnabled?: boolean;
    suspendedKind?: string | null;
    due?: string | null;
    amountCents?: number;
  }): Promise<void> {
    const flowEnabled = input.flowEnabled ?? true;
    const kind = input.suspendedKind ?? null;
    await exec(
      `INSERT INTO flow_clones
         (slot, matriz_slot, display_name, personalizacao, waha_sessao, status,
          flow_enabled, suspended_kind, suspended_reason, suspended_at)
       VALUES ($1, 'matriz_teste', $1, '{}'::jsonb, 'sess_' || $1, 'conectado',
               $2, $3, CASE WHEN $3::text IS NULL THEN NULL ELSE 'pausa teste' END,
               CASE WHEN $3::text IS NULL THEN NULL ELSE NOW() END)`,
      [input.slot, flowEnabled, kind],
    );
    if (input.due !== undefined) {
      await exec(
        `INSERT INTO client_billing
           (slot, next_due_date, amount_cents, status, tenant_id)
         SELECT slot, $2::date, $3, 'active', tenant_id
           FROM flow_clones
          WHERE slot = $1`,
        [input.slot, input.due, input.amountCents ?? 10_000],
      );
    }
  }

  async function seedCharge(input: {
    slot: string;
    gatewayId: string;
    externalId?: string;
    amountCents?: number;
  }): Promise<void> {
    await exec(
      `INSERT INTO billing_charges
         (slot, external_id, abacate_charge_id, amount_cents, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [
        input.slot,
        input.externalId ?? `${input.slot}-cycle`,
        input.gatewayId,
        input.amountCents ?? 10_000,
      ],
    );
  }

  async function readFlow(slot: string) {
    const result = await exec<{
      flow_enabled: boolean;
      suspended_kind: string | null;
      next_due_date: string | null;
    }>(
      `SELECT fc.flow_enabled, fc.suspended_kind,
              to_char(cb.next_due_date, 'YYYY-MM-DD') AS next_due_date
         FROM flow_clones fc
         LEFT JOIN client_billing cb ON cb.slot = fc.slot
        WHERE fc.slot = $1`,
      [slot],
    );
    return result.rows[0] ?? null;
  }

  async function resumeLogCount(slot: string): Promise<number> {
    const result = await exec<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM flow_suspension_log
        WHERE slot = $1 AND action = 'resume'`,
      [slot],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function beginPayment(slot: string): Promise<PoolClient> {
    const client = await pgPool.connect();
    await client.query('BEGIN');
    await billingPayments.acquireBillingSlotAdvisoryLock(client, slot);
    return client;
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

    const version = await pgPool.query<{ server_version_num: string }>('SHOW server_version_num');
    if (Number(version.rows[0]?.server_version_num ?? 0) < 160_000) {
      throw new Error('billing-state.integration exige PostgreSQL 16+');
    }
    await pgPool.query(`CREATE SCHEMA ${SCHEMA}`);
    await pgPool.query(`CREATE TABLE flow_clones (
      id BIGSERIAL PRIMARY KEY,
      slot TEXT NOT NULL UNIQUE,
      tenant_id UUID NOT NULL DEFAULT gen_random_uuid(),
      matriz_slot TEXT NOT NULL,
      display_name TEXT NOT NULL,
      cliente_nome TEXT,
      cliente_telefone TEXT,
      personalizacao JSONB NOT NULL DEFAULT '{}'::jsonb,
      waha_sessao TEXT,
      waha_shard_id INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'rascunho',
      flow_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      suspended_reason TEXT,
      suspended_kind TEXT,
      suspended_at TIMESTAMPTZ,
      horarios_funcionamento JSONB,
      servicos JSONB,
      timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
      prompt_custom BOOLEAN NOT NULL DEFAULT FALSE,
      modo_atendente_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      billing_from_agenda_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      first_connected_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pgPool.query(`CREATE TABLE client_billing (
      slot TEXT PRIMARY KEY REFERENCES flow_clones(slot),
      tenant_id UUID,
      next_due_date DATE,
      amount_cents INTEGER,
      last_payment_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pgPool.query(`CREATE TABLE flow_suspension_log (
      id BIGSERIAL PRIMARY KEY,
      slot TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT,
      actor TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pgPool.query(`CREATE TABLE billing_charges (
      id BIGSERIAL PRIMARY KEY,
      slot TEXT NOT NULL REFERENCES flow_clones(slot),
      external_id TEXT NOT NULL,
      abacate_charge_id TEXT NOT NULL UNIQUE,
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      paid_at TIMESTAMPTZ,
      paid_amount_cents INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pgPool.query(`CREATE TABLE billing_webhook_events (
      event_id TEXT PRIMARY KEY,
      event TEXT NOT NULL,
      charge_id BIGINT REFERENCES billing_charges(id),
      payload JSONB,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ
    )`);

    billingPayments = await import('./billing-payments.js');
    billingWebhookEvents = await import('./billing-webhook-events.js');
    flowClones = await import('./flow-clones.js');
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

  it.each([
    ['billing', true],
    ['owner_request', false],
    ['manual_other', false],
    ['abuse', false],
  ])('manual preserva a matriz de suspensão %s (resumed=%s)', async (kind, shouldResume) => {
    const slot = `manual_${kind}`;
    await seedSlot({ slot, flowEnabled: false, suspendedKind: kind, due: '2099-01-15' });

    const result = await billingPayments.registerManualPayment(
      {
        slot,
        actor: 'painel:itest',
        resumeReason: 'pagamento manual confirmado',
        now: new Date('2026-08-13T12:00:00Z'),
      },
      pgPool,
    );

    expect(result?.resumed).toBe(shouldResume);
    expect(result?.billing.next_due_date).toBe('2099-02-15');
    expect(result?.operational.flow_enabled).toBe(shouldResume);
    expect(result?.operational.suspended_kind).toBe(shouldResume ? null : kind);
    expect(await resumeLogCount(slot)).toBe(shouldResume ? 1 : 0);
  });

  it('manual em slot inexistente retorna 404-ready sem billing, log ou clone', async () => {
    const before = await exec<{ billing: string; logs: string }>(
      `SELECT (SELECT count(*) FROM client_billing)::text AS billing,
              (SELECT count(*) FROM flow_suspension_log)::text AS logs`,
    );
    const result = await billingPayments.registerManualPayment(
      {
        slot: 'manual_missing',
        actor: 'painel:itest',
        resumeReason: 'pagamento manual confirmado',
      },
      pgPool,
    );
    const after = await exec<{ billing: string; logs: string }>(
      `SELECT (SELECT count(*) FROM client_billing)::text AS billing,
              (SELECT count(*) FROM flow_suspension_log)::text AS logs`,
    );

    expect(result).toBeNull();
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(await readFlow('manual_missing')).toBeNull();
  });

  it('owner resume bloqueia overdue, preserva owner_request e não cria log', async () => {
    const slot = 'owner_overdue';
    await seedSlot({
      slot,
      flowEnabled: false,
      suspendedKind: 'owner_request',
      due: dateFromToday(-10),
    });

    const result = await flowClones.resumeBotByOwner(slot, 'portal:itest', {
      billingOverdueSilenceOn: true,
    });

    expect(result).toMatchObject({ changed: false, outcome: 'billing_overdue' });
    expect(await readFlow(slot)).toMatchObject({
      flow_enabled: false,
      suspended_kind: 'owner_request',
    });
    expect(await resumeLogCount(slot)).toBe(0);
  });

  it('owner resume respeita carência e retry idempotente; já ativo overdue segue bloqueado', async () => {
    const inGrace = 'owner_grace';
    const activeOverdue = 'active_overdue';
    await seedSlot({
      slot: inGrace,
      flowEnabled: false,
      suspendedKind: 'owner_request',
      due: dateFromToday(-2),
    });
    await seedSlot({ slot: activeOverdue, flowEnabled: true, due: dateFromToday(-10) });

    const first = await flowClones.resumeBotByOwner(inGrace, 'portal:itest', {
      billingOverdueSilenceOn: true,
    });
    const retry = await flowClones.resumeBotByOwner(inGrace, 'portal:itest', {
      billingOverdueSilenceOn: true,
    });
    const blocked = await flowClones.resumeBotByOwner(activeOverdue, 'portal:itest', {
      billingOverdueSilenceOn: true,
    });

    expect(first).toMatchObject({ changed: true, outcome: 'resumed', flow_enabled: true });
    expect(retry).toMatchObject({ changed: false, outcome: 'already_active', flow_enabled: true });
    expect(blocked).toMatchObject({ changed: false, outcome: 'billing_overdue' });
    expect(await resumeLogCount(inGrace)).toBe(1);
  });

  it('webhook usa o núcleo real: crédito, first payment, resume billing e releitura final', async () => {
    const slot = 'webhook_billing';
    await seedSlot({
      slot,
      flowEnabled: false,
      suspendedKind: 'billing',
      due: '2099-04-20',
    });
    await seedCharge({ slot, gatewayId: 'pix_webhook_billing' });

    const result = await billingWebhookEvents.applyPaidWebhook({
      eventId: 'evt_webhook_billing',
      event: 'transparent.completed',
      abacateChargeId: 'pix_webhook_billing',
      paidAmountCents: 10_000,
      redactedPayload: { id: 'evt_webhook_billing' },
    });

    expect(result).toMatchObject({
      outcome: 'applied',
      slot,
      resumed: true,
      firstPayment: true,
    });
    expect(result.billing?.next_due_date).toBe('2099-05-20');
    expect(result.operational).toMatchObject({ flow_enabled: true, suspended_kind: null });
    expect(await resumeLogCount(slot)).toBe(1);
  });

  it('webhook × manual no mesmo slot serializam e não perdem nenhum avanço', async () => {
    const slot = 'same_slot_race';
    await seedSlot({
      slot,
      flowEnabled: false,
      suspendedKind: 'owner_request',
      due: '2099-01-15',
    });
    await seedCharge({ slot, gatewayId: 'pix_same_slot' });

    const [manual, webhook] = await Promise.all([
      billingPayments.registerManualPayment(
        { slot, actor: 'painel:itest', resumeReason: 'manual concorrente' },
        pgPool,
      ),
      billingWebhookEvents.applyPaidWebhook({
        eventId: 'evt_same_slot',
        event: 'transparent.completed',
        abacateChargeId: 'pix_same_slot',
        paidAmountCents: 10_000,
        redactedPayload: { id: 'evt_same_slot' },
      }),
    ]);

    expect(manual?.resumed).toBe(false);
    expect(webhook).toMatchObject({ outcome: 'applied', resumed: false });
    expect(await readFlow(slot)).toEqual({
      flow_enabled: false,
      suspended_kind: 'owner_request',
      next_due_date: '2099-03-15',
    });
    expect(await resumeLogCount(slot)).toBe(0);
  });

  it('manual × owner resume no mesmo slot serializam e o owner reavalia o billing pós-pagamento', async () => {
    const slot = 'manual_owner_race';
    await seedSlot({
      slot,
      flowEnabled: false,
      suspendedKind: 'owner_request',
      due: dateFromToday(-10),
    });

    const manualClient = await beginPayment(slot);
    let committed = false;
    try {
      const manual = await billingPayments.applyPaymentTransitionInTransaction(manualClient, {
        slot,
        actor: 'painel:itest',
        resumeReason: 'manual concorrente com owner',
      });
      expect(manual).toMatchObject({ resumed: false });

      const ownerPromise = flowClones.resumeBotByOwner(slot, 'portal:itest', {
        billingOverdueSilenceOn: true,
      });
      const whileManualOpen = await Promise.race([
        ownerPromise.then(() => 'completed'),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 150)),
      ]);
      expect(whileManualOpen).toBe('blocked');

      await manualClient.query('COMMIT');
      committed = true;
      const owner = await ownerPromise;
      expect(owner).toMatchObject({ changed: true, outcome: 'resumed', flow_enabled: true });
    } finally {
      if (!committed) await manualClient.query('ROLLBACK').catch(() => {});
      manualClient.release();
    }

    const state = await readFlow(slot);
    expect(state?.flow_enabled).toBe(true);
    expect(state?.suspended_kind).toBeNull();
    expect((state?.next_due_date ?? '') > dateFromToday(0)).toBe(true);
    expect(await resumeLogCount(slot)).toBe(1);
  });

  it('advisory de um slot não bloqueia pagamento de outro tenant/slot', async () => {
    const lockedSlot = 'cross_slot_locked';
    const freeSlot = 'cross_slot_free';
    await seedSlot({ slot: lockedSlot, due: '2099-01-01' });
    await seedSlot({ slot: freeSlot, due: '2099-02-01' });
    const lockedClient = await beginPayment(lockedSlot);

    try {
      const outcome = await Promise.race([
        billingPayments
          .registerManualPayment(
            { slot: freeSlot, actor: 'painel:itest', resumeReason: 'slot independente' },
            pgPool,
          )
          .then(() => 'completed'),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1_500)),
      ]);
      expect(outcome).toBe('completed');
    } finally {
      await lockedClient.query('ROLLBACK');
      lockedClient.release();
    }
  });

  it('leitor nunca observa transição parcial e vê snapshot final só depois do commit', async () => {
    const slot = 'read_consistency';
    await seedSlot({
      slot,
      flowEnabled: false,
      suspendedKind: 'billing',
      due: '2099-06-10',
    });
    const client = await beginPayment(slot);
    let committed = false;
    try {
      const transition = await billingPayments.applyPaymentTransitionInTransaction(client, {
        slot,
        actor: 'itest',
        resumeReason: 'isolamento',
      });
      expect(transition).toMatchObject({ resumed: true });

      expect(await readFlow(slot)).toEqual({
        flow_enabled: false,
        suspended_kind: 'billing',
        next_due_date: '2099-06-10',
      });
      await client.query('COMMIT');
      committed = true;
      expect(await readFlow(slot)).toEqual({
        flow_enabled: true,
        suspended_kind: null,
        next_due_date: '2099-07-10',
      });
    } finally {
      if (!committed) await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('rollback remove billing/log/resume, libera lock e permite retry íntegro', async () => {
    const slot = 'rollback_retry';
    await seedSlot({
      slot,
      flowEnabled: false,
      suspendedKind: 'billing',
      due: '2099-08-05',
    });
    const client = await beginPayment(slot);
    try {
      await billingPayments.applyPaymentTransitionInTransaction(client, {
        slot,
        actor: 'itest',
        resumeReason: 'será revertido',
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    expect(await readFlow(slot)).toEqual({
      flow_enabled: false,
      suspended_kind: 'billing',
      next_due_date: '2099-08-05',
    });
    expect(await resumeLogCount(slot)).toBe(0);

    const retry = await billingPayments.registerManualPayment(
      { slot, actor: 'painel:itest', resumeReason: 'retry após rollback' },
      pgPool,
    );
    expect(retry).toMatchObject({ resumed: true });
    expect(retry?.billing.next_due_date).toBe('2099-09-05');
    expect(await resumeLogCount(slot)).toBe(1);
  });

  it('cache estrutural não antecipa commit nem deixa estado operacional stale após commit', async () => {
    const slot = 'cache_post_commit';
    await seedSlot({
      slot,
      flowEnabled: false,
      suspendedKind: 'billing',
      due: '2099-10-03',
    });
    expect(await flowClones.getCloneBySlot(slot)).toMatchObject({
      flow_enabled: false,
      suspended_kind: 'billing',
    });

    const client = await beginPayment(slot);
    let committed = false;
    try {
      await billingPayments.applyPaymentTransitionInTransaction(client, {
        slot,
        actor: 'itest',
        resumeReason: 'cache pós-commit',
      });

      // getCloneBySlot reutiliza o cache estrutural preenchido acima, mas relê o eixo
      // operacional. Outra conexão só enxerga o estado antigo enquanto não há COMMIT.
      expect(await flowClones.getCloneBySlot(slot)).toMatchObject({
        flow_enabled: false,
        suspended_kind: 'billing',
      });
      await client.query('COMMIT');
      committed = true;
    } finally {
      if (!committed) await client.query('ROLLBACK').catch(() => {});
      client.release();
    }

    // O núcleo in-transaction não chamou invalidateCloneCache. Ainda assim, a releitura
    // operacional uncached torna o estado final visível imediatamente após o commit.
    expect(await flowClones.getCloneBySlot(slot)).toMatchObject({
      flow_enabled: true,
      suspended_kind: null,
      next_due_date: '2099-11-03',
    });
  });
});
