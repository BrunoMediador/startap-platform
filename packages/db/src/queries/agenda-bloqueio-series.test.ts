import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock('../client.js', () => ({ query: (...args: unknown[]) => mockQuery(...args) }));

const { claimCreate, markCreateResult } = await import('./agenda-bloqueio-series.js');

const input = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  tenantId: '00000000-0000-4000-8000-000000000001',
  slot: 'clone_x',
  colaboradorId: 7,
  sessionHash: 'a'.repeat(64),
  payloadHash: 'b'.repeat(64),
};

beforeEach(() => mockQuery.mockReset());

describe('agenda-bloqueio-series', () => {
  it('claim novo é atômico na chave sessão+tenant+colaborador+payload', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: input.id, status: 'creating', response_status: null, response_body: null }],
    });

    await expect(claimCreate(input)).resolves.toEqual({
      claimed: true,
      serie: { id: input.id, status: 'creating', response_status: null, response_body: null },
    });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain(
      'ON CONFLICT (tenant_id, slot, colaborador_key, session_hash, payload_hash)',
    );
    expect(params).toEqual([
      input.id,
      input.tenantId,
      input.slot,
      input.colaboradorId,
      input.sessionHash,
      input.payloadHash,
    ]);
  });

  it('retry concorrente que perde o claim relê somente a mesma chave', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ id: input.id, status: 'creating', response_status: null, response_body: null }],
    });

    await expect(claimCreate(input)).resolves.toEqual({
      claimed: false,
      serie: { id: input.id, status: 'creating', response_status: null, response_body: null },
    });

    const [sql, params] = mockQuery.mock.calls[1];
    expect(String(sql)).toContain('session_hash = $4');
    expect(String(sql)).toContain('payload_hash = $5');
    expect(params).toEqual([
      input.tenantId,
      input.slot,
      input.colaboradorId,
      input.sessionHash,
      input.payloadHash,
    ]);
  });

  it('resultado final é atualizado no escopo tenant+slot+serie', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await markCreateResult({
      tenantId: input.tenantId,
      slot: input.slot,
      serieId: input.id,
      status: 'complete',
      responseStatus: 201,
      responseBody: { ok: true },
    });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('tenant_id = $1');
    expect(String(sql)).toContain('slot = $2');
    expect(String(sql)).toContain('id = $3');
    expect(params).toEqual([
      input.tenantId,
      input.slot,
      input.id,
      'complete',
      201,
      JSON.stringify({ ok: true }),
    ]);
  });
});
