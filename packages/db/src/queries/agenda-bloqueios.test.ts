import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock('../client.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { create, list, softDeleteById } = await import('./agenda-bloqueios.js');

const RAW_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  tenant_id: '00000000-0000-4000-8000-000000000001',
  slot: 'clone_x',
  colaborador_id: '7',
  gcal_event_id: 'gcal-1',
  inicio_at: '2026-08-21T12:00:00.000Z',
  fim_at: '2026-08-21T13:00:00.000Z',
  timezone: 'America/Sao_Paulo',
  tipo: 'almoco',
  motivo: 'intervalo',
  status: 'active',
  created_by_role: 'owner',
  created_by_user_id: 22,
  created_by_colaborador_id: null,
  deleted_at: null,
  created_at: '2026-08-20T00:00:00.000Z',
  updated_at: '2026-08-20T00:00:00.000Z',
};

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [RAW_ROW], rowCount: 1 });
});

describe('agenda-bloqueios queries', () => {
  it('create carimba tenant/slot/colaborador e nasce em status creating', async () => {
    const row = await create({
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: '00000000-0000-4000-8000-000000000001',
      slot: 'clone_x',
      colaboradorId: 7,
      gcalEventId: 'bloq11111111111141118111111111111111',
      inicioAt: '2026-08-21T12:00:00-03:00',
      fimAt: '2026-08-21T13:00:00-03:00',
      timezone: 'America/Sao_Paulo',
      tipo: 'almoco',
      motivo: 'intervalo',
      createdByRole: 'owner',
      createdByUserId: 22,
    });

    expect(row.colaborador_id).toBe(7);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("status, created_by_role");
    expect(String(sql)).toContain("'creating'");
    expect(params).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '00000000-0000-4000-8000-000000000001',
      'clone_x',
      7,
      'bloq11111111111141118111111111111111',
      '2026-08-21T12:00:00-03:00',
      '2026-08-21T13:00:00-03:00',
      'America/Sao_Paulo',
      'almoco',
      'intervalo',
      'owner',
      22,
      null,
    ]);
  });

  it('list filtra por tenant_id + slot + status ativo + colaborador', async () => {
    await list({
      tenantId: '00000000-0000-4000-8000-000000000001',
      slot: 'clone_x',
      colaboradorId: 7,
      inicioAt: '2026-08-21T00:00:00-03:00',
      fimAt: '2026-08-22T00:00:00-03:00',
    });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('tenant_id = $1');
    expect(String(sql)).toContain('slot = $2');
    expect(String(sql)).toContain("status IN ('active', 'gcal_cleanup_failed')");
    expect(String(sql)).toContain('deleted_at IS NULL');
    expect(String(sql)).toContain('colaborador_id = $3');
    expect(params).toEqual([
      '00000000-0000-4000-8000-000000000001',
      'clone_x',
      7,
      '2026-08-21T00:00:00-03:00',
      '2026-08-22T00:00:00-03:00',
    ]);
  });

  it('softDeleteById faz UPDATE de status/deleted_at escopado por tenant/slot/id/colaborador', async () => {
    await softDeleteById(
      '00000000-0000-4000-8000-000000000001',
      'clone_x',
      '11111111-1111-4111-8111-111111111111',
      7,
    );

    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("SET status = 'deleted'");
    expect(String(sql)).toContain('deleted_at = now()');
    expect(String(sql)).toContain('tenant_id = $1');
    expect(String(sql)).toContain('slot = $2');
    expect(String(sql)).toContain('id = $3');
    expect(String(sql)).toContain('colaborador_id = $4');
    expect(params).toEqual([
      '00000000-0000-4000-8000-000000000001',
      'clone_x',
      '11111111-1111-4111-8111-111111111111',
      7,
    ]);
  });
});
