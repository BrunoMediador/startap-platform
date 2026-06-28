/**
 * Testes do job antibot — foco na ALLOWLIST DURA (SCRUM-4 PR-A).
 *
 * `@startap/db` (antibot/flowClones/pausa/routing), `@startap/core/logger` e
 * `@startap/core/phone` são MOCKADOS — sem banco nem rede.
 *
 * Cobre:
 *  - allowlist OFF (default) -> comportamento de HOJE: pausa o suspeito; NÃO consulta a allowlist
 *    (zero query nova). Garante "flag OFF = zero mudança".
 *  - allowlist ON + telefone que JÁ agendou -> NÃO pausa (skip), incrementa `skipped`.
 *  - allowlist ON + telefone SEM histórico -> AINDA pausa (não vaza allowlist pra quem não é cliente).
 *  - allowlist ON + erro na checagem -> fail-closed (segue pausando).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findSuspects = vi.fn();
const pruneOldLogs = vi.fn();
const hasScheduledHistory = vi.fn();
const findRouting = vi.fn();
const getCloneBySession = vi.fn();
const addFlowPause = vi.fn();

vi.mock('@startap/db', () => ({
  antibot: { findSuspects, pruneOldLogs, hasScheduledHistory },
  routing: { findRouting },
  flowClones: { getCloneBySession },
  pausa: { addFlowPause },
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

beforeEach(() => {
  vi.clearAllMocks();
  pruneOldLogs.mockResolvedValue(0);
  addFlowPause.mockResolvedValue(undefined);
  // flowId resolvido pela etapa 1 (routing) -> = SLOT do clone.
  findRouting.mockResolvedValue({ workflow_id: SLOT });
  getCloneBySession.mockResolvedValue(null);
  hasScheduledHistory.mockResolvedValue(false);
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
