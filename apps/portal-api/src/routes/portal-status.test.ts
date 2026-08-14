import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCloneBySlot: vi.fn(),
  getOperationalSnapshotBySlot: vi.fn(),
  countPausasAtivasBySlot: vi.fn(),
  getBillingBySlot: vi.fn(),
  getSessionStatus: vi.fn(),
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn() }) },
}));

vi.mock('@startap/db', () => ({
  flowClones: { getCloneBySlot: mocks.getCloneBySlot },
  operationalState: { getOperationalSnapshotBySlot: mocks.getOperationalSnapshotBySlot },
  portalConfig: { countPausasAtivasBySlot: mocks.countPausasAtivasBySlot },
  clientBilling: {
    GRACE_DAYS: 3,
    getBillingBySlot: mocks.getBillingBySlot,
    daysUntilDue: (nextDueDate: string | null): number | null => {
      if (!nextDueDate) return null;
      const due = Date.parse(`${nextDueDate}T00:00:00Z`);
      const today = new Date();
      return Math.round(
        (due - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) /
          86_400_000,
      );
    },
  },
}));

vi.mock('@startap/integrations', () => ({
  waha: { sessions: { getSessionStatus: mocks.getSessionStatus } },
}));

vi.mock('../lib/tenant.js', () => ({
  withTenant: vi.fn(async (req: { tenant?: unknown }) => {
    req.tenant = { slot: 'clone_x', userId: 7, username: 'cliente', sid: 'sid' };
  }),
  requireTenant: (req: { tenant: unknown }) => req.tenant,
}));

vi.mock('../lib/waha-contacts.js', () => ({ getRecentContacts: vi.fn() }));

import Fastify from 'fastify';
import { portalStatusRoutes } from './portal-status.js';

function operational(overrides: Record<string, unknown> = {}) {
  return {
    slot: 'clone_x',
    tenant_id: 'tenant-x',
    clone_status: 'conectado',
    atendimento_configured: true,
    waha_sessao: 'sess_x',
    flow_enabled: true,
    suspended_reason: null,
    suspended_kind: null,
    suspended_at: null,
    next_due_date: '2099-01-01',
    billing_amount_cents: 8500,
    ...overrides,
  };
}

async function app() {
  const instance = Fastify({ logger: false });
  await instance.register(portalStatusRoutes);
  await instance.ready();
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BILLING_OVERDUE_SILENCE = 'true';
  mocks.getCloneBySlot.mockResolvedValue({
    slot: 'clone_x',
    display_name: 'Negócio X',
    timezone: 'America/Sao_Paulo',
    waha_sessao: 'sess_x',
  });
  mocks.getOperationalSnapshotBySlot.mockResolvedValue(operational());
  mocks.countPausasAtivasBySlot.mockResolvedValue(2);
  mocks.getBillingBySlot.mockResolvedValue({
    next_due_date: '2099-01-01',
    status: 'active',
  });
  mocks.getSessionStatus.mockResolvedValue({ status: 'WORKING' });
});

describe('GET /portal/status — estado composto aditivo', () => {
  it('preserva campos legados e adiciona projeção sem PII', async () => {
    const instance = await app();
    const response = await instance.inject({ method: 'GET', url: '/portal/status' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      slot: 'clone_x',
      display_name: 'Negócio X',
      flow_enabled: true,
      suspended_kind: null,
      waha: { session: 'sess_x', status: 'WORKING' },
      pausas_ativas: 2,
      operational_state: {
        waha: { state: 'working' },
        atendimento: { configured: true, processing: true, responding: true },
        effective: 'working',
        actions: { resume_owner: { allowed: true, denied_reason: null } },
      },
    });
    expect(JSON.stringify(response.json())).not.toContain('suspended_reason');
    await instance.close();
  });

  it('owner overdue mostra owner ativo e billing bloqueante sem colapsar eixos', async () => {
    mocks.getOperationalSnapshotBySlot.mockResolvedValue(
      operational({
        flow_enabled: false,
        suspended_kind: 'owner_request',
        next_due_date: '2020-01-01',
      }),
    );
    const instance = await app();
    const response = await instance.inject({ method: 'GET', url: '/portal/status' });
    expect(response.json().operational_state).toMatchObject({
      owner_pause: { active: true },
      billing: { blocking: true },
      atendimento: { processing: false, responding: false },
      effective: 'blocked_billing',
      actions: { resume_owner: { allowed: false, denied_reason: 'billing_overdue' } },
    });
    await instance.close();
  });
});
