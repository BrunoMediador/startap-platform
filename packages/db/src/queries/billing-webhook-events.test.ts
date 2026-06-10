/**
 * Testes do processamento transacional applyPaidWebhook (C1/C2/C4 do threat-model).
 *
 * O pool pg e MOCKADO — um client fake responde a cada SQL pela ORDEM/PADRAO da query.
 * Cobre: dedupe (replay nao reprocessa), orfao, already_paid, underpaid (nao avanca/
 * reativa), applied + auto-resume SO com suspended_kind='billing' (e NAO com
 * 'owner_request'/NULL). Verifica COMMIT/ROLLBACK e que o slot vem do registro casado.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock do pool pg: client fake roteado por substring da query ─────────────────
interface Scenario {
  dedupeInserted: boolean; // (1) INSERT billing_webhook_events RETURNING -> 1 ou 0 linhas
  charge: { id: string; slot: string; amount_cents: number; status: string } | null; // (2) SELECT charge FOR UPDATE
  nextDueDate: string | null; // (6) SELECT client_billing FOR UPDATE
  resumeRows: number; // (7) UPDATE flow_clones ... RETURNING -> 0 ou 1
}

const calls: { sql: string; params: unknown[] }[] = [];

function makeClient(s: Scenario) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const q = sql.replace(/\s+/g, ' ');

      if (q.includes('BEGIN')) return { rows: [], rowCount: 0 };
      if (q.includes('COMMIT') || q.includes('ROLLBACK')) return { rows: [], rowCount: 0 };

      if (q.includes('INSERT INTO billing_webhook_events') && q.includes('ON CONFLICT')) {
        return s.dedupeInserted
          ? { rows: [{ event_id: 'evt_1' }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (q.includes('FROM billing_charges') && q.includes('FOR UPDATE')) {
        return s.charge ? { rows: [s.charge], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (q.includes('UPDATE billing_webhook_events SET charge_id')) {
        return { rows: [], rowCount: 1 };
      }
      if (q.includes('UPDATE billing_charges') && q.includes("status = 'paid'")) {
        return { rows: [], rowCount: 1 };
      }
      if (q.includes('FROM client_billing') && q.includes('FOR UPDATE')) {
        return { rows: [{ next_due_date: s.nextDueDate }], rowCount: s.nextDueDate ? 1 : 0 };
      }
      if (q.includes('INSERT INTO client_billing')) {
        return { rows: [], rowCount: 1 };
      }
      if (q.includes('UPDATE flow_clones') && q.includes("suspended_kind = 'billing'")) {
        return s.resumeRows > 0
          ? { rows: [{ slot: s.charge?.slot }], rowCount: s.resumeRows }
          : { rows: [], rowCount: 0 };
      }
      if (q.includes('INSERT INTO flow_suspension_log')) {
        return { rows: [], rowCount: 1 };
      }
      if (q.includes('UPDATE billing_webhook_events SET processed_at')) {
        return { rows: [], rowCount: 1 };
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
  receiptUrl: 'https://r/abc',
  redactedPayload: { id: 'evt_1', brCode: '[REDACTED]' },
};

function setup(s: Scenario) {
  calls.length = 0;
  currentClient = makeClient(s);
}

function sqlsRun(): string[] {
  return calls.map((c) => c.sql.replace(/\s+/g, ' ').trim());
}
function ranResume(): boolean {
  return sqlsRun().some(
    (q) => q.includes('UPDATE flow_clones') && q.includes("suspended_kind = 'billing'"),
  );
}
function ranAdvance(): boolean {
  return sqlsRun().some((q) => q.includes('INSERT INTO client_billing'));
}
function committed(): boolean {
  return sqlsRun().some((q) => q.includes('COMMIT'));
}

beforeEach(() => {
  calls.length = 0;
});

describe('applyPaidWebhook (C1/C2/C4)', () => {
  it('C4 dedupe: event_id repetido (0 linhas no INSERT) -> duplicate, nao processa', async () => {
    setup({ dedupeInserted: false, charge: null, nextDueDate: null, resumeRows: 0 });
    const r = await applyPaidWebhook(BASE_INPUT);
    expect(r.outcome).toBe('duplicate');
    // Nao chegou a casar cobranca nem avancar.
    expect(sqlsRun().some((q) => q.includes('FROM billing_charges'))).toBe(false);
    expect(ranAdvance()).toBe(false);
    expect(committed()).toBe(true);
  });

  it('orfao: nenhuma cobranca casada -> orphan, nao avanca/reativa', async () => {
    setup({ dedupeInserted: true, charge: null, nextDueDate: null, resumeRows: 0 });
    const r = await applyPaidWebhook(BASE_INPUT);
    expect(r.outcome).toBe('orphan');
    expect(ranAdvance()).toBe(false);
    expect(ranResume()).toBe(false);
  });

  it('already_paid: cobranca ja paga -> idempotente, nao avanca/reativa', async () => {
    setup({
      dedupeInserted: true,
      charge: { id: '10', slot: 'barbearia-cirilo', amount_cents: 19900, status: 'paid' },
      nextDueDate: '2026-06-10',
      resumeRows: 0,
    });
    const r = await applyPaidWebhook(BASE_INPUT);
    expect(r.outcome).toBe('already_paid');
    expect(ranAdvance()).toBe(false);
    expect(ranResume()).toBe(false);
  });

  it('C2 underpaid: pago < snapshot -> marca pago mas NAO avanca nem reativa', async () => {
    setup({
      dedupeInserted: true,
      charge: { id: '10', slot: 'barbearia-cirilo', amount_cents: 19900, status: 'pending' },
      nextDueDate: '2026-06-10',
      resumeRows: 1, // mesmo que pudesse, nao deve chegar a reativar
    });
    const r = await applyPaidWebhook({ ...BASE_INPUT, paidAmountCents: 1 });
    expect(r.outcome).toBe('underpaid');
    expect(r.resumed).toBe(false);
    // Marcou pago, mas NAO avancou vencimento nem rodou o UPDATE de resume.
    expect(sqlsRun().some((q) => q.includes("status = 'paid'"))).toBe(true);
    expect(ranAdvance()).toBe(false);
    expect(ranResume()).toBe(false);
    expect(committed()).toBe(true);
  });

  it('C1 applied + auto-resume: pago >= snapshot e suspended_kind=billing -> reativa', async () => {
    setup({
      dedupeInserted: true,
      charge: { id: '10', slot: 'barbearia-cirilo', amount_cents: 19900, status: 'pending' },
      nextDueDate: '2026-06-10',
      resumeRows: 1, // UPDATE casou (slot estava suspenso por billing)
    });
    const r = await applyPaidWebhook(BASE_INPUT);
    expect(r.outcome).toBe('applied');
    expect(r.resumed).toBe(true);
    expect(r.slot).toBe('barbearia-cirilo');
    expect(ranAdvance()).toBe(true);
    expect(ranResume()).toBe(true);
    // Logou o resume.
    expect(sqlsRun().some((q) => q.includes('INSERT INTO flow_suspension_log'))).toBe(true);
  });

  it('C1 applied SEM resume: suspended_kind != billing / NULL -> avanca mas NAO reativa', async () => {
    // O UPDATE condicional (WHERE suspended_kind='billing') casa 0 linhas quando o slot
    // foi suspenso por outro motivo (owner_request) ou nao esta suspenso (NULL).
    setup({
      dedupeInserted: true,
      charge: { id: '10', slot: 'barbearia-cirilo', amount_cents: 19900, status: 'pending' },
      nextDueDate: '2026-06-10',
      resumeRows: 0, // WHERE nao casou -> nao reativa
    });
    const r = await applyPaidWebhook(BASE_INPUT);
    expect(r.outcome).toBe('applied');
    expect(r.resumed).toBe(false);
    expect(ranAdvance()).toBe(true); // vencimento avanca mesmo sem reativar
    // O UPDATE de resume RODA (com WHERE seguro), mas como casou 0 linhas, NAO loga resume.
    expect(sqlsRun().some((q) => q.includes('INSERT INTO flow_suspension_log'))).toBe(false);
  });

  it('o UPDATE de resume sempre carrega o guard suspended_kind=billing (anti-falso-resume)', async () => {
    setup({
      dedupeInserted: true,
      charge: { id: '10', slot: 'barbearia-cirilo', amount_cents: 19900, status: 'pending' },
      nextDueDate: '2026-06-10',
      resumeRows: 1,
    });
    await applyPaidWebhook(BASE_INPUT);
    const resumeSql = sqlsRun().find((q) => q.includes('UPDATE flow_clones'));
    expect(resumeSql).toBeDefined();
    expect(resumeSql).toContain("suspended_kind = 'billing'");
    expect(resumeSql).toContain('flow_enabled = false');
  });
});
