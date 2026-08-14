import { describe, expect, it, vi } from 'vitest';
import { registerManualPayment } from './billing-payments.js';

type State = {
  exists?: boolean;
  flowEnabled: boolean;
  suspendedKind: string | null;
  due: string | null;
  firstPayment?: boolean;
  failOn?: string | readonly string[];
};

function makeHarness(state: State) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const resumed = state.flowEnabled === false && state.suspendedKind === 'billing';
  const op = (final = false) => ({
    slot: 'clone_x',
    tenant_id: 'tenant-x',
    clone_status: 'conectado',
    atendimento_configured: true,
    waha_sessao: 'sess_x',
    flow_enabled: final && resumed ? true : state.flowEnabled,
    suspended_reason: final && resumed ? null : 'pausa',
    suspended_kind: final && resumed ? null : state.suspendedKind,
    suspended_at: final && resumed ? null : new Date('2026-08-01T00:00:00Z'),
    next_due_date: final ? '2026-09-13' : state.due,
    billing_amount_cents: 8500,
  });
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const q = sql.replace(/\s+/g, ' ');
      const failures = typeof state.failOn === 'string' ? [state.failOn] : (state.failOn ?? []);
      if (failures.some((fragment) => q.includes(fragment))) {
        throw new Error('falha manual injetada');
      }
      if (q.includes('BEGIN') || q.includes('COMMIT') || q.includes('ROLLBACK')) {
        return { rows: [], rowCount: 0 };
      }
      if (q.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
      if (q.includes('FROM flow_clones') && q.includes('FOR UPDATE')) {
        return state.exists === false ? { rows: [], rowCount: 0 } : { rows: [op()], rowCount: 1 };
      }
      if (q.includes('FROM client_billing') && q.includes('FOR UPDATE')) {
        return {
          rows: [{ next_due_date: state.due, billing_amount_cents: 8500 }],
          rowCount: 1,
        };
      }
      if (q.includes('FROM client_billing') && q.includes('last_payment_at IS NULL')) {
        return {
          rows: [{ next_due_date: state.due, first_payment: state.firstPayment ?? false }],
          rowCount: 1,
        };
      }
      if (q.includes('INSERT INTO client_billing')) {
        return {
          rows: [
            {
              slot: 'clone_x',
              next_due_date: params?.[1],
              amount_cents: params?.[2] ?? 8500,
              last_payment_at: new Date(),
              status: 'active',
              notes: params?.[3] ?? null,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        };
      }
      if (q.includes('UPDATE flow_clones')) {
        return resumed ? { rows: [{ slot: 'clone_x' }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (q.includes('INSERT INTO flow_suspension_log')) return { rows: [], rowCount: 1 };
      if (q.includes('FROM flow_clones fc') && q.includes('LEFT JOIN client_billing')) {
        return { rows: [op(true)], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const dbPool = { connect: vi.fn(async () => client) };
  return { calls, client, dbPool };
}

const INPUT = {
  slot: 'clone_x',
  actor: 'painel:7',
  cycleMonths: 1,
  amountCents: 8500,
  notes: 'manual',
  resumeReason: 'pagamento manual confirmado',
  now: new Date('2026-08-13T12:00:00Z'),
};

function sqls(calls: { sql: string }[]): string[] {
  return calls.map(({ sql }) => sql.replace(/\s+/g, ' ').trim());
}

describe('registerManualPayment', () => {
  it('billing: avança, retoma, loga e só retorna depois da releitura final/commit', async () => {
    const harness = makeHarness({
      flowEnabled: false,
      suspendedKind: 'billing',
      due: '2026-07-01',
      firstPayment: false,
    });
    const result = await registerManualPayment(
      INPUT,
      harness.dbPool as unknown as Parameters<typeof registerManualPayment>[1],
    );
    expect(result).toMatchObject({ resumed: true, firstPayment: false });
    expect(result?.billing.next_due_date).toBe('2026-09-13');
    expect(result?.operational).toMatchObject({ flow_enabled: true, suspended_kind: null });

    const order = sqls(harness.calls);
    const advisory = order.findIndex((q) => q.includes('pg_advisory_xact_lock'));
    const rowLock = order.findIndex(
      (q) => q.includes('FROM flow_clones') && q.includes('FOR UPDATE'),
    );
    const billingWrite = order.findIndex((q) => q.includes('INSERT INTO client_billing'));
    const log = order.findIndex((q) => q.includes('INSERT INTO flow_suspension_log'));
    const finalRead = order.findIndex((q) => q.includes('FROM flow_clones fc'));
    const commit = order.findIndex((q) => q === 'COMMIT');
    expect(advisory).toBeLessThan(rowLock);
    expect(rowLock).toBeLessThan(billingWrite);
    expect(billingWrite).toBeLessThan(log);
    expect(log).toBeLessThan(finalRead);
    expect(finalRead).toBeLessThan(commit);
  });

  it.each(['owner_request', 'manual_other', 'abuse'])(
    'preserva %s enquanto atualiza billing, sem log de resume',
    async (kind) => {
      const harness = makeHarness({
        flowEnabled: false,
        suspendedKind: kind,
        due: '2026-07-01',
      });
      const result = await registerManualPayment(
        INPUT,
        harness.dbPool as unknown as Parameters<typeof registerManualPayment>[1],
      );
      expect(result?.resumed).toBe(false);
      expect(result?.operational).toMatchObject({ flow_enabled: false, suspended_kind: kind });
      expect(sqls(harness.calls).some((q) => q.includes('INSERT INTO flow_suspension_log'))).toBe(
        false,
      );
    },
  );

  it('slot inexistente retorna null sem billing/log', async () => {
    const harness = makeHarness({
      exists: false,
      flowEnabled: false,
      suspendedKind: 'billing',
      due: null,
    });
    const result = await registerManualPayment(
      INPUT,
      harness.dbPool as unknown as Parameters<typeof registerManualPayment>[1],
    );
    expect(result).toBeNull();
    const queries = sqls(harness.calls);
    expect(queries.some((q) => q.includes('INSERT INTO client_billing'))).toBe(false);
    expect(queries.some((q) => q.includes('flow_suspension_log'))).toBe(false);
    expect(queries).toContain('COMMIT');
  });

  it('falha após escrita faz rollback integral e libera conexão', async () => {
    const harness = makeHarness({
      flowEnabled: false,
      suspendedKind: 'billing',
      due: '2026-07-01',
      failOn: 'UPDATE flow_clones',
    });
    await expect(
      registerManualPayment(
        INPUT,
        harness.dbPool as unknown as Parameters<typeof registerManualPayment>[1],
      ),
    ).rejects.toThrow('falha manual injetada');
    expect(sqls(harness.calls)).toContain('ROLLBACK');
    expect(sqls(harness.calls)).not.toContain('COMMIT');
    expect(harness.client.release).toHaveBeenCalledWith(false);
  });

  it('falha ao confirmar COMMIT sinaliza outcome ambíguo e descarta conexão mesmo após ROLLBACK', async () => {
    const harness = makeHarness({
      flowEnabled: false,
      suspendedKind: 'billing',
      due: '2026-07-01',
      failOn: 'COMMIT',
    });
    await expect(
      registerManualPayment(
        INPUT,
        harness.dbPool as unknown as Parameters<typeof registerManualPayment>[1],
      ),
    ).rejects.toMatchObject({
      code: 'MANUAL_PAYMENT_OUTCOME_UNCERTAIN',
      stage: 'commit',
    });
    expect(sqls(harness.calls)).toContain('ROLLBACK');
    expect(harness.client.release).toHaveBeenCalledWith(true);
  });

  it('falha de ROLLBACK antes de COMMIT preserva erro original e descarta conexão', async () => {
    const harness = makeHarness({
      flowEnabled: false,
      suspendedKind: 'billing',
      due: '2026-07-01',
      failOn: ['UPDATE flow_clones', 'ROLLBACK'],
    });
    await expect(
      registerManualPayment(
        INPUT,
        harness.dbPool as unknown as Parameters<typeof registerManualPayment>[1],
      ),
    ).rejects.toThrow('falha manual injetada');
    expect(sqls(harness.calls)).toContain('ROLLBACK');
    expect(harness.client.release).toHaveBeenCalledWith(true);
  });

  it('rejeita ciclo inválido antes de qualquer escrita de billing', async () => {
    const harness = makeHarness({ flowEnabled: true, suspendedKind: null, due: '2026-09-01' });
    await expect(
      registerManualPayment(
        { ...INPUT, cycleMonths: 0 },
        harness.dbPool as unknown as Parameters<typeof registerManualPayment>[1],
      ),
    ).rejects.toThrow('cycleMonths');
    expect(sqls(harness.calls).some((q) => q.includes('INSERT INTO client_billing'))).toBe(false);
    expect(sqls(harness.calls)).toContain('ROLLBACK');
  });
});
