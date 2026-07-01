/**
 * Data layer do fuso por clone (migration 068 — follow-up de validação/escrita).
 *
 * DB mockado (../client.js). Foco: slot SEMPRE parametrizado ($1), nunca
 * interpolado; getter degrada pra SP; updater escopado ao slot e retorna
 * false quando o slot não existe. invalidateCloneCache real (só limpa um Map
 * em memória — inofensivo no teste).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { getTimezoneBySlot, updateTimezoneBySlot } = await import('./flow-clones.js');

const SLOT = 'clone_seven_7_barber_dqjzb4';

beforeEach(() => {
  mockQuery.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getTimezoneBySlot', () => {
  it('devolve o fuso gravado, com slot parametrizado ($1)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ timezone: 'America/Cuiaba' }] });
    const tz = await getTimezoneBySlot(SLOT);
    expect(tz).toBe('America/Cuiaba');
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('WHERE slot = $1'), [SLOT]);
  });

  it('slot inexistente => default America/Sao_Paulo (nunca null)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getTimezoneBySlot(SLOT)).toBe('America/Sao_Paulo');
  });

  it('coluna vazia (null) => default America/Sao_Paulo', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ timezone: null }] });
    expect(await getTimezoneBySlot(SLOT)).toBe('America/Sao_Paulo');
  });
});

describe('updateTimezoneBySlot', () => {
  it('grava o fuso escopado ao slot (parametrizado) e retorna true', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    const ok = await updateTimezoneBySlot(SLOT, 'America/Cuiaba');
    expect(ok).toBe(true);
    // slot em $1, timezone em $2 — nunca interpolado.
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE flow_clones SET timezone = $2'),
      [SLOT, 'America/Cuiaba'],
    );
  });

  it('slot inexistente (rowCount 0) => false', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    const ok = await updateTimezoneBySlot(SLOT, 'America/Cuiaba');
    expect(ok).toBe(false);
  });
});
