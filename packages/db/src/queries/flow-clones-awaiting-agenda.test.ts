/**
 * isAwaitingAgendaConnection (ADR 0030 D3, Onda 3) — estado "aguardando conexão da agenda".
 *
 * Deriva de RUNTIME: agendaIntent && !gcalConfigured. Prova:
 *  - individual AGENDA sem gcal active -> aguardando (true);
 *  - individual AGENDA com gcal active + creds + calendarId -> conectado (false);
 *  - ATENDENTE (agenda_automatica=false) -> nunca aguarda (false, sem 2a query);
 *  - estabelecimento AGENDA -> depende de >=1 colaborador ativo/active/calendarId;
 *  - clone ausente / erro de query -> false (fail-safe, o card some).
 *
 * Mocka ../client.js (sem DB real), mesmo padrão de flow-clones-selfservice-gates.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { isAwaitingAgendaConnection } = await import('./flow-clones.js');

/** Linha de flow_clones do 1o SELECT (product_type/personalizacao/gcal_status/has_*). */
function cloneRow(over: {
  product_type?: string;
  agenda_automatica?: unknown;
  gcal_status?: string | null;
  has_creds?: boolean;
  has_calendar?: boolean;
}): Record<string, unknown> {
  return {
    product_type: over.product_type ?? 'individual',
    personalizacao:
      over.agenda_automatica === undefined ? {} : { agenda_automatica: over.agenda_automatica },
    gcal_status: over.gcal_status ?? null,
    has_creds: over.has_creds ?? false,
    has_calendar: over.has_calendar ?? false,
  };
}

describe('isAwaitingAgendaConnection (ADR 0030 D3)', () => {
  beforeEach(() => mockQuery.mockReset());

  it('individual AGENDA (default) sem gcal -> aguardando (true)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [cloneRow({ gcal_status: 'pending' })] });
    expect(await isAwaitingAgendaConnection('clone_novo_ab')).toBe(true);
  });

  it('individual AGENDA com gcal active + creds + calendarId -> conectado (false)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [cloneRow({ gcal_status: 'active', has_creds: true, has_calendar: true })],
    });
    expect(await isAwaitingAgendaConnection('clone_cirilo')).toBe(false);
  });

  it('individual AGENDA active mas SEM calendarId -> ainda aguardando (true)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [cloneRow({ gcal_status: 'active', has_creds: true, has_calendar: false })],
    });
    expect(await isAwaitingAgendaConnection('clone_meio')).toBe(true);
  });

  it('ATENDENTE (agenda_automatica=false) -> NUNCA aguarda (false), sem 2a query', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [cloneRow({ agenda_automatica: 'false' })] });
    expect(await isAwaitingAgendaConnection('clone_atendente')).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(1); // não consulta colaboradores nem gcal do individual
  });

  it('estabelecimento AGENDA SEM colaborador agendável -> aguardando (true)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [cloneRow({ product_type: 'estabelecimento' })] })
      .mockResolvedValueOnce({ rows: [{ n: 0 }] });
    expect(await isAwaitingAgendaConnection('clone_estab')).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('estabelecimento AGENDA COM >=1 colaborador active -> conectado (false)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [cloneRow({ product_type: 'estabelecimento' })] })
      .mockResolvedValueOnce({ rows: [{ n: 3 }] });
    expect(await isAwaitingAgendaConnection('clone_estab_ok')).toBe(false);
  });

  it('clone ausente -> false (fail-safe)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await isAwaitingAgendaConnection('clone_sumido')).toBe(false);
  });

  it('erro de query -> false (nunca derruba o perfil)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('pg down'));
    expect(await isAwaitingAgendaConnection('clone_erro')).toBe(false);
  });
});
