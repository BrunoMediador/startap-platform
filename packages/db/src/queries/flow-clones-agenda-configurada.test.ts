/**
 * isAgendaConfiguradaBySlot (SCRUM-74) — "o clone tem Google Calendar utilizável?".
 *
 * MESMO critério (`gcalConfigured`) de getGcalForSlot/getGcalsForSlot — o inverso do que
 * isAwaitingAgendaConnection considera "aguardando". Prova:
 *  - individual com gcal active + creds + calendarId -> configurada (true);
 *  - individual sem gcal active (ou sem creds/calendarId) -> NÃO configurada (false);
 *  - estabelecimento -> depende de >=1 colaborador ativo/active/calendarId;
 *  - clone ausente / erro de query -> false (fail-closed: na dúvida NÃO religa).
 *
 * Mocka ../client.js (sem DB real), mesmo padrão de flow-clones-awaiting-agenda.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { isAgendaConfiguradaBySlot } = await import('./flow-clones.js');

/** Linha de flow_clones do 1o SELECT (product_type / gcal_status / has_*). */
function cloneRow(over: {
  product_type?: string;
  gcal_status?: string | null;
  has_creds?: boolean;
  has_calendar?: boolean;
}): Record<string, unknown> {
  return {
    product_type: over.product_type ?? 'individual',
    gcal_status: over.gcal_status ?? null,
    has_creds: over.has_creds ?? false,
    has_calendar: over.has_calendar ?? false,
  };
}

describe('isAgendaConfiguradaBySlot (SCRUM-74)', () => {
  beforeEach(() => mockQuery.mockReset());

  it('individual com gcal active + creds + calendarId -> configurada (true)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [cloneRow({ gcal_status: 'active', has_creds: true, has_calendar: true })],
    });
    expect(await isAgendaConfiguradaBySlot('clone_cirilo')).toBe(true);
    // individual: NÃO consulta colaboradores (1 query só).
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('individual sem gcal active -> NÃO configurada (false)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [cloneRow({ gcal_status: 'pending' })] });
    expect(await isAgendaConfiguradaBySlot('clone_novo_ab')).toBe(false);
  });

  it('individual active mas SEM calendarId -> NÃO configurada (false)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [cloneRow({ gcal_status: 'active', has_creds: true, has_calendar: false })],
    });
    expect(await isAgendaConfiguradaBySlot('clone_meio')).toBe(false);
  });

  it('estabelecimento com >=1 colaborador active -> configurada (true)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [cloneRow({ product_type: 'estabelecimento' })] })
      .mockResolvedValueOnce({ rows: [{ n: 3 }] });
    expect(await isAgendaConfiguradaBySlot('clone_estab_ok')).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('estabelecimento SEM colaborador agendável -> NÃO configurada (false)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [cloneRow({ product_type: 'estabelecimento' })] })
      .mockResolvedValueOnce({ rows: [{ n: 0 }] });
    expect(await isAgendaConfiguradaBySlot('clone_estab')).toBe(false);
  });

  it('clone ausente -> false (fail-closed)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await isAgendaConfiguradaBySlot('clone_sumido')).toBe(false);
  });

  it('erro de query -> false (fail-closed: na dúvida não religa)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('pg down'));
    expect(await isAgendaConfiguradaBySlot('clone_erro')).toBe(false);
  });
});
