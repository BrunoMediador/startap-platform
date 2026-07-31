/**
 * SCRUM-148 item 2 — o reconciliationHook NUNCA loga gcal_event_id CRU.
 *
 * Achado da varredura pedida junto com o item 2: além do reconcile-packages (cron OFF hoje),
 * o `reconciliationHook` também logava o id CRU — e este roda em PROD a CADA dedução de pacote
 * (chamado pelo caminho de dedução do bot quando descontou), então era o sink cru de maior volume.
 *
 * Mesmo mecanismo do SCRUM-91/#531: hashEventIdForLog. O id cru continua na linha do ledger.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { logSpies } = vi.hoisted(() => ({
  logSpies: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => logSpies },
}));

vi.mock('../client.js', () => ({
  pool: {},
  query: vi.fn().mockResolvedValue({ rows: [] }),
}));

const { hashEventIdForLog } = await import('@startap/core/gcal-event-log');
const { reconciliationHook } = await import('./packages.js');

const RAW_ID = '6k3jd9plq7v2c1hs8tnu4bgoim';

beforeEach(() => {
  logSpies.info.mockClear();
  logSpies.warn.mockClear();
  logSpies.error.mockClear();
});

describe('reconciliationHook — id do evento hasheado no log (SCRUM-148 item 2)', () => {
  it('o gcal_event_id CRU não aparece em NENHUM campo do log', () => {
    reconciliationHook({
      slot: 'cirilobarbearia',
      gcalEventId: RAW_ID,
      creditId: 42,
      servicoNome: 'Corte',
    });

    const logged = JSON.stringify([
      ...logSpies.info.mock.calls,
      ...logSpies.warn.mock.calls,
      ...logSpies.error.mock.calls,
    ]);
    expect(logged.length).toBeGreaterThan(2);
    expect(logged).not.toContain(RAW_ID);
  });

  it('vai como sha256:<hex> — mesmo mecanismo do SCRUM-91, e o rastro do ops continua', () => {
    reconciliationHook({
      slot: 'cirilobarbearia',
      gcalEventId: RAW_ID,
      creditId: 42,
      servicoNome: 'Corte',
    });

    expect(logSpies.info).toHaveBeenCalledTimes(1);
    const payload = logSpies.info.mock.calls[0][0] as { gcalEventId: string };
    expect(payload.gcalEventId).toBe(hashEventIdForLog(RAW_ID));
    expect(payload.gcalEventId).toMatch(/^sha256:[0-9a-f]{16}$/);
    // O resto do rastro (slot/crédito/serviço) segue intacto pro job futuro.
    expect(payload).toMatchObject({ slot: 'cirilobarbearia', creditId: 42, servico: 'Corte' });
  });
});
