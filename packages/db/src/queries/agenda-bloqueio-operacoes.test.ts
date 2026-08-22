import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock('../client.js', () => ({ query: (...args: unknown[]) => mockQuery(...args) }));

const { createPlan } = await import('./agenda-bloqueio-operacoes.js');

const input = {
  operationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '00000000-0000-4000-8000-000000000001',
  slot: 'clone_x',
  colaboradorId: 7,
  sessionHash: 'a'.repeat(64),
  payloadHash: 'b'.repeat(64),
  actorRole: 'owner' as const,
  actorUserId: 22,
  actorColaboradorId: null,
  timezone: 'America/Sao_Paulo',
  tipo: 'almoco' as const,
  motivo: 'intervalo',
  occurrences: [
    {
      ordinal: 1,
      inicioAt: '2026-08-22T12:00:00.000Z',
      fimAt: '2026-08-22T13:00:00.000Z',
      bloqueioId: '22222222-2222-4222-8222-222222222222',
      gcalEventId: 'bloq-1',
    },
    {
      ordinal: 2,
      inicioAt: '2026-08-29T12:00:00.000Z',
      fimAt: '2026-08-29T13:00:00.000Z',
      bloqueioId: '33333333-3333-4333-8333-333333333333',
      gcalEventId: 'bloq-2',
    },
  ],
};

beforeEach(() => mockQuery.mockReset());

describe('agenda-bloqueio-operacoes createPlan', () => {
  it('usa uma statement: só a operação recém-inserida alimenta o plano', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: input.operationId, status: 'planned', created: true }],
    });

    await expect(createPlan(input)).resolves.toEqual({
      created: true,
      operation: { id: input.operationId, status: 'planned' },
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat).toContain('WITH operation_claim AS');
    expect(flat).toContain('CROSS JOIN jsonb_to_recordset($13::jsonb)');
    expect(flat).toContain('WHERE operation_claim.created');
    expect(flat).not.toContain('ON CONFLICT (operation_id, ordinal) DO NOTHING');
    expect(params).toHaveLength(13);
    expect(params[12]).toBe(
      JSON.stringify(
        input.occurrences.map((occurrence) => ({
          ordinal: occurrence.ordinal,
          inicio_at: occurrence.inicioAt,
          fim_at: occurrence.fimAt,
          bloqueio_id: occurrence.bloqueioId,
          gcal_event_id: occurrence.gcalEventId,
        })),
      ),
    );
  });

  it('replay retorna a operação existente sem uma segunda query nem plano novo', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: input.operationId, status: 'creating', created: false }],
    });

    await expect(createPlan(input)).resolves.toEqual({
      created: false,
      operation: { id: input.operationId, status: 'creating' },
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('rejeita lista vazia antes de criar qualquer operação', async () => {
    await expect(createPlan({ ...input, occurrences: [] })).rejects.toThrow(
      'agenda_bloqueio_operacao_sem_ocorrencias',
    );

    expect(mockQuery).not.toHaveBeenCalled();
  });

  it.each([
    ['uma ocorrência', input.occurrences.slice(0, 1)],
    ['vinte e cinco ocorrências', Array.from({ length: 25 }, () => input.occurrences[0])],
  ])('rejeita %s antes de criar operação', async (_label, occurrences) => {
    await expect(createPlan({ ...input, occurrences })).rejects.toThrow(
      'agenda_bloqueio_operacao_quantidade_ocorrencias_invalida',
    );

    expect(mockQuery).not.toHaveBeenCalled();
  });
});
