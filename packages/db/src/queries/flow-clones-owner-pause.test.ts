import { beforeEach, describe, expect, it, vi } from 'vitest';

type OwnerState = {
  exists?: boolean;
  flowEnabled: boolean;
  suspendedKind: string | null;
  nextDueDate: string | null;
  amountCents: number | null;
};

const calls: { sql: string; params: unknown[] }[] = [];

function snapshotRow(state: OwnerState, flowEnabled = state.flowEnabled) {
  return {
    slot: 'clone_x',
    tenant_id: 'tenant-x',
    clone_status: 'conectado',
    atendimento_configured: true,
    waha_sessao: 'sess_x',
    flow_enabled: flowEnabled,
    suspended_reason: flowEnabled ? null : 'pausa',
    suspended_kind: flowEnabled ? null : state.suspendedKind,
    suspended_at: flowEnabled ? null : new Date('2026-08-01T00:00:00Z'),
    next_due_date: state.nextDueDate,
    billing_amount_cents: state.amountCents,
  };
}

function makeClient(updateRows: number, state: OwnerState) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const q = sql.replace(/\s+/g, ' ');
      if (q.includes('BEGIN') || q.includes('COMMIT') || q.includes('ROLLBACK')) {
        return { rows: [], rowCount: 0 };
      }
      if (q.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
      if (q.includes('FROM flow_clones') && q.includes('FOR UPDATE')) {
        return state.exists === false
          ? { rows: [], rowCount: 0 }
          : { rows: [snapshotRow(state)], rowCount: 1 };
      }
      if (q.includes('FROM client_billing') && q.includes('FOR UPDATE')) {
        return {
          rows:
            state.nextDueDate == null && state.amountCents == null
              ? []
              : [
                  {
                    next_due_date: state.nextDueDate,
                    billing_amount_cents: state.amountCents,
                  },
                ],
          rowCount: state.nextDueDate == null && state.amountCents == null ? 0 : 1,
        };
      }
      if (q.includes('UPDATE flow_clones')) {
        return updateRows > 0
          ? { rows: [{ slot: 'clone_x', waha_sessao: 'sess_x' }], rowCount: updateRows }
          : { rows: [], rowCount: 0 };
      }
      if (q.includes('INSERT INTO flow_suspension_log')) return { rows: [], rowCount: 1 };
      if (q.includes('FROM flow_clones fc') && q.includes('LEFT JOIN client_billing')) {
        return { rows: [snapshotRow(state, updateRows > 0)], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
}

let currentClient: ReturnType<typeof makeClient>;
const queryMock = vi.fn();

vi.mock('../client.js', () => ({
  pool: { connect: vi.fn(async () => currentClient) },
  query: (...args: unknown[]) => queryMock(...args),
}));

const {
  pauseBotByOwner,
  resumeBotByOwner,
  OWNER_PAUSE_KIND,
  getCloneBySlot,
  invalidateCloneCache,
} = await import('./flow-clones.js');
const { OWNER_PAUSE_KIND: OWNER_PAUSE_KIND_SOURCE } = await import('@startap/core/silence-gate');

const OWNER_IN_DAY: OwnerState = {
  flowEnabled: false,
  suspendedKind: 'owner_request',
  nextDueDate: '2099-01-01',
  amountCents: 8500,
};

function setup(updateRows: number, state: OwnerState = OWNER_IN_DAY) {
  calls.length = 0;
  currentClient = makeClient(updateRows, state);
}

function normalizedSql(): string[] {
  return calls.map(({ sql }) => sql.replace(/\s+/g, ' ').trim());
}

function findCall(fragment: string) {
  return calls.find(({ sql }) => sql.replace(/\s+/g, ' ').includes(fragment));
}

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockReset();
  invalidateCloneCache();
});

describe('OWNER_PAUSE_KIND', () => {
  it('reexporta o binding canônico de @startap/core', () => {
    expect(OWNER_PAUSE_KIND).toBe(OWNER_PAUSE_KIND_SOURCE);
  });
});

describe('pauseBotByOwner', () => {
  it('pausa somente clone ativo, grava owner_request e loga uma vez', async () => {
    setup(1);
    const result = await pauseBotByOwner('clone_x', 'portal:7');
    expect(result).toEqual({ changed: true, flow_enabled: false });
    const update = findCall('UPDATE flow_clones');
    expect(update?.params).toEqual(['clone_x', OWNER_PAUSE_KIND, 'Pausado pelo cliente no portal']);
    expect(update?.sql).toContain('flow_enabled = TRUE');
    expect(findCall('INSERT INTO flow_suspension_log')?.params).toEqual([
      'clone_x',
      'Pausado pelo cliente no portal',
      'portal:7',
    ]);
    expect(normalizedSql()).toContain('COMMIT');
  });

  it('não sobrescreve suspensão existente nem duplica log', async () => {
    setup(0);
    expect(await pauseBotByOwner('clone_x', 'portal:7')).toEqual({
      changed: false,
      flow_enabled: false,
    });
    expect(findCall('INSERT INTO flow_suspension_log')).toBeUndefined();
  });

  it('invalida estrutura local somente depois de mudança/commit', async () => {
    const structural = { id: 1, slot: 'clone_cache', flow_enabled: true };
    const operationalBefore = snapshotRow({ ...OWNER_IN_DAY, flowEnabled: true });
    queryMock.mockResolvedValueOnce({ rows: [structural], rowCount: 1 });
    queryMock.mockResolvedValueOnce({ rows: [operationalBefore], rowCount: 1 });
    expect((await getCloneBySlot('clone_cache'))?.flow_enabled).toBe(true);

    setup(1);
    await pauseBotByOwner('clone_cache', 'portal:7');
    queryMock.mockResolvedValueOnce({ rows: [structural], rowCount: 1 });
    queryMock.mockResolvedValueOnce({
      rows: [snapshotRow(OWNER_IN_DAY)],
      rowCount: 1,
    });
    expect((await getCloneBySlot('clone_cache'))?.flow_enabled).toBe(false);
  });
});

describe('resumeBotByOwner gate-aware', () => {
  it('owner em dia: advisory antes de row lock, limpa owner, loga e relê antes do commit', async () => {
    setup(1);
    const result = await resumeBotByOwner('clone_x', 'portal:7', {
      billingOverdueSilenceOn: true,
    });
    expect(result).toMatchObject({ changed: true, flow_enabled: true, outcome: 'resumed' });
    expect(result.operational?.suspended_kind).toBeNull();

    const sql = normalizedSql();
    const advisory = sql.findIndex((q) => q.includes('pg_advisory_xact_lock'));
    const rowLock = sql.findIndex(
      (q) => q.includes('FROM flow_clones') && q.includes('FOR UPDATE'),
    );
    const update = sql.findIndex((q) => q.includes('UPDATE flow_clones'));
    const finalRead = sql.findIndex((q) => q.includes('FROM flow_clones fc'));
    const commit = sql.findIndex((q) => q === 'COMMIT');
    expect(advisory).toBeGreaterThan(-1);
    expect(advisory).toBeLessThan(rowLock);
    expect(rowLock).toBeLessThan(update);
    expect(update).toBeLessThan(finalRead);
    expect(finalRead).toBeLessThan(commit);
    expect(findCall('INSERT INTO flow_suspension_log')?.params).toEqual(['clone_x', 'portal:7']);
  });

  it('owner overdue além da carência: 409 lógico, zero update/log', async () => {
    setup(1, { ...OWNER_IN_DAY, nextDueDate: '2020-01-01' });
    const result = await resumeBotByOwner('clone_x', 'portal:7', {
      billingOverdueSilenceOn: true,
    });
    expect(result).toMatchObject({
      changed: false,
      flow_enabled: false,
      outcome: 'billing_overdue',
      startap_kind: null,
    });
    expect(findCall('UPDATE flow_clones')).toBeUndefined();
    expect(findCall('INSERT INTO flow_suspension_log')).toBeUndefined();
  });

  it('já ativo overdue também reflete billing_overdue sem escrever', async () => {
    setup(0, {
      ...OWNER_IN_DAY,
      flowEnabled: true,
      suspendedKind: null,
      nextDueDate: '2020-01-01',
    });
    const result = await resumeBotByOwner('clone_x', 'portal:7', {
      billingOverdueSilenceOn: true,
    });
    expect(result.outcome).toBe('billing_overdue');
    expect(findCall('UPDATE flow_clones')).toBeUndefined();
  });

  it.each(['billing', 'manual_other', 'abuse'] as const)(
    'suspensão Startap %s é classificada e preservada',
    async (kind) => {
      setup(0, { ...OWNER_IN_DAY, suspendedKind: kind });
      const result = await resumeBotByOwner('clone_x', 'portal:7', {
        billingOverdueSilenceOn: true,
      });
      expect(result).toMatchObject({
        changed: false,
        flow_enabled: false,
        outcome: 'startap_suspension',
        startap_kind: kind,
      });
      expect(findCall('UPDATE flow_clones')).toBeUndefined();
      expect(findCall('INSERT INTO flow_suspension_log')).toBeUndefined();
    },
  );

  it('já ativo em dia é idempotente, sem update/log', async () => {
    setup(0, { ...OWNER_IN_DAY, flowEnabled: true, suspendedKind: null });
    const result = await resumeBotByOwner('clone_x', 'portal:7', {
      billingOverdueSilenceOn: true,
    });
    expect(result).toMatchObject({ changed: false, flow_enabled: true, outcome: 'already_active' });
    expect(findCall('UPDATE flow_clones')).toBeUndefined();
    expect(findCall('INSERT INTO flow_suspension_log')).toBeUndefined();
  });

  it('slot inexistente retorna not_found sem qualquer escrita', async () => {
    setup(0, { ...OWNER_IN_DAY, exists: false });
    const result = await resumeBotByOwner('clone_missing', 'portal:7', {
      billingOverdueSilenceOn: true,
    });
    expect(result).toMatchObject({ outcome: 'not_found', operational: null });
    expect(findCall('UPDATE flow_clones')).toBeUndefined();
    expect(findCall('INSERT INTO flow_suspension_log')).toBeUndefined();
  });
});
