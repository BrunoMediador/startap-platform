import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
const mockClientQuery = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({
  query: mockClientQuery,
  release: releaseMock,
}));

vi.mock('../client.js', () => ({
  pool: { connect: connectMock },
  query: (...a: unknown[]) => mockQuery(...a),
}));

const {
  upsertClienteFromSnapshot,
  seedClientesFromAtendimentos,
  listClientesForColaborador,
} = await import('./clientes.js');

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

function lastQueryCall(): [string, unknown[]] {
  const calls = mockQuery.mock.calls;
  return calls[calls.length - 1] as [string, unknown[]];
}

describe('upsertClienteFromSnapshot', () => {
  it('usa telefone canônico por tenant+telefone e preserva telefone raw para exibição', async () => {
    await upsertClienteFromSnapshot({
      slot: 'clone_dragon',
      tenantId: 'tid-dragon',
      clienteNome: 'Joao',
      clienteContato: '(31) 99999-8842',
    });

    const [sql, params] = lastQueryCall();
    expect(sql).toContain('INSERT INTO clientes');
    expect(params[0]).toBe('tid-dragon');
    expect(params[1]).toBe('clone_dragon');
    expect(params[2]).toBe('553199998842'); // canônico BR sem o 9º dígito
    expect(params[3]).toBe('31999998842'); // raw digits para exibição
    expect(params[4]).toBe('Joao');
  });

  it('no-op quando o telefone não gera identidade canônica', async () => {
    const result = await upsertClienteFromSnapshot({
      slot: 'clone_dragon',
      tenantId: 'tid-dragon',
      clienteNome: 'Sem Telefone',
      clienteContato: 'abc',
    });

    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('seedClientesFromAtendimentos', () => {
  it('semeia clientes distintos e atualiza cliente_telefone_canonico nos snapshots', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({
        rows: [
          {
            id: 11,
            cliente_nome: 'Joao',
            cliente_contato: '(31) 99999-8842',
            cliente_telefone_canonico: null,
          },
          {
            id: 12,
            cliente_nome: 'Joao da Silva',
            cliente_contato: '5531999998842',
            cliente_telefone_canonico: null,
          },
          {
            id: 13,
            cliente_nome: 'Maria',
            cliente_contato: '5535987654321',
            cliente_telefone_canonico: '5535987654321',
          },
        ],
        rowCount: 3,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 }) // insert clientes
      .mockResolvedValueOnce({ rows: [], rowCount: 2 }) // update atendimentos
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

    const result = await seedClientesFromAtendimentos('clone_dragon', 'tid-dragon');

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(mockClientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(mockClientQuery.mock.calls[2]?.[0]).toContain('INSERT INTO clientes');
    expect(mockClientQuery.mock.calls[3]?.[0]).toContain('UPDATE atendimentos AS a');
    const insertParams = mockClientQuery.mock.calls[2]?.[1] as unknown[];
    expect(insertParams[2]).toEqual(['553199998842', '553587654321']);
    expect(insertParams[3]).toEqual(['31999998842', '5535987654321']);
    expect(result).toEqual({ clientesSeeded: 2, atendimentosUpdated: 3 });
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});

describe('listClientesForColaborador', () => {
  it('consulta só clientes do colaborador no escopo tenant+slot e pagina a busca', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          nome: 'Joao',
          telefone_canonico: '553199998842',
          aniversario_mmdd: null,
          cidade: null,
          total_atendimentos: '2',
          ultima_interacao_at: '2026-08-20T10:00:00.000Z',
          ultimo_profissional_nome: 'Bene',
          total_count: '1',
        },
      ],
      rowCount: 1,
    });

    const result = await listClientesForColaborador({
      slot: 'clone_owner',
      tenantId: 'tid-owner',
      colaboradorId: 9,
      search: 'jo 9842',
      limit: 10,
      offset: 5,
    });

    const [sql, params] = lastQueryCall();
    expect(sql).toContain('EXISTS');
    expect(sql).toContain('own_a.colaborador_id = $3');
    expect(params).toEqual([
      'clone_owner',
      'tid-owner',
      9,
      'jo 9842',
      '%jo 9842%',
      '%9842%',
      10,
      5,
    ]);
    expect(result.total).toBe(1);
    expect(result.clientes[0]?.telefone_masked).toBe('+55 31 •••••-••42');
    expect((result.clientes[0] as { telefone?: string }).telefone).toBeUndefined();
  });
});
