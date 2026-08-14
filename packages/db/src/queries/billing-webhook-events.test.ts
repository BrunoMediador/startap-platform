import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Charge = { id: string; slot: string; amount_cents: number; status: string };
type Scenario = {
  dedupeInserted: boolean;
  charge: Charge | null;
  chargeByExternal?: Charge | null;
  nextDueDate?: string | null;
  firstPayment?: boolean;
  flowEnabled?: boolean;
  suspendedKind?: string | null;
  resumeRows?: number;
  failOn?: string;
};

const calls: { sql: string; params: unknown[] }[] = [];

function operationalRow(s: Scenario, afterResume = false) {
  const charge = s.charge ?? s.chargeByExternal;
  const resumed = afterResume && (s.resumeRows ?? 0) > 0;
  return {
    slot: charge?.slot ?? 'clone_x',
    tenant_id: 'tenant-x',
    clone_status: 'conectado',
    atendimento_configured: true,
    waha_sessao: 'sess_x',
    flow_enabled: resumed ? true : (s.flowEnabled ?? true),
    suspended_reason: resumed ? null : 'pausa',
    suspended_kind: resumed ? null : (s.suspendedKind ?? null),
    suspended_at: resumed ? null : new Date('2026-08-01T00:00:00Z'),
    next_due_date: s.nextDueDate ?? null,
    billing_amount_cents: charge?.amount_cents ?? 8500,
  };
}

function makeClient(s: Scenario) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const q = sql.replace(/\s+/g, ' ');
      if (s.failOn && q.includes(s.failOn)) throw new Error('falha injetada');
      if (q.includes('BEGIN') || q.includes('COMMIT') || q.includes('ROLLBACK')) {
        return { rows: [], rowCount: 0 };
      }
      if (q.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };

      if (q.includes('FROM billing_charges') && q.includes('abacate_charge_id = $1')) {
        if (q.includes('FOR UPDATE')) {
          return s.charge ? { rows: [s.charge], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        return s.charge
          ? { rows: [{ slot: s.charge.slot }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (q.includes('FROM billing_charges') && q.includes('external_id = $1')) {
        if (q.includes('FOR UPDATE')) {
          return s.chargeByExternal
            ? { rows: [s.chargeByExternal], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        return s.chargeByExternal
          ? { rows: [{ slot: s.chargeByExternal.slot }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (q.includes('INSERT INTO billing_webhook_events') && q.includes('ON CONFLICT')) {
        return s.dedupeInserted
          ? { rows: [{ event_id: 'evt_1' }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (q.includes('UPDATE billing_webhook_events SET charge_id')) {
        return { rows: [], rowCount: 1 };
      }
      if (q.includes('UPDATE billing_webhook_events SET processed_at')) {
        return { rows: [], rowCount: 1 };
      }
      if (q.includes('UPDATE billing_charges') && q.includes("status = 'paid'")) {
        return { rows: [], rowCount: 1 };
      }

      if (q.includes('FROM flow_clones') && q.includes('FOR UPDATE')) {
        return { rows: [operationalRow(s)], rowCount: 1 };
      }
      if (q.includes('FROM client_billing') && q.includes('FOR UPDATE')) {
        return {
          rows: [
            {
              next_due_date: s.nextDueDate ?? null,
              billing_amount_cents: (s.charge ?? s.chargeByExternal)?.amount_cents ?? 8500,
            },
          ],
          rowCount: 1,
        };
      }
      if (q.includes('FROM client_billing') && q.includes('last_payment_at IS NULL')) {
        return {
          rows: [
            {
              next_due_date: s.nextDueDate ?? null,
              first_payment: s.firstPayment ?? true,
            },
          ],
          rowCount: 1,
        };
      }
      if (q.includes('INSERT INTO client_billing')) {
        return {
          rows: [
            {
              slot: (s.charge ?? s.chargeByExternal)?.slot ?? 'clone_x',
              next_due_date: params?.[1],
              amount_cents: (s.charge ?? s.chargeByExternal)?.amount_cents ?? 8500,
              last_payment_at: new Date(),
              status: 'active',
              notes: null,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        };
      }
      if (q.includes('UPDATE flow_clones') && q.includes("suspended_kind = 'billing'")) {
        return (s.resumeRows ?? 0) > 0
          ? { rows: [{ slot: (s.charge ?? s.chargeByExternal)?.slot }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (q.includes('INSERT INTO flow_suspension_log')) return { rows: [], rowCount: 1 };
      if (q.includes('FROM flow_clones fc') && q.includes('LEFT JOIN client_billing')) {
        return { rows: [operationalRow(s, true)], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
}

let currentClient: ReturnType<typeof makeClient>;
vi.mock('../client.js', () => ({
  pool: { connect: vi.fn(async () => currentClient) },
  query: vi.fn(),
}));

import { applyPaidWebhook } from './billing-webhook-events.js';

const BASE_INPUT = {
  eventId: 'evt_1',
  event: 'transparent.completed',
  abacateChargeId: 'pix_char_abc',
  paidAmountCents: 19900,
  redactedPayload: { id: 'evt_1', brCode: '[REDACTED]' },
};
const CHARGE: Charge = {
  id: '10',
  slot: 'barbearia-cirilo',
  amount_cents: 19900,
  status: 'pending',
};

function setup(overrides: Partial<Scenario> = {}) {
  calls.length = 0;
  currentClient = makeClient({
    dedupeInserted: true,
    charge: CHARGE,
    nextDueDate: '2099-06-10',
    flowEnabled: false,
    suspendedKind: 'billing',
    resumeRows: 1,
    ...overrides,
  });
}

function sqls(): string[] {
  return calls.map(({ sql }) => sql.replace(/\s+/g, ' ').trim());
}

function ran(fragment: string): boolean {
  return sqls().some((sql) => sql.includes(fragment));
}

function dueWritten(): string | undefined {
  return calls.find(({ sql }) => sql.includes('INSERT INTO client_billing'))?.params[1] as
    | string
    | undefined;
}

beforeEach(() => {
  calls.length = 0;
});

describe('applyPaidWebhook — dedupe, reconciliação e lock order', () => {
  it('replay descobre slot/adquire advisory, mas para no dedupe sem row lock ou efeito', async () => {
    setup({ dedupeInserted: false });
    const result = await applyPaidWebhook(BASE_INPUT);
    expect(result.outcome).toBe('duplicate');
    expect(ran('pg_advisory_xact_lock')).toBe(true);
    expect(ran('FOR UPDATE')).toBe(false);
    expect(ran('UPDATE billing_charges')).toBe(false);
    expect(ran('COMMIT')).toBe(true);
  });

  it('órfão sem slot registra/processa dedupe sem inventar advisory', async () => {
    setup({ charge: null, chargeByExternal: null });
    const result = await applyPaidWebhook(BASE_INPUT);
    expect(result.outcome).toBe('orphan');
    expect(ran('pg_advisory_xact_lock')).toBe(false);
    expect(ran('UPDATE billing_charges')).toBe(false);
  });

  it('already_paid é idempotente e não avança billing', async () => {
    setup({ charge: { ...CHARGE, status: 'paid' }, resumeRows: 0 });
    const result = await applyPaidWebhook(BASE_INPUT);
    expect(result.outcome).toBe('already_paid');
    expect(ran('INSERT INTO client_billing')).toBe(false);
    expect(result.firstPayment).toBe(false);
  });

  it('underpaid marca charge, relê estado e não chama transição de billing/resume', async () => {
    setup();
    const result = await applyPaidWebhook({ ...BASE_INPUT, paidAmountCents: 1 });
    expect(result.outcome).toBe('underpaid');
    expect(result.operational?.slot).toBe(CHARGE.slot);
    expect(ran('UPDATE billing_charges')).toBe(true);
    expect(ran('INSERT INTO client_billing')).toBe(false);
    expect(ran('UPDATE flow_clones')).toBe(false);
  });

  it('applied usa advisory antes de charge FOR UPDATE e núcleo antes da releitura final', async () => {
    setup();
    const result = await applyPaidWebhook(BASE_INPUT);
    expect(result).toMatchObject({
      outcome: 'applied',
      slot: CHARGE.slot,
      resumed: true,
      firstPayment: true,
    });
    expect(result.billing?.next_due_date).toBe('2099-07-10');
    expect(result.operational?.flow_enabled).toBe(true);

    const order = sqls();
    const advisory = order.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
    const dedupe = order.findIndex((sql) => sql.includes('INSERT INTO billing_webhook_events'));
    const chargeLock = order.findIndex(
      (sql) => sql.includes('FROM billing_charges') && sql.includes('FOR UPDATE'),
    );
    const advance = order.findIndex((sql) => sql.includes('INSERT INTO client_billing'));
    const finalRead = order.findIndex((sql) => sql.includes('FROM flow_clones fc'));
    const commit = order.findIndex((sql) => sql === 'COMMIT');
    expect(advisory).toBeLessThan(dedupe);
    expect(dedupe).toBeLessThan(chargeLock);
    expect(chargeLock).toBeLessThan(advance);
    expect(advance).toBeLessThan(finalRead);
    expect(finalRead).toBeLessThan(commit);
    expect(ran('INSERT INTO flow_suspension_log')).toBe(true);
  });

  it.each(['owner_request', 'manual_other', 'abuse'])(
    'pagamento preserva suspensão %s e não cria log de resume',
    async (kind) => {
      setup({ suspendedKind: kind, flowEnabled: false, resumeRows: 0 });
      const result = await applyPaidWebhook(BASE_INPUT);
      expect(result.outcome).toBe('applied');
      expect(result.resumed).toBe(false);
      expect(result.operational?.suspended_kind).toBe(kind);
      expect(ran('INSERT INTO flow_suspension_log')).toBe(false);
    },
  );

  it('renovação mantém firstPayment=false', async () => {
    setup({ firstPayment: false, resumeRows: 0, flowEnabled: true, suspendedKind: null });
    expect((await applyPaidWebhook(BASE_INPUT)).firstPayment).toBe(false);
  });
});

describe('fallback external_id e avanço canônico', () => {
  it('QR antigo descobre/revalida a pending mais recente por external_id', async () => {
    const fallback = { ...CHARGE, id: '77', amount_cents: 8500 };
    setup({ charge: null, chargeByExternal: fallback, resumeRows: 0 });
    const result = await applyPaidWebhook({
      ...BASE_INPUT,
      abacateChargeId: 'pix_char_antigo',
      externalId: 'barbearia-cirilo-2099-06-10',
      paidAmountCents: 8500,
    });
    expect(result.outcome).toBe('applied');
    const fallbackSql = sqls().filter((sql) => sql.includes('external_id = $1'));
    expect(fallbackSql).toHaveLength(2);
    expect(fallbackSql[1]).toContain("status = 'pending'");
    expect(fallbackSql[1]).toContain('ORDER BY id DESC');
    expect(fallbackSql[1]).toContain('LIMIT 1');
    expect(fallbackSql[1]).toContain('FOR UPDATE');
    const linked = calls.find(({ sql }) => sql.includes('SET charge_id'));
    expect(linked?.params[0]).toBe('77');
  });

  it('vencido sempre avança de max(due, hoje), inclusive com parâmetro legado false', async () => {
    setup({ nextDueDate: '2020-01-10' });
    const result = await applyPaidWebhook({ ...BASE_INPUT, dueDateModel: false });
    expect(result.outcome).toBe('applied');
    expect(dueWritten()).toBeDefined();
    expect((dueWritten() as string) > new Date().toISOString().slice(0, 10)).toBe(true);
  });

  it('em dia avança a partir do vencimento e não perde período pago', async () => {
    setup({ nextDueDate: '2099-06-10' });
    await applyPaidWebhook(BASE_INPUT);
    expect(dueWritten()).toBe('2099-07-10');
  });
});

describe('atomicidade', () => {
  it('falha no núcleo faz rollback, não commit, e libera o client', async () => {
    setup({ failOn: 'INSERT INTO client_billing' });
    await expect(applyPaidWebhook(BASE_INPUT)).rejects.toThrow('falha injetada');
    expect(ran('ROLLBACK')).toBe(true);
    expect(ran('COMMIT')).toBe(false);
    expect(currentClient.release).toHaveBeenCalledTimes(1);
  });
});

describe('anti-coluna-fantasma billing_charges', () => {
  it('SET do UPDATE só referencia colunas reais da migration 041', async () => {
    setup();
    await applyPaidWebhook(BASE_INPUT);
    const update = sqls().find(
      (sql) => sql.includes('UPDATE billing_charges') && sql.includes("status = 'paid'"),
    );
    expect(update).toBeDefined();

    const here = dirname(fileURLToPath(import.meta.url));
    const migration = readFileSync(
      resolve(here, '../../migrations/041_billing_charges.sql'),
      'utf8',
    );
    const table = migration.match(
      /CREATE TABLE IF NOT EXISTS billing_charges\s*\(([\s\S]*?)\n\)\s*;/i,
    );
    expect(table).toBeTruthy();
    const columns = new Set(
      (table?.[1] ?? '')
        .split('\n')
        .map(
          (line) =>
            line
              .replace(/--.*$/, '')
              .trim()
              .match(/^([a-z_][a-z0-9_]*)\s+/i)?.[1],
        )
        .filter((column): column is string => Boolean(column)),
    );
    const set = update?.match(/ SET ([\s\S]*?) WHERE /i)?.[1] ?? '';
    for (const assignment of set.split(',')) {
      const column = assignment.trim().match(/^([a-z_][a-z0-9_]*)\s*=/i)?.[1];
      if (column) expect(columns.has(column), `coluna ${column}`).toBe(true);
    }
  });
});
