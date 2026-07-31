/**
 * Testes do job antibot — foco na ALLOWLIST DURA (SCRUM-4 PR-A) e no GATE ÚNICO DE
 * SILÊNCIO TOTAL (fix pós-SCRUM-155, decisão do Bruno).
 *
 * `@startap/db` (antibot/flowClones/pausa/routing/clientBilling), `@startap/core/logger` e
 * `@startap/core/phone` são MOCKADOS — sem banco nem rede.
 *
 * Cobre:
 *  - allowlist OFF (default) -> comportamento de HOJE: pausa o suspeito; NÃO consulta a allowlist
 *    (zero query nova). Garante "flag OFF = zero mudança".
 *  - allowlist ON + telefone que JÁ agendou -> NÃO pausa (skip), incrementa `skipped`.
 *  - allowlist ON + telefone SEM histórico -> AINDA pausa (não vaza allowlist pra quem não é cliente).
 *  - allowlist ON + erro na checagem -> fail-closed (segue pausando).
 *  - gate único ON + clone suspenso/vencido -> NÃO pausa (skip), zero query de allowlist.
 *  - gate único OFF (default) -> zero mudança (não consulta getCloneBySlot pro gate).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findSuspects = vi.fn();
const pruneOldLogs = vi.fn();
const hasScheduledHistory = vi.fn();
const findRouting = vi.fn();
const getCloneBySession = vi.fn();
const getCloneBySlot = vi.fn();
const addFlowPause = vi.fn();

vi.mock('@startap/db', () => ({
  antibot: { findSuspects, pruneOldLogs, hasScheduledHistory },
  routing: { findRouting },
  flowClones: { getCloneBySession, getCloneBySlot },
  pausa: { addFlowPause },
  // clientBilling: reimplementação fiel das funções PURAS (mesmo padrão do router.test.ts).
  clientBilling: {
    GRACE_DAYS: 3,
    daysUntilDue: (nextDueDate: string | null, today: Date = new Date()): number | null => {
      if (!nextDueDate) return null;
      const due = Date.parse(`${nextDueDate}T00:00:00Z`);
      if (Number.isNaN(due)) return null;
      const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
      return Math.round((due - todayUtc) / 86_400_000);
    },
  },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

// phoneHint só é usado pra log mascarado — stub simples mantém o teste hermético (o mascaramento
// real é coberto nos testes do @startap/core).
vi.mock('@startap/core/phone', () => ({
  phoneHint: (p: string) => `mask(${p.slice(-2)})`,
}));

const { runAntibot } = await import('./antibot.js');

const SLOT = 'clone_barbearia_seven_7_barber_dqjzb4';
const TELEFONE = '5535991746797';
const GATE_ENV_KEY = 'GATE_SILENCIO_TOTAL_ENABLED';
const BILLING_ENV_KEY = 'BILLING_OVERDUE_SILENCE';

function dueDateOffset(days: number): string {
  const now = new Date();
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

beforeEach(() => {
  vi.clearAllMocks();
  pruneOldLogs.mockResolvedValue(0);
  addFlowPause.mockResolvedValue(undefined);
  // flowId resolvido pela etapa 1 (routing) -> = SLOT do clone.
  findRouting.mockResolvedValue({ workflow_id: SLOT });
  getCloneBySession.mockResolvedValue(null);
  getCloneBySlot.mockResolvedValue(null);
  hasScheduledHistory.mockResolvedValue(false);
  delete process.env[GATE_ENV_KEY];
  delete process.env[BILLING_ENV_KEY];
});

describe('runAntibot — allowlist OFF (default, comportamento de hoje)', () => {
  it('pausa o suspeito e NÃO consulta a allowlist', async () => {
    findSuspects.mockResolvedValue([{ telefone: TELEFONE, total: 8, session: 'sess-1' }]);

    const r = await runAntibot(); // sem opts = allowlistEnabled default false

    expect(hasScheduledHistory).not.toHaveBeenCalled();
    expect(addFlowPause).toHaveBeenCalledTimes(1);
    expect(addFlowPause).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: SLOT, telefone: TELEFONE, source: 'antibot' }),
    );
    expect(r).toEqual({ blocked: 1, pruned: 0, skipped: 0 });
  });

  it('idem com allowlistEnabled: false explícito (idempotente com o de hoje)', async () => {
    findSuspects.mockResolvedValue([{ telefone: TELEFONE, total: 7, session: 'sess-1' }]);

    const r = await runAntibot({ allowlistEnabled: false });

    expect(hasScheduledHistory).not.toHaveBeenCalled();
    expect(addFlowPause).toHaveBeenCalledTimes(1);
    expect(r.blocked).toBe(1);
    expect(r.skipped).toBe(0);
  });
});

describe('runAntibot — allowlist ON', () => {
  it('NÃO pausa quem já agendou no clone (skip + skipped++)', async () => {
    findSuspects.mockResolvedValue([{ telefone: TELEFONE, total: 9, session: 'sess-1' }]);
    hasScheduledHistory.mockResolvedValue(true);

    const r = await runAntibot({ allowlistEnabled: true });

    expect(hasScheduledHistory).toHaveBeenCalledWith(SLOT, TELEFONE);
    expect(addFlowPause).not.toHaveBeenCalled();
    expect(r).toEqual({ blocked: 0, pruned: 0, skipped: 1 });
  });

  it('AINDA pausa número SEM histórico de agendamento', async () => {
    findSuspects.mockResolvedValue([{ telefone: TELEFONE, total: 10, session: 'sess-1' }]);
    hasScheduledHistory.mockResolvedValue(false);

    const r = await runAntibot({ allowlistEnabled: true });

    expect(hasScheduledHistory).toHaveBeenCalledWith(SLOT, TELEFONE);
    expect(addFlowPause).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ blocked: 1, pruned: 0, skipped: 0 });
  });

  it('fail-closed: erro na checagem da allowlist NÃO impede a pausa', async () => {
    findSuspects.mockResolvedValue([{ telefone: TELEFONE, total: 11, session: 'sess-1' }]);
    hasScheduledHistory.mockRejectedValue(new Error('db down'));

    const r = await runAntibot({ allowlistEnabled: true });

    expect(addFlowPause).toHaveBeenCalledTimes(1);
    expect(r.blocked).toBe(1);
    expect(r.skipped).toBe(0);
  });

  it('mistura: pausa quem é flooder novo e poupa quem já é cliente', async () => {
    findSuspects.mockResolvedValue([
      { telefone: '5511999990000', total: 8, session: 'sess-1' }, // cliente (já agendou)
      { telefone: '5511988887777', total: 8, session: 'sess-1' }, // flooder novo
    ]);
    hasScheduledHistory.mockImplementation(
      async (_slot: string, tel: string) => tel === '5511999990000',
    );

    const r = await runAntibot({ allowlistEnabled: true });

    expect(addFlowPause).toHaveBeenCalledTimes(1);
    expect(addFlowPause).toHaveBeenCalledWith(
      expect.objectContaining({ telefone: '5511988887777' }),
    );
    expect(r).toEqual({ blocked: 1, pruned: 0, skipped: 1 });
  });
});

describe('runAntibot — GATE ÚNICO de silêncio total (fix pós-SCRUM-155)', () => {
  it('flag OFF (default) -> NÃO consulta getCloneBySlot, comportamento de hoje', async () => {
    findSuspects.mockResolvedValue([{ telefone: TELEFONE, total: 8, session: 'sess-1' }]);

    const r = await runAntibot();

    expect(getCloneBySlot).not.toHaveBeenCalled();
    expect(addFlowPause).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ blocked: 1, pruned: 0, skipped: 0 });
  });

  it('flag ON + clone SUSPENSO pela Startap (suspended_kind=manual_other) -> NÃO pausa (skip)', async () => {
    process.env[GATE_ENV_KEY] = 'true';
    findSuspects.mockResolvedValue([{ telefone: TELEFONE, total: 8, session: 'sess-1' }]);
    getCloneBySlot.mockResolvedValue({
      flow_enabled: false,
      suspended_kind: 'manual_other',
      next_due_date: null,
      billing_amount_cents: null,
    });

    const r = await runAntibot();

    expect(addFlowPause).not.toHaveBeenCalled();
    // Nem chega a consultar a allowlist — o gate corta antes.
    expect(hasScheduledHistory).not.toHaveBeenCalled();
    expect(r).toEqual({ blocked: 0, pruned: 0, skipped: 1 });
  });

  it('flag ON + clone pausado PELO DONO (owner_request) + EM DIA -> AINDA pausa (antibot grava normalmente; só a resposta do bot é opção do dono)', async () => {
    process.env[GATE_ENV_KEY] = 'true';
    findSuspects.mockResolvedValue([{ telefone: TELEFONE, total: 8, session: 'sess-1' }]);
    getCloneBySlot.mockResolvedValue({
      flow_enabled: false,
      suspended_kind: 'owner_request',
      next_due_date: null,
      billing_amount_cents: null,
    });

    const r = await runAntibot();

    expect(addFlowPause).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ blocked: 1, pruned: 0, skipped: 0 });
  });

  it('flag ON + BILLING ON + clone pausado PELO DONO (owner_request) + VENCIDO além da carência -> NÃO pausa (os dois eixos são independentes)', async () => {
    process.env[GATE_ENV_KEY] = 'true';
    process.env[BILLING_ENV_KEY] = 'true';
    findSuspects.mockResolvedValue([{ telefone: TELEFONE, total: 8, session: 'sess-1' }]);
    getCloneBySlot.mockResolvedValue({
      flow_enabled: false,
      suspended_kind: 'owner_request',
      next_due_date: dueDateOffset(-10),
      billing_amount_cents: 8500,
    });

    const r = await runAntibot();

    expect(addFlowPause).not.toHaveBeenCalled();
    expect(r).toEqual({ blocked: 0, pruned: 0, skipped: 1 });
  });

  it('flag ON + BILLING ON + clone VENCIDO além da carência -> NÃO pausa (skip)', async () => {
    process.env[GATE_ENV_KEY] = 'true';
    process.env[BILLING_ENV_KEY] = 'true';
    findSuspects.mockResolvedValue([{ telefone: TELEFONE, total: 8, session: 'sess-1' }]);
    getCloneBySlot.mockResolvedValue({
      flow_enabled: true,
      next_due_date: dueDateOffset(-10),
      billing_amount_cents: 8500,
    });

    const r = await runAntibot();

    expect(addFlowPause).not.toHaveBeenCalled();
    expect(r).toEqual({ blocked: 0, pruned: 0, skipped: 1 });
  });

  it('flag ON + clone EM DIA -> segue pausando normal (regressão)', async () => {
    process.env[GATE_ENV_KEY] = 'true';
    process.env[BILLING_ENV_KEY] = 'true';
    findSuspects.mockResolvedValue([{ telefone: TELEFONE, total: 8, session: 'sess-1' }]);
    getCloneBySlot.mockResolvedValue({
      flow_enabled: true,
      next_due_date: dueDateOffset(20),
      billing_amount_cents: 8500,
    });

    const r = await runAntibot();

    expect(addFlowPause).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ blocked: 1, pruned: 0, skipped: 0 });
  });

  it('flag ON + erro ao buscar clone (getCloneBySlot rejeita) -> fail-open, segue pausando', async () => {
    process.env[GATE_ENV_KEY] = 'true';
    findSuspects.mockResolvedValue([{ telefone: TELEFONE, total: 8, session: 'sess-1' }]);
    getCloneBySlot.mockRejectedValue(new Error('db down'));

    const r = await runAntibot();

    expect(addFlowPause).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ blocked: 1, pruned: 0, skipped: 0 });
  });

  it('flag ON mas flowId NÃO é clone (routing_clientes de bot matriz) -> não consulta o gate', async () => {
    process.env[GATE_ENV_KEY] = 'true';
    findRouting.mockResolvedValue({ workflow_id: 'uUS3Ux1cU2DquKxo' }); // matriz, não "clone_"
    findSuspects.mockResolvedValue([{ telefone: TELEFONE, total: 8, session: 'sess-1' }]);

    const r = await runAntibot();

    expect(getCloneBySlot).not.toHaveBeenCalled();
    expect(addFlowPause).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ blocked: 1, pruned: 0, skipped: 0 });
  });
});
