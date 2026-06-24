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
  upsertAtendimentoFromEvent,
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

// ── BUG DE DINHEIRO 2 (ADR 0027): pacote DOBRA a receita ─────────────────────────────
// Quando o agendamento é pago via PACOTE, a receita JÁ entrou na venda do pacote. Se a linha
// de atendimento derivada da agenda contar o valor de novo, o faturamento DOBRA. O fix faz o
// gancho (bot/portal) passar formaPagamento='pacote' -> upsertAtendimentoFromEvent zera o
// valor_cents (e desconto). Sem pacote (forma undefined/null), a previsão segue com o valor.
describe('upsertAtendimentoFromEvent — pacote NÃO dobra a receita (Bug 2)', () => {
  // params do INSERT: [slot, tenant, eventId, clienteNome, clienteContato, servicoNome,
  //                    valor_cents, desconto_cents, forma_pagamento, colaboradorId, inicio, fim, data]
  it('PACOTE: forma=pacote -> valor_cents=0 e desconto=0 (receita já entrou na venda do pacote)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, dirty_fields: [] }], rowCount: 1 });
    await upsertAtendimentoFromEvent({
      slot: 'clone_dragon',
      tenantId: 'tid-2',
      gcalEventId: 'evt-pacote',
      servicoNome: 'Corte',
      valorCents: 5000, // o evento valeria 5000, mas é pacote -> zera
      descontoCents: 300,
      colaboradorId: 1,
      formaPagamento: 'pacote',
      inicioAt: '2026-06-23T13:00:00.000Z',
      fimAt: '2026-06-23T13:30:00.000Z',
    });
    const [, params] = lastCall();
    expect(params[6]).toBe(0); // valor_cents zerado (não conta 2×)
    expect(params[7]).toBe(0); // desconto_cents zerado
    expect(params[8]).toBe('pacote'); // forma_pagamento marcada
  });

  it('SEM pacote (forma null): valor do catálogo/explícito é PRESERVADO (previsão normal)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 2, dirty_fields: [] }], rowCount: 1 });
    await upsertAtendimentoFromEvent({
      slot: 'clone_dragon',
      tenantId: 'tid-2',
      gcalEventId: 'evt-avulso',
      servicoNome: 'Corte',
      valorCents: 5000,
      colaboradorId: 1,
      formaPagamento: null, // não foi pacote
      inicioAt: '2026-06-23T13:00:00.000Z',
      fimAt: '2026-06-23T13:30:00.000Z',
    });
    const [, params] = lastCall();
    expect(params[6]).toBe(5000); // valor preservado (conta a receita 1×)
    expect(params[8]).toBeNull(); // sem forma definida
    expect(params[13]).toBe(true); // pagamento INFORMADO (forma=null explícito) -> aplica no UPDATE
  });

  // ── BUG de dinheiro: coluna `data` derivada em UTC, não BRT ────────────────────────
  // O slice(0,10) do ISO devolvia o dia em UTC. Booking ≥21h BRT (= dia seguinte em UTC)
  // caía na `data` do dia seguinte → faturamento/comissão/lista (filtram por `data`) não
  // mostravam o atendimento noturno em "Hoje" e ele vazava pro mês seguinte. O fix deriva
  // `data` no fuso America/Sao_Paulo. inicio_at/fim_at (TIMESTAMPTZ) NÃO mudam.
  it('data derivada em BRT: booking 22:00 BRT (=01:00Z do dia seguinte) → data = o dia BRT', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 9, dirty_fields: [] }], rowCount: 1 });
    await upsertAtendimentoFromEvent({
      slot: 'clone_dragon',
      tenantId: 'tid-2',
      gcalEventId: 'evt-noturno',
      servicoNome: 'Corte',
      valorCents: 5000,
      colaboradorId: 1,
      formaPagamento: 'pix',
      // 22:00 BRT do dia 23/06 = 01:00Z do dia 24/06 (UTC-3).
      inicioAt: '2026-06-24T01:00:00.000Z',
      fimAt: '2026-06-24T01:30:00.000Z',
    });
    const [, params] = lastCall();
    // data (13º param, índice 12) = dia BRT (23), NÃO o dia UTC (24).
    expect(params[12]).toBe('2026-06-23');
    // O instante absoluto (inicio_at) segue em UTC, intacto.
    expect(params[10]).toBe('2026-06-24T01:00:00.000Z');
  });

  it('data derivada em BRT: booking 09:00 BRT (=12:00Z, mesmo dia) → data = o dia BRT', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 10, dirty_fields: [] }], rowCount: 1 });
    await upsertAtendimentoFromEvent({
      slot: 'clone_dragon',
      tenantId: 'tid-2',
      gcalEventId: 'evt-manha',
      servicoNome: 'Corte',
      valorCents: 5000,
      colaboradorId: 1,
      formaPagamento: 'pix',
      inicioAt: '2026-06-23T12:00:00.000Z', // 09:00 BRT
      fimAt: '2026-06-23T12:30:00.000Z',
    });
    const [, params] = lastCall();
    expect(params[12]).toBe('2026-06-23');
  });

  // REMARCAÇÃO sem info de pagamento (sync) NÃO pode reverter a marca de pacote -> $14 FALSE
  // faz o UPDATE preservar forma_pagamento/valor/desconto antigos (senão a receita dobrava).
  it('REMARCAR (formaPagamento undefined): UPDATE preserva forma/valor antigos ($14=false)', async () => {
    // sem valorCents -> upsert resolve o preço do catálogo (1ª query), depois faz o INSERT (2ª).
    mockQuery.mockResolvedValueOnce({
      rows: [{ servicos: [{ nome: 'Corte', preco_cents: 5000 }] }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 3, dirty_fields: [] }], rowCount: 1 });
    await upsertAtendimentoFromEvent({
      slot: 'clone_dragon',
      tenantId: 'tid-2',
      gcalEventId: 'evt-remarca',
      servicoNome: 'Corte',
      // SEM formaPagamento (sync de remarcação não sabe do pagamento)
      colaboradorId: 1,
      inicioAt: '2026-06-23T14:00:00.000Z',
      fimAt: '2026-06-23T14:30:00.000Z',
    });
    const [sql, params] = lastCall();
    expect(params[13]).toBe(false); // pagamento NÃO informado -> preserva no UPDATE
    expect(params[14]).toBe(false); // SEM reprice (remarcação pura, sem troca de serviço)
    // O SQL guarda a forma antiga quando $14 é false; valor/desconto preservados quando NÃO há
    // pagamento informado E NÃO há reprice-fora-de-pacote (remarcação pura preserva o valor).
    expect(sql).toContain("dirty_fields ? 'forma_pagamento' OR NOT $14::boolean");
    expect(sql).toMatch(
      /valor_cents\s*=\s*CASE WHEN atendimentos\.dirty_fields \? 'valor_cents'\s+OR \(NOT \$14::boolean\s+AND NOT \(\$15::boolean/,
    );
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
  it('getFaturamento filtra por slot E tenant_id + só FATURADO (não deletado) em toda query', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await getFaturamento('clone_cirilo', 'tid-1', '2026-06-01', '2026-06-30');
    // 4 queries (total, por forma, por profissional, previsto) — todas escopadas.
    for (const [sql, params] of mockQuery.mock.calls as [string, unknown[]][]) {
      expect(sql).toMatch(/slot = \$1/);
      expect(sql).toMatch(/tenant_id = \$2/);
      // ADR 0027: relatório nunca conta linha deletada.
      expect(sql).toContain('deleted_at IS NULL');
      expect(params[0]).toBe('clone_cirilo');
      expect(params[1]).toBe('tid-1'); // tenant_id parâmetro próprio ($2, não reusa $1)
    }
    // O total/forma/profissional restringem a FATURADO (passado ou walk-in manual).
    const sqls = (mockQuery.mock.calls as [string, unknown[]][]).map(([s]) => s);
    const faturadoSqls = sqls.filter((s) => s.includes('fim_at <= now()'));
    expect(faturadoSqls.length).toBeGreaterThanOrEqual(3);
    for (const s of faturadoSqls) expect(s).toMatch(/origem = 'manual'/);
    // E há a query de PREVISTO (futuro).
    expect(sqls.some((s) => s.includes('fim_at > now()'))).toBe(true);
  });

  // ── MUDANÇA 4(a): GREATEST clampa parcela negativa (desconto > valor) -> nunca soma < 0 ──
  it('getFaturamento: TODAS as somas usam SUM(GREATEST(valor - desconto, 0)) (clamp em 0)', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await getFaturamento('clone_cirilo', 'tid-1', '2026-06-01', '2026-06-30');
    // total, por forma, por profissional, previsto — todas as 4 somas clampam com GREATEST.
    const sqls = (mockQuery.mock.calls as [string, unknown[]][]).map(([s]) => s);
    const somas = sqls.filter((s) => s.includes('SUM(GREATEST('));
    expect(somas.length).toBe(4); // nenhuma soma de dinheiro sem GREATEST
    for (const s of sqls) {
      // Nenhuma soma "crua" de valor - desconto SEM GREATEST sobrou (regressão).
      expect(s).not.toMatch(/SUM\(valor_cents - desconto_cents\)/);
      expect(s).not.toMatch(/SUM\(a\.valor_cents - a\.desconto_cents\)/);
    }
  });

  // ── MUDANÇA 4(b): predicado de previsão UNIFICADO (status <> 'cancelado' AND fim_at > now()) ──
  it('predicado de previsão é UNIFICADO em getFaturamento (previsto) e getComissao (previsao)', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await getFaturamento('clone_dragon', 'tid-2', '2026-06-01', '2026-06-30');
    const fatSqls = (mockQuery.mock.calls as [string, unknown[]][]).map(([s]) => s);
    // A query de PREVISTO usa o fragmento unificado (status <> 'cancelado' AND fim_at > now()).
    expect(fatSqls.some((s) => s.includes("status <> 'cancelado' AND fim_at > now()"))).toBe(true);

    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await getComissao('clone_dragon', 'tid-2', '2026-06-01', '2026-06-30', 'previsao');
    const [sqlPrev] = lastCall();
    // getComissao previsao usa o MESMO predicado (com alias a.), não mais status = 'agendado'.
    expect(sqlPrev).toContain("a.status <> 'cancelado' AND a.fim_at > now()");
    expect(sqlPrev).not.toContain("a.status = 'agendado'");
  });

  it('getFaturamento: ticket médio = round(total/count) + previsto exposto', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total_cents: '10000', count: '3' }], rowCount: 1 }) // total
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // por forma
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // por profissional
      .mockResolvedValueOnce({ rows: [{ total_cents: '4500' }], rowCount: 1 }); // previsto
    const r = await getFaturamento('clone_cirilo', 'tid-1', '2026-06-01', '2026-06-30');
    expect(r.total_cents).toBe(10000);
    expect(r.count).toBe(3);
    expect(r.ticket_medio_cents).toBe(3333); // round(10000/3)
    expect(r.previsto_total_cents).toBe(4500); // futuro/aberto, aditivo
  });

  it('getComissao (default=faturado) PARTE de clone_colaboradores ativos, escopo slot+tenant, só FATURADO; SOLO (0 colaboradores) -> vazio', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r = await getComissao('clone_cirilo', 'tid-1', '2026-06-01', '2026-06-30');
    const [sql, params] = lastCall();
    // PARTE dos colaboradores ATIVOS do slot (tabela base) -> LEFT JOIN atendimentos.
    expect(sql).toMatch(/FROM clone_colaboradores cc/);
    expect(sql).toMatch(/LEFT JOIN atendimentos a/);
    expect(sql).toContain('cc.slot = $1');
    expect(sql).toContain('cc.ativo = TRUE');
    // tenant + período + faturado ficam no ON do JOIN (preserva o colaborador zerado).
    expect(sql).toContain('a.tenant_id = $2');
    expect(sql).toContain('a.deleted_at IS NULL');
    expect(sql).toContain('a.fim_at <= now()');
    // Default = faturado: NUNCA conta agendamento futuro.
    expect(sql).not.toContain('a.fim_at > now()');
    // Faturado AO VIVO (fix dinheiro): projeta sobre o pct CORRENTE, NÃO usa o snapshot
    // congelado a.comissao_cents (que é 0 nas linhas de agenda — zerava o Faturado).
    expect(sql).toContain('cc.comissao_pct');
    expect(sql).not.toContain('SUM(a.comissao_cents)');
    expect(params).toEqual(['clone_cirilo', 'tid-1', '2026-06-01', '2026-06-30']);
    expect(r.balde).toBe('faturado');
    expect(r.total_cents).toBe(0); // SOLO -> sem comissão (0 colaboradores)
    expect(r.por_profissional).toEqual([]);
  });

  // A comissão ACOMPANHA o reprice: ela é live-compute sobre o BRUTO (valor - desconto) DA LINHA.
  // Quando a troca de serviço reprecifica valor_cents, o bruto muda e a comissão recalcula sozinha
  // (a expr SQL lê a.valor_cents/a.desconto_cents correntes, não um snapshot). Travamos a expr.
  it('comissão é live-compute sobre o BRUTO corrente da linha (reprice flui automático)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await getComissao('clone_dragon', 'tid-2', '2026-06-01', '2026-06-30', 'faturado');
    const [sql] = lastCall();
    // round(GREATEST(valor - desconto, 0) * pct corrente / 100) — sobre as colunas VIVAS da linha.
    expect(sql).toContain(
      'ROUND(GREATEST(a.valor_cents - a.desconto_cents, 0) * COALESCE(cc.comissao_pct, 0) / 100.0)',
    );
    // Não usa snapshot congelado (a.comissao_cents) -> repricar valor_cents reflete na comissão.
    expect(sql).not.toContain('SUM(a.comissao_cents)');
  });

  it('getComissao (faturado) soma a comissão AO VIVO (pct corrente) por profissional', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          colaborador_id: 9,
          profissional_nome: 'Ana',
          total_bruto_cents: '5000',
          comissao_pct: '40.00',
          comissao_cents: '2000', // round(5000 * 40 / 100) calculado no SQL ao vivo
          count: '2',
        },
        {
          colaborador_id: 10,
          profissional_nome: 'Bia',
          total_bruto_cents: '3000',
          comissao_pct: '50.00',
          comissao_cents: '1500',
          count: '1',
        },
      ],
      rowCount: 2,
    });
    const r = await getComissao('clone_dragon', 'tid-2', '2026-06-01', '2026-06-30', 'faturado');
    expect(r.balde).toBe('faturado');
    expect(r.total_cents).toBe(3500);
    expect(r.por_profissional).toHaveLength(2);
    expect(r.por_profissional[0]).toMatchObject({
      colaborador_id: 9,
      total_bruto_cents: 5000,
      comissao_pct: 40,
      comissao_cents: 2000,
    });
  });

  // ── BUG DE DINHEIRO 1 (ADR 0027): Faturado deixava comissão ZERAR ─────────────────────
  // As linhas derivadas da agenda têm a.comissao_cents=0 congelado (nada congela na
  // realização). O SQL ANTIGO somava esse snapshot -> Faturado=R$0 mesmo com atendimento real.
  // Fix: Faturado calcula AO VIVO (round(bruto*pct/100), pct corrente) — MESMA fórmula da
  // Previsão. Estes dois testes travam: (a) o SQL é a projeção ao vivo, idêntico nos dois
  // baldes a menos da janela; (b) pra UM evento passado, Faturado bate com Previsão (≠ 0).
  it('BUG1: faturado e previsao usam a MESMA projeção ao vivo no SQL (só muda a janela)', async () => {
    await getComissao('clone_dragon', 'tid-2', '2026-06-01', '2026-06-30', 'faturado');
    const [sqlFat] = lastCall();
    await getComissao('clone_dragon', 'tid-2', '2026-06-01', '2026-06-30', 'previsao');
    const [sqlPrev] = lastCall();
    // A expressão de comissão ao vivo (round(GREATEST(bruto,0) * pct corrente / 100)) está nos DOIS.
    const projExpr =
      'ROUND(GREATEST(a.valor_cents - a.desconto_cents, 0) * COALESCE(cc.comissao_pct, 0) / 100.0)';
    expect(sqlFat).toContain(projExpr);
    expect(sqlPrev).toContain(projExpr);
    // Nenhum dos dois usa mais o snapshot congelado.
    expect(sqlFat).not.toContain('SUM(a.comissao_cents)');
    expect(sqlPrev).not.toContain('SUM(a.comissao_cents)');
    // Só a JANELA difere: faturado olha o passado, previsao o futuro.
    expect(sqlFat).toContain('a.fim_at <= now()');
    expect(sqlFat).not.toContain('a.fim_at > now()');
    expect(sqlPrev).toContain('a.fim_at > now()');
    expect(sqlPrev).not.toContain('a.fim_at <= now()');
  });

  it('BUG1: evento PASSADO -> Faturado mostra a comissão real (R$16,50), não R$0', async () => {
    // Cenário do bug: 1 corte de R$50 (5000c), pct 33%, JÁ realizado (fim_at no passado).
    // ANTES: a.comissao_cents=0 congelado -> Faturado somava 0. AGORA: round(5000*33/100)=1650.
    // O SQL faz a conta; o mock devolve o que o SQL ao vivo retornaria (= o que a Previsão daria).
    const liveRow = {
      colaborador_id: 1,
      profissional_nome: 'Bruno',
      total_bruto_cents: '5000',
      comissao_pct: '33',
      comissao_cents: '1650', // round(5000 * 33 / 100) — ao vivo, NÃO o snapshot 0
      count: '1',
    };
    mockQuery.mockResolvedValueOnce({ rows: [liveRow], rowCount: 1 });
    const fat = await getComissao('clone_dragon', 'tid-2', '2026-06-01', '2026-06-30', 'faturado');
    expect(fat.total_cents).toBe(1650); // R$16,50 — NÃO zero
    expect(fat.por_profissional[0]).toMatchObject({ colaborador_id: 1, comissao_cents: 1650 });

    // E bate com a Previsão pro MESMO evento se ele fosse futuro (mesma fórmula ao vivo).
    mockQuery.mockResolvedValueOnce({ rows: [liveRow], rowCount: 1 });
    const prev = await getComissao('clone_dragon', 'tid-2', '2026-06-01', '2026-06-30', 'previsao');
    expect(prev.total_cents).toBe(fat.total_cents);
  });

  it('getComissao balde=previsao: só agendamentos FUTUROS, projeta sobre o pct CORRENTE', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r = await getComissao('clone_dragon', 'tid-2', '2026-06-01', '2026-06-30', 'previsao');
    const [sql, params] = lastCall();
    // PREVISÃO unificada (ADR 0027): status <> 'cancelado' AND fim_at > now() (mesmo predicado
    // de getFaturamento/listAtendimentos). Antes era status = 'agendado' (divergente).
    expect(sql).toContain("a.status <> 'cancelado' AND a.fim_at > now()");
    expect(sql).not.toContain("a.status = 'agendado'");
    expect(sql).not.toContain('a.fim_at <= now()');
    // Projeta sobre o pct corrente do colaborador (não usa o snapshot congelado).
    expect(sql).toContain('cc.comissao_pct');
    expect(sql).not.toContain('SUM(a.comissao_cents)');
    // PARTE dos colaboradores ativos do slot; nunca conta linha deletada.
    expect(sql).toContain('cc.ativo = TRUE');
    expect(sql).toContain('a.deleted_at IS NULL');
    expect(params).toEqual(['clone_dragon', 'tid-2', '2026-06-01', '2026-06-30']);
    expect(r.balde).toBe('previsao');
    expect(r.total_cents).toBe(0);
    expect(r.por_profissional).toEqual([]);
  });

  it('getComissao balde=previsao: soma a comissão PROJETADA (SQL) por profissional', async () => {
    // A projeção é feita no SQL (round(bruto*pct/100)); aqui validamos o mapeamento do retorno.
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          colaborador_id: 9,
          profissional_nome: 'Ana',
          total_bruto_cents: '10000',
          comissao_pct: '40.00',
          comissao_cents: '4000',
          count: '3',
        },
      ],
      rowCount: 1,
    });
    const r = await getComissao('clone_dragon', 'tid-2', '2026-06-01', '2026-06-30', 'previsao');
    expect(r.balde).toBe('previsao');
    expect(r.total_cents).toBe(4000);
    expect(r.por_profissional[0]).toMatchObject({
      colaborador_id: 9,
      total_bruto_cents: 10000,
      comissao_pct: 40,
      comissao_cents: 4000,
    });
  });

  it('getComissao balde=previsao: profissional com comissao_pct=0 APARECE na lista (comissão 0)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          colaborador_id: 11,
          profissional_nome: 'Zé',
          total_bruto_cents: '8000',
          comissao_pct: '0',
          comissao_cents: '0',
          count: '2',
        },
      ],
      rowCount: 1,
    });
    const r = await getComissao('clone_dragon', 'tid-2', '2026-06-01', '2026-06-30', 'previsao');
    expect(r.por_profissional).toHaveLength(1);
    expect(r.por_profissional[0]).toMatchObject({
      colaborador_id: 11,
      comissao_pct: 0,
      comissao_cents: 0, // pct 0 -> projeção 0, mas aparece com a base bruta
      total_bruto_cents: 8000,
    });
    expect(r.total_cents).toBe(0);
  });
});

// ── TODOS OS ATIVOS aparecem (mesmo sem booking) — foco desta mudança ─────────────────
describe('getComissao — lista TODOS os colaboradores ATIVOS (com e sem atendimento)', () => {
  it('colaborador ATIVO SEM atendimento aparece com bruto 0 / comissão 0 + o comissao_pct dele', async () => {
    // O LEFT JOIN devolve a linha do colaborador com zeros (e o pct corrente preservado).
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          colaborador_id: 7,
          profissional_nome: 'eduardo',
          total_bruto_cents: '0',
          comissao_pct: '20',
          comissao_cents: '0',
          count: '0',
        },
      ],
      rowCount: 1,
    });
    const r = await getComissao('clone_dragon', 'tid-2', '2026-06-01', '2026-06-30', 'previsao');
    expect(r.por_profissional).toHaveLength(1);
    expect(r.por_profissional[0]).toMatchObject({
      colaborador_id: 7,
      profissional_nome: 'eduardo',
      total_bruto_cents: 0,
      comissao_pct: 20, // o % configurado aparece mesmo sem booking
      comissao_cents: 0,
      count: 0,
    });
    expect(r.total_cents).toBe(0); // zerado não altera o total
  });

  it('mistura: quem tem booking traz valores reais, quem não tem vem zerado; total = só os reais', async () => {
    // dragon na Previsão: Bruno 33% (com booking), eduardo 20% (sem), maria 10% (com), bruna 50% (sem).
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          colaborador_id: 1,
          profissional_nome: 'Bruno',
          total_bruto_cents: '10000',
          comissao_pct: '33',
          comissao_cents: '3300',
          count: '2',
        },
        {
          colaborador_id: 3,
          profissional_nome: 'maria',
          total_bruto_cents: '5000',
          comissao_pct: '10',
          comissao_cents: '500',
          count: '1',
        },
        {
          colaborador_id: 2,
          profissional_nome: 'eduardo',
          total_bruto_cents: '0',
          comissao_pct: '20',
          comissao_cents: '0',
          count: '0',
        },
        {
          colaborador_id: 4,
          profissional_nome: 'bruna',
          total_bruto_cents: '0',
          comissao_pct: '50',
          comissao_cents: '0',
          count: '0',
        },
      ],
      rowCount: 4,
    });
    const r = await getComissao('clone_dragon', 'tid-2', '2026-06-01', '2026-06-30', 'previsao');
    // Os 4 ativos aparecem.
    expect(r.por_profissional).toHaveLength(4);
    expect(r.por_profissional.map((p) => p.profissional_nome)).toEqual([
      'Bruno',
      'maria',
      'eduardo',
      'bruna',
    ]);
    // % preservado mesmo nos zerados.
    expect(r.por_profissional.find((p) => p.profissional_nome === 'eduardo')).toMatchObject({
      total_bruto_cents: 0,
      comissao_pct: 20,
      comissao_cents: 0,
    });
    expect(r.por_profissional.find((p) => p.profissional_nome === 'bruna')).toMatchObject({
      comissao_pct: 50,
      comissao_cents: 0,
    });
    // total = soma só dos que têm comissão real (3300 + 500). Zerados somam 0.
    expect(r.total_cents).toBe(3800);
  });

  it('colaborador INATIVO/removido NÃO aparece — a query filtra cc.ativo = TRUE', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await getComissao('clone_dragon', 'tid-2', '2026-06-01', '2026-06-30', 'faturado');
    const [sql] = lastCall();
    expect(sql).toContain('cc.ativo = TRUE'); // inativo nunca entra na base
  });

  it('faturado: colaborador ativo SEM booking expõe o pct CORRENTE (não 0) e bruto/comissão 0', async () => {
    // Fix dinheiro: o faturado agora expõe o pct corrente DIRETO (COALESCE(cc.comissao_pct,0)),
    // sem o CASE médio-efetivo antigo. Quem não tem booking aparece com o % configurado.
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          colaborador_id: 8,
          profissional_nome: 'eduardo',
          total_bruto_cents: '0',
          comissao_pct: '20', // pct corrente do colaborador (cc.comissao_pct)
          comissao_cents: '0',
          count: '0',
        },
      ],
      rowCount: 1,
    });
    const r = await getComissao('clone_dragon', 'tid-2', '2026-06-01', '2026-06-30', 'faturado');
    expect(r.por_profissional[0]).toMatchObject({
      profissional_nome: 'eduardo',
      total_bruto_cents: 0,
      comissao_pct: 20,
      comissao_cents: 0,
    });
    expect(r.total_cents).toBe(0);
    // O pct exposto no faturado é o corrente do colaborador (mesma expr da previsão), sem CASE.
    const [sql] = lastCall();
    expect(sql).toContain('COALESCE(cc.comissao_pct, 0)::numeric AS comissao_pct');
    expect(sql).not.toContain('ELSE COALESCE(cc.comissao_pct, 0) END');
  });

  it('SOLO/individual continua por_profissional vazio (0 colaboradores na tabela base)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r = await getComissao('clone_cirilo', 'tid-1', '2026-06-01', '2026-06-30', 'faturado');
    expect(r.por_profissional).toEqual([]);
    expect(r.total_cents).toBe(0);
  });
});
