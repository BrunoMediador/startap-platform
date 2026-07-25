/**
 * Data layer do gate billing-da-agenda por-clone (SCRUM-112): enableBillingFromAgendaBySlot.
 *
 * DB mockado (../client.js). Foco: slot SEMPRE parametrizado ($1), nunca interpolado; só LIGA
 * (nunca desliga); idempotente via `IS DISTINCT FROM TRUE` (re-save de agenda já-ligada = no-op);
 * retorna true só quando ESTA chamada ligou; false quando já estava ON ou o slot não existe.
 * invalidateCloneCache real (só limpa um Map em memória — inofensivo no teste).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: {
    connect: async () => ({
      query: (...args: unknown[]) => mockQuery(...args),
      release: () => {},
    }),
  },
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { enableBillingFromAgendaBySlot } = await import('./flow-clones.js');

const SLOT = 'clone_mvs_barbearia_qc9qff';

beforeEach(() => {
  mockQuery.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('enableBillingFromAgendaBySlot (SCRUM-112)', () => {
  it('liga billing_from_agenda_enabled escopado ao slot (parametrizado $1) e retorna true', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    const ok = await enableBillingFromAgendaBySlot(SLOT);
    expect(ok).toBe(true);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/billing_from_agenda_enabled\s*=\s*TRUE/i);
    expect(sql).toMatch(/WHERE\s+slot\s*=\s*\$1/i);
    expect(params).toEqual([SLOT]);
  });

  it('idempotente: só escreve quando ainda não estava ON (IS DISTINCT FROM TRUE)', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    const sql = await enableBillingFromAgendaBySlot(SLOT).then(
      () => mockQuery.mock.calls[0][0] as string,
    );
    expect(sql).toMatch(/billing_from_agenda_enabled\s+IS\s+DISTINCT\s+FROM\s+TRUE/i);
  });

  it('NUNCA desliga: a statement não escreve FALSE', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await enableBillingFromAgendaBySlot(SLOT);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).not.toMatch(/=\s*FALSE/i);
  });

  it('já estava ON (0 linhas) => retorna false (no-op)', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    expect(await enableBillingFromAgendaBySlot(SLOT)).toBe(false);
  });

  it('slot inexistente (0 linhas) => false', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    expect(await enableBillingFromAgendaBySlot('slot_que_nao_existe')).toBe(false);
  });
});
