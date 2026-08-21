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
  listClientesAniversariantesForOwner,
  listClientesAniversariantesForColaborador,
  listClientesSemRetornoForOwner,
  listClientesSemRetornoForColaborador,
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

describe('listClientesSemRetornoForOwner', () => {
  it('usa apenas clientes canônicos elegíveis, filtra futuro/cancelado/deletado, limita em 50 e ordena mais antigos primeiro', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          nome: 'Maria',
          telefone_canonico: '553199998888',
          ultimo_atendimento_at: '2026-08-01T13:00:00.000Z',
          dias_sem_retorno: '20',
          ultimo_profissional_nome: 'Bene',
          total_count: '1',
        },
      ],
      rowCount: 1,
    });

    const result = await listClientesSemRetornoForOwner({
      slot: 'clone_owner',
      tenantId: 'tid-owner',
      timezone: 'America/Sao_Paulo',
      limit: 51,
      offset: 3,
    });

    const [sql, params] = lastQueryCall();
    expect(sql).toContain('JOIN atendimentos a');
    expect(sql).toContain("a.deleted_at IS NULL");
    expect(sql).toContain("a.status <> 'cancelado'");
    expect(sql).toContain("a.cliente_telefone_canonico = c.telefone_canonico");
    expect(sql).toContain("AND a.origem = 'agenda'");
    expect(sql).toContain("AND COALESCE(a.fim_at, a.inicio_at) <= NOW()");
    expect(sql).toContain("UNION ALL");
    expect(sql).toContain("AND a.origem = 'manual'");
    expect(sql).toContain("AND a.data <= (NOW() AT TIME ZONE $3)::date");
    expect(sql).toContain("ORDER BY ultimo_atendimento_at ASC, id ASC");
    expect(params).toEqual(['clone_owner', 'tid-owner', 'America/Sao_Paulo', 50, 3]);
    expect(result.total).toBe(1);
    expect(result.clientes[0]).toEqual({
      id: '22222222-2222-4222-8222-222222222222',
      nome: 'Maria',
      telefone_masked: '+55 31 •••••-••88',
      ultimo_atendimento_at: '2026-08-01T13:00:00.000Z',
      dias_sem_retorno: 20,
      ultimo_profissional_nome: 'Bene',
    });
    expect((result.clientes[0] as { telefone?: string }).telefone).toBeUndefined();
  });
});

describe('listClientesSemRetornoForColaborador', () => {
  it('restringe o ranking ao colaborador da sessão e aceita limit=50', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          nome: 'Carlos',
          telefone_canonico: '553199997777',
          ultimo_atendimento_at: '2026-08-05T16:00:00.000Z',
          dias_sem_retorno: '16',
          ultimo_profissional_nome: 'Barbeiro',
          total_count: '1',
        },
      ],
      rowCount: 1,
    });

    const result = await listClientesSemRetornoForColaborador({
      slot: 'clone_owner',
      tenantId: 'tid-owner',
      colaboradorId: 9,
      timezone: 'America/Sao_Paulo',
      limit: 50,
      offset: 2,
    });

    const [sql, params] = lastQueryCall();
    expect(sql).toContain('a.colaborador_id = $3');
    expect(sql).toContain("AND a.origem = 'agenda'");
    expect(sql).toContain("AND a.origem = 'manual'");
    expect(sql).toContain("AND a.data <= (NOW() AT TIME ZONE $4)::date");
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain('ROW_NUMBER() OVER');
    expect(params).toEqual(['clone_owner', 'tid-owner', 9, 'America/Sao_Paulo', 50, 2]);
    expect(result.total).toBe(1);
    expect(result.clientes[0]?.telefone_masked).toBe('+55 31 •••••-••77');
    expect((result.clientes[0] as { telefone_raw?: string }).telefone_raw).toBeUndefined();
  });
});

describe('listClientesAniversariantesForOwner', () => {
  it('usa slot+tenant+timezone server-side, limita em 50 e mascara PII', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          nome: 'Ana',
          telefone_canonico: '553199998855',
          aniversario_mmdd: '02-29',
          dias_para_aniversario: '3',
          ultimo_profissional_nome: 'Bene',
          total_count: '1',
        },
      ],
      rowCount: 1,
    });

    const result = await listClientesAniversariantesForOwner({
      slot: 'clone_owner',
      tenantId: 'tid-owner',
      timezone: 'America/Sao_Paulo',
      limit: 51,
      offset: 4,
    });

    const [sql, params] = lastQueryCall();
    expect(sql).toContain("c.aniversario_mmdd IS NOT NULL");
    expect(sql).toContain("to_char(to_date('2000-' || c.aniversario_mmdd, 'YYYY-MM-DD'), 'MM-DD') = c.aniversario_mmdd");
    expect(sql).toContain('EXTRACT(');
    expect(sql).toContain('make_date(');
    expect(sql).toContain("NOW() AT TIME ZONE $3");
    expect(sql).toContain('ORDER BY dias_para_aniversario ASC, c.aniversario_mmdd ASC, c.id ASC');
    expect(params).toEqual(['clone_owner', 'tid-owner', 'America/Sao_Paulo', 50, 4]);
    expect(result.total).toBe(1);
    expect(result.clientes[0]).toEqual({
      id: '44444444-4444-4444-8444-444444444444',
      nome: 'Ana',
      telefone_masked: '+55 31 •••••-••55',
      aniversario_mmdd: '02-29',
      dias_para_aniversario: 3,
      ultimo_profissional_nome: 'Bene',
    });
    expect((result.clientes[0] as { telefone?: string }).telefone).toBeUndefined();
  });
});

describe('listClientesAniversariantesForColaborador', () => {
  it('restringe a leitura ao colaborador da sessão e aceita paginação read-only', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: '55555555-5555-4555-8555-555555555555',
          nome: 'Carlos',
          telefone_canonico: '553199997777',
          aniversario_mmdd: '08-25',
          dias_para_aniversario: '4',
          ultimo_profissional_nome: 'Barbeiro',
          total_count: '1',
        },
      ],
      rowCount: 1,
    });

    const result = await listClientesAniversariantesForColaborador({
      slot: 'clone_owner',
      tenantId: 'tid-owner',
      colaboradorId: 9,
      timezone: 'America/Sao_Paulo',
      limit: 50,
      offset: 2,
    });

    const [sql, params] = lastQueryCall();
    expect(sql).toContain('a.colaborador_id = $3');
    expect(sql).toContain('EXISTS');
    expect(sql).toContain('own_a.colaborador_id = $3');
    expect(sql).toContain("NOW() AT TIME ZONE $4");
    expect(sql).toContain("c.aniversario_mmdd IS NOT NULL");
    expect(sql).toContain('ORDER BY dias_para_aniversario ASC, c.aniversario_mmdd ASC, c.id ASC');
    expect(params).toEqual(['clone_owner', 'tid-owner', 9, 'America/Sao_Paulo', 50, 2]);
    expect(result.total).toBe(1);
    expect(result.clientes[0]?.telefone_masked).toBe('+55 31 •••••-••77');
    expect((result.clientes[0] as { telefone_raw?: string }).telefone_raw).toBeUndefined();
  });
});
