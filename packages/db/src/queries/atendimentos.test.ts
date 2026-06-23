/**
 * Testes da data layer de atendimentos (ADR 0026, Fase 1 MVP).
 *
 * `../client.js` é MOCKADO (`query`) — não toca banco. Validamos:
 *  - calcComissaoCents: SOLO (pct null/0) -> 0; EMPRESA (pct) -> round((valor-desc)*pct/100);
 *    sobre o BRUTO líquido de desconto; nunca negativa.
 *  - createAtendimento PACOTE: forma_pagamento='pacote' -> valor_cents=0 (não conta 2×).
 *  - createAtendimento SOLO: colaborador null -> comissao_pct/cents = NULL/0.
 *  - createAtendimento EMPRESA: congela snapshot de comissao_pct + comissao_cents.
 *  - ISOLAMENTO: relatórios filtram por slot E tenant_id no WHERE (defesa RLS).
 *  - bug do $1 (ADR 0018): tenant_id é parâmetro próprio, nunca reusa o placeholder do slot.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: { connect: vi.fn() },
  query: (...a: unknown[]) => mockQuery(...a),
}));

const {
  calcComissaoCents,
  createAtendimento,
  getColaboradorComissao,
  getFaturamento,
  getComissao,
} = await import('./atendimentos.js');

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

/** Devolve [sql, params] da última chamada a query. */
function lastCall(): [string, unknown[]] {
  const calls = mockQuery.mock.calls;
  return calls[calls.length - 1] as [string, unknown[]];
}

describe('calcComissaoCents (regra do dinheiro — pura)', () => {
  it('SOLO: pct null -> 0', () => {
    expect(calcComissaoCents(5000, 0, null)).toBe(0);
  });

  it('SOLO: pct 0 -> 0', () => {
    expect(calcComissaoCents(5000, 0, 0)).toBe(0);
  });

  it('EMPRESA: 40% de 5000 -> 2000', () => {
    expect(calcComissaoCents(5000, 0, 40)).toBe(2000);
  });

  it('sobre o BRUTO líquido de desconto: 40% de (5000-1000) -> 1600', () => {
    expect(calcComissaoCents(5000, 1000, 40)).toBe(1600);
  });

  it('arredonda para centavo inteiro: 33% de 4990 -> 1647', () => {
    // 4990 * 33 / 100 = 1646.7 -> round 1647
    expect(calcComissaoCents(4990, 0, 33)).toBe(1647);
  });

  it('nunca negativa: desconto > valor -> base 0 -> 0', () => {
    expect(calcComissaoCents(1000, 5000, 40)).toBe(0);
  });
});

describe('createAtendimento — cenários', () => {
  it('SOLO: colaborador null -> não lê comissão, grava comissao_pct NULL e 0 cents', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, comissao_cents: 0 }], rowCount: 1 });
    await createAtendimento({
      slot: 'clone_cirilo',
      tenantId: 'tid-1',
      valorCents: 5000,
      colaboradorId: null,
      formaPagamento: 'pix',
    });
    // Uma única query (o INSERT) — SOLO não consulta clone_colaboradores.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = lastCall();
    expect(sql).toContain('INSERT INTO atendimentos');
    // params: [slot, tenant, gcal, cliente_nome, contato, servico, valor, desconto, forma,
    //          colaborador, comissao_pct, comissao_cents, data]
    expect(params[0]).toBe('clone_cirilo'); // slot
    expect(params[1]).toBe('tid-1'); // tenant_id parâmetro PRÓPRIO (não reusa $1)
    expect(params[6]).toBe(5000); // valor_cents cheio (não é pacote)
    expect(params[9]).toBe(null); // colaborador_id
    expect(params[10]).toBe(null); // comissao_pct
    expect(params[11]).toBe(0); // comissao_cents
  });

  it('EMPRESA: lê pct do colaborador no slot e congela snapshot de pct + cents', async () => {
    // 1ª query: getColaboradorComissao (pct corrente). 2ª: INSERT.
    mockQuery.mockResolvedValueOnce({ rows: [{ comissao_pct: '40.00' }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    await createAtendimento({
      slot: 'clone_dragon',
      tenantId: 'tid-2',
      valorCents: 5000,
      descontoCents: 1000,
      colaboradorId: 9,
      formaPagamento: 'pix',
    });
    const [sql, params] = lastCall();
    expect(sql).toContain('INSERT INTO atendimentos');
    expect(params[9]).toBe(9); // colaborador_id
    expect(params[10]).toBe(40); // comissao_pct snapshot
    expect(params[11]).toBe(1600); // comissao_cents = 40% de (5000-1000)
  });

  it('PACOTE: forma_pagamento=pacote -> valor_cents=0 (não conta receita 2×)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    await createAtendimento({
      slot: 'clone_cirilo',
      tenantId: 'tid-1',
      valorCents: 5000, // operador mandou 5000, mas é pacote -> zera
      descontoCents: 500,
      colaboradorId: null,
      formaPagamento: 'pacote',
    });
    const [, params] = lastCall();
    expect(params[6]).toBe(0); // valor_cents zerado
    expect(params[7]).toBe(0); // desconto_cents zerado
    expect(params[8]).toBe('pacote'); // forma_pagamento preservada
  });

  it('PACOTE + colaborador: comissão calcula sobre valor 0 -> 0 cents', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ comissao_pct: '40.00' }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    await createAtendimento({
      slot: 'clone_dragon',
      tenantId: 'tid-2',
      valorCents: 5000,
      colaboradorId: 9,
      formaPagamento: 'pacote',
    });
    const [, params] = lastCall();
    expect(params[6]).toBe(0); // valor zerado (pacote)
    expect(params[10]).toBe(40); // pct congelado
    expect(params[11]).toBe(0); // comissão sobre valor 0 -> 0
  });
});

describe('getColaboradorComissao — anti-IDOR (pertence ao slot)', () => {
  it('escopa por slot E id; colaborador inexistente no slot -> belongs:false', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r = await getColaboradorComissao('clone_dragon', 999);
    expect(r.belongs).toBe(false);
    const [sql, params] = lastCall();
    expect(sql).toContain('WHERE slot = $1 AND id = $2');
    expect(params).toEqual(['clone_dragon', 999]);
  });

  it('colaborador do slot -> belongs:true + pct numérico', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ comissao_pct: '50.00' }], rowCount: 1 });
    const r = await getColaboradorComissao('clone_dragon', 9);
    expect(r).toEqual({ belongs: true, comissaoPct: 50 });
  });
});

describe('relatórios — ISOLAMENTO slot + tenant_id no WHERE', () => {
  it('getFaturamento filtra por slot E tenant_id + status realizado em toda query', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await getFaturamento('clone_cirilo', 'tid-1', '2026-06-01', '2026-06-30');
    // 3 queries (total, por forma, por profissional) — todas escopadas.
    for (const [sql, params] of mockQuery.mock.calls as [string, unknown[]][]) {
      expect(sql).toMatch(/slot = \$1/);
      expect(sql).toMatch(/tenant_id = \$2/);
      expect(sql).toContain("status = 'realizado'");
      expect(params[0]).toBe('clone_cirilo');
      expect(params[1]).toBe('tid-1'); // tenant_id parâmetro próprio ($2, não reusa $1)
    }
  });

  it('getFaturamento: ticket médio = round(total/count)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total_cents: '10000', count: '3' }], rowCount: 1 }) // total
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // por forma
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // por profissional
    const r = await getFaturamento('clone_cirilo', 'tid-1', '2026-06-01', '2026-06-30');
    expect(r.total_cents).toBe(10000);
    expect(r.count).toBe(3);
    expect(r.ticket_medio_cents).toBe(3333); // round(10000/3)
  });

  it('getComissao filtra por slot+tenant e só linhas COM colaborador (SOLO=vazio)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r = await getComissao('clone_cirilo', 'tid-1', '2026-06-01', '2026-06-30');
    const [sql, params] = lastCall();
    expect(sql).toMatch(/a\.slot = \$1/);
    expect(sql).toMatch(/a\.tenant_id = \$2/);
    expect(sql).toContain('a.colaborador_id IS NOT NULL');
    expect(params).toEqual(['clone_cirilo', 'tid-1', '2026-06-01', '2026-06-30']);
    expect(r.total_cents).toBe(0); // SOLO -> sem comissão
    expect(r.por_profissional).toEqual([]);
  });

  it('getComissao soma comissao_cents por profissional', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { colaborador_id: 9, profissional_nome: 'Ana', comissao_cents: '2000', count: '2' },
        { colaborador_id: 10, profissional_nome: 'Bia', comissao_cents: '1500', count: '1' },
      ],
      rowCount: 2,
    });
    const r = await getComissao('clone_dragon', 'tid-2', '2026-06-01', '2026-06-30');
    expect(r.total_cents).toBe(3500);
    expect(r.por_profissional).toHaveLength(2);
    expect(r.por_profissional[0]).toMatchObject({ colaborador_id: 9, comissao_cents: 2000 });
  });
});
