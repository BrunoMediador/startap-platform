/**
 * Testes dos helpers de billing DERIVADO DA AGENDA (ADR 0027). `../client.js` é MOCKADO —
 * não toca banco. Validamos a forma do SQL + os params (o sticky e a idempotência vivem no
 * SQL, então asseguramos que o SQL certo é emitido com os valores certos).
 *
 * Cobertura:
 *  - upsertAtendimentoFromEvent: idempotente (ON CONFLICT no unique parcial), origem/status,
 *    pacote->valor 0, preço resolvido do catálogo quando ausente.
 *  - STICKY: o UPDATE do ON CONFLICT preserva colunas pinadas em dirty_fields (CASE ?).
 *  - softDeleteAtendimentoByEvent: soft-delete escopado por slot, idempotente.
 *  - listAtendimentos: predicado de balde previsao×faturado + escopo slot+tenant + total.
 *  - patchAtendimento: adiciona as colunas enviadas a dirty_fields (pin) + escopo.
 *  - softDeleteAtendimentoById: escopo slot+tenant, retorna bool por rowCount.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: { connect: vi.fn() },
  query: (...a: unknown[]) => mockQuery(...a),
}));

const {
  upsertAtendimentoFromEvent,
  syncAtendimentoFromEvent,
  softDeleteAtendimentoByEvent,
  resolvePrecoCents,
  listAtendimentos,
  patchAtendimento,
  softDeleteAtendimentoById,
} = await import('./atendimentos.js');

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

function lastCall(): [string, unknown[]] {
  const calls = mockQuery.mock.calls;
  return calls[calls.length - 1] as [string, unknown[]];
}

// Linha mínima devolvida pelo RETURNING (com dirty_fields como array já parseado pelo pg).
const ROW = {
  id: 1,
  slot: 'clone_dragon',
  gcal_event_id: 'evt_1',
  cliente_nome: null,
  cliente_contato: null,
  servico_nome: 'Corte',
  valor_cents: 5000,
  desconto_cents: 0,
  forma_pagamento: null,
  colaborador_id: null,
  comissao_pct: null,
  comissao_cents: 0,
  status: 'agendado',
  data: '2026-06-30',
  created_at: '2026-06-23T00:00:00Z',
  updated_at: '2026-06-23T00:00:00Z',
  origem: 'agenda',
  dirty_fields: [] as string[],
  inicio_at: '2026-06-30T12:00:00Z',
  fim_at: '2026-06-30T12:30:00Z',
  deleted_at: null,
};

describe('resolvePrecoCents (preço do catálogo flow_clones.servicos)', () => {
  it('acha pelo nome (case-insensitive/trim) e devolve preco_cents', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ servicos: [{ nome: 'Corte', preco_cents: 4500, duracao_min: 30 }] }],
      rowCount: 1,
    });
    expect(await resolvePrecoCents('clone_dragon', '  corte ')).toBe(4500);
    const [sql, params] = lastCall();
    expect(sql).toContain('FROM flow_clones WHERE slot = $1');
    expect(params).toEqual(['clone_dragon']);
  });

  it('serviço inexistente -> 0', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ servicos: [{ nome: 'Barba', preco_cents: 3000 }] }],
      rowCount: 1,
    });
    expect(await resolvePrecoCents('clone_dragon', 'Corte')).toBe(0);
  });

  it('servico_nome vazio -> 0 sem nem consultar', async () => {
    expect(await resolvePrecoCents('clone_dragon', '')).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('upsertAtendimentoFromEvent — idempotência + origem/status', () => {
  it('emite INSERT ... ON CONFLICT (slot, gcal_event_id) com origem=agenda, status=agendado', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ROW], rowCount: 1 });
    await upsertAtendimentoFromEvent({
      slot: 'clone_dragon',
      tenantId: 'tid-2',
      gcalEventId: 'evt_1',
      servicoNome: 'Corte',
      valorCents: 5000,
      inicioAt: '2026-06-30T12:00:00Z',
      fimAt: '2026-06-30T12:30:00Z',
    });
    const [sql, params] = lastCall();
    expect(sql).toContain('INSERT INTO atendimentos');
    expect(sql).toContain('ON CONFLICT (slot, gcal_event_id)');
    expect(sql).toContain("'agendado', 'agenda'");
    expect(params[0]).toBe('clone_dragon'); // slot
    expect(params[1]).toBe('tid-2'); // tenant_id parâmetro próprio
    expect(params[2]).toBe('evt_1'); // gcal_event_id
    expect(params[6]).toBe(5000); // valor explícito
  });

  it('preço AUSENTE -> resolve do catálogo (2 queries: SELECT servicos + UPSERT)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ servicos: [{ nome: 'Corte', preco_cents: 4500 }] }] })
      .mockResolvedValueOnce({ rows: [{ ...ROW, valor_cents: 4500 }], rowCount: 1 });
    await upsertAtendimentoFromEvent({
      slot: 'clone_dragon',
      tenantId: 'tid-2',
      gcalEventId: 'evt_1',
      servicoNome: 'Corte',
      // valorCents ausente -> catálogo
    });
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const [, params] = lastCall();
    expect(params[6]).toBe(4500); // veio do catálogo
  });

  it('PACOTE -> valor_cents=0 e desconto=0 (receita vive na venda do pacote)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...ROW, valor_cents: 0 }], rowCount: 1 });
    await upsertAtendimentoFromEvent({
      slot: 'clone_dragon',
      tenantId: 'tid-2',
      gcalEventId: 'evt_1',
      servicoNome: 'Corte',
      valorCents: 5000,
      descontoCents: 500,
      formaPagamento: 'pacote',
    });
    const [, params] = lastCall();
    expect(params[6]).toBe(0); // valor zerado
    expect(params[7]).toBe(0); // desconto zerado
    expect(params[8]).toBe('pacote'); // forma preservada
    // Pacote NÃO consulta catálogo (valor já é 0).
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('STICKY — o UPDATE do ON CONFLICT preserva colunas pinadas', () => {
  it('para CADA coluna derivável há um CASE WHEN dirty_fields ? coluna THEN antigo ELSE novo', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ROW], rowCount: 1 });
    await upsertAtendimentoFromEvent({
      slot: 'clone_dragon',
      tenantId: 'tid-2',
      gcalEventId: 'evt_1',
      servicoNome: 'Corte',
      valorCents: 5000,
    });
    const [sql] = lastCall();
    for (const col of [
      'valor_cents',
      'desconto_cents',
      'forma_pagamento',
      'servico_nome',
      'cliente_nome',
      'cliente_contato',
      'colaborador_id',
    ]) {
      expect(sql).toContain(`atendimentos.dirty_fields ? '${col}'`);
    }
    // Sticky comprovado: valor_cents só é trocado quando NÃO está pinado.
    expect(sql).toMatch(
      /valor_cents\s*=\s*CASE WHEN atendimentos\.dirty_fields \? 'valor_cents'\s+THEN atendimentos\.valor_cents ELSE EXCLUDED\.valor_cents END/,
    );
  });

  it('syncAtendimentoFromEvent é o mesmo caminho do upsert (alias B2)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ROW], rowCount: 1 });
    await syncAtendimentoFromEvent({
      slot: 'clone_dragon',
      tenantId: 'tid-2',
      gcalEventId: 'evt_1',
      servicoNome: 'Corte',
      valorCents: 5000,
    });
    const [sql] = lastCall();
    expect(sql).toContain('ON CONFLICT (slot, gcal_event_id)');
  });
});

describe('softDeleteAtendimentoByEvent (B2) — escopo + idempotência', () => {
  it('UPDATE deleted_at escopado por slot+event, só ativo (deleted_at IS NULL)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...ROW, deleted_at: '2026-06-23T01:00:00Z' }] });
    await softDeleteAtendimentoByEvent('clone_dragon', 'evt_1');
    const [sql, params] = lastCall();
    expect(sql).toContain('SET deleted_at = now()');
    expect(sql).toContain('WHERE slot = $1 AND gcal_event_id = $2 AND deleted_at IS NULL');
    expect(params).toEqual(['clone_dragon', 'evt_1']);
  });

  it('idempotente: nada ativo -> retorna null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await softDeleteAtendimentoByEvent('clone_dragon', 'evt_1')).toBeNull();
  });
});

describe('listAtendimentos — balde previsao×faturado (stateless)', () => {
  it('balde=previsao: status<>cancelado AND fim_at > now(), não deletado, escopado', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await listAtendimentos('clone_cirilo', 'tid-1', 'previsao', '2026-06-01', '2026-06-30');
    const [sql, params] = lastCall();
    expect(sql).toContain('a.slot = $1 AND a.tenant_id = $2');
    expect(sql).toContain('a.deleted_at IS NULL');
    expect(sql).toContain("a.status <> 'cancelado' AND a.fim_at > now()");
    expect(params).toEqual(['clone_cirilo', 'tid-1', '2026-06-01', '2026-06-30']);
  });

  it("balde=faturado: fim_at <= now() OR origem='manual', não deletado", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await listAtendimentos('clone_cirilo', 'tid-1', 'faturado', '2026-06-01', '2026-06-30');
    const [sql] = lastCall();
    expect(sql).toContain('a.deleted_at IS NULL');
    expect(sql).toContain("(a.fim_at <= now() OR a.origem = 'manual')");
  });

  it('total_cents = SUM(valor - desconto) das linhas listadas', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { ...ROW, id: 1, valor_cents: 5000, desconto_cents: 0, dirty_fields: [] },
        { ...ROW, id: 2, valor_cents: 3000, desconto_cents: 500, dirty_fields: ['valor_cents'] },
      ],
      rowCount: 2,
    });
    const r = await listAtendimentos(
      'clone_cirilo',
      'tid-1',
      'faturado',
      '2026-06-01',
      '2026-06-30',
    );
    expect(r.total_cents).toBe(5000 + (3000 - 500)); // 7500
    expect(r.atendimentos).toHaveLength(2);
    expect(r.atendimentos[1]?.dirty_fields).toEqual(['valor_cents']);
  });
});

describe('patchAtendimento — pina colunas enviadas em dirty_fields (sticky)', () => {
  it('SET das colunas enviadas + UNION dos dirty_fields (jsonb param, escopado)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...ROW, valor_cents: 7000, dirty_fields: ['valor_cents', 'forma_pagamento'] }],
      rowCount: 1,
    });
    const r = await patchAtendimento('clone_cirilo', 'tid-1', 1, {
      valorCents: 7000,
      formaPagamento: 'pix',
    });
    const [sql, params] = lastCall();
    expect(sql).toContain('valor_cents = $4');
    expect(sql).toContain('forma_pagamento = $5');
    // dirty_fields := DISTINCT(antigo || pinned). pinned vai como jsonb parametrizado.
    expect(sql).toContain('dirty_fields = (');
    expect(sql).toContain('jsonb_array_elements_text(a.dirty_fields ||');
    expect(sql).toContain(
      'WHERE a.slot = $1 AND a.tenant_id = $2 AND a.id = $3 AND a.deleted_at IS NULL',
    );
    // Retorno enriquecido: o PATCH re-seleciona via CTE com o MESMO LEFT JOIN do GET list.
    expect(sql).toContain('WITH upd AS');
    expect(sql).toContain('LEFT JOIN clone_colaboradores c');
    expect(sql).toContain('c.nome AS profissional_nome');
    expect(params.slice(0, 3)).toEqual(['clone_cirilo', 'tid-1', 1]);
    // último param = pinned serializado como JSON array das COLUNAS (não dos nomes de campo).
    expect(JSON.parse(params[params.length - 1] as string)).toEqual([
      'valor_cents',
      'forma_pagamento',
    ]);
    expect(r?.dirty_fields).toEqual(['valor_cents', 'forma_pagamento']);
  });

  // QA nit P3: o PATCH de uma linha COM colaborador (estabelecimento) deve devolver a Row
  // enriquecida com profissional_nome preenchido — senão o front pisca "Sem profissional".
  it('PATCH de linha com colaborador devolve profissional_nome preenchido (estabelecimento)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          ...ROW,
          colaborador_id: 9,
          profissional_nome: 'Eduardo',
          valor_cents: 7000,
          dirty_fields: ['valor_cents'],
        },
      ],
      rowCount: 1,
    });
    const r = await patchAtendimento('clone_dragon', 'tid-2', 5, { valorCents: 7000 });
    expect(r?.colaborador_id).toBe(9);
    expect(r?.profissional_nome).toBe('Eduardo'); // veio do LEFT JOIN, não some no PATCH
    expect(r?.valor_cents).toBe(7000);
    expect(r?.dirty_fields).toEqual(['valor_cents']);
  });

  it('PATCH de linha SOLO devolve profissional_nome null (sem colaborador)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { ...ROW, colaborador_id: null, profissional_nome: null, dirty_fields: ['valor_cents'] },
      ],
      rowCount: 1,
    });
    const r = await patchAtendimento('clone_cirilo', 'tid-1', 1, { valorCents: 1 });
    expect(r?.colaborador_id).toBeNull();
    expect(r?.profissional_nome).toBeNull();
  });

  it('patch só servicoNome -> pina servico_nome', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { ...ROW, servico_nome: 'Barba', profissional_nome: null, dirty_fields: ['servico_nome'] },
      ],
      rowCount: 1,
    });
    await patchAtendimento('clone_cirilo', 'tid-1', 1, { servicoNome: 'Barba' });
    const [sql, params] = lastCall();
    expect(sql).toContain('servico_nome = $4');
    expect(JSON.parse(params[params.length - 1] as string)).toEqual(['servico_nome']);
  });

  it('patch vazio -> SELECT enriquecido da linha atual (sem UPDATE), escopado', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...ROW, profissional_nome: null }], rowCount: 1 });
    await patchAtendimento('clone_cirilo', 'tid-1', 1, {});
    const [sql, params] = lastCall();
    expect(sql).toContain('SELECT');
    expect(sql).not.toContain('UPDATE atendimentos');
    // Mesmo no no-op o retorno é enriquecido (LEFT JOIN), pra casar 1:1 com o GET list.
    expect(sql).toContain('LEFT JOIN clone_colaboradores c');
    expect(sql).toContain(
      'WHERE a.slot = $1 AND a.tenant_id = $2 AND a.id = $3 AND a.deleted_at IS NULL',
    );
    expect(params).toEqual(['clone_cirilo', 'tid-1', 1]);
  });

  it('id inexistente no escopo -> null (anti-IDOR)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await patchAtendimento('clone_cirilo', 'tid-1', 999, { valorCents: 1 })).toBeNull();
  });
});

describe('softDeleteAtendimentoById — escopo slot+tenant', () => {
  it('UPDATE escopado por slot+tenant+id; true quando deletou', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const ok = await softDeleteAtendimentoById('clone_cirilo', 'tid-1', 1);
    expect(ok).toBe(true);
    const [sql, params] = lastCall();
    expect(sql).toContain('SET deleted_at = now()');
    expect(sql).toContain('WHERE slot = $1 AND tenant_id = $2 AND id = $3 AND deleted_at IS NULL');
    expect(params).toEqual(['clone_cirilo', 'tid-1', 1]);
  });

  it('idempotente: já deletado / inexistente -> false', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await softDeleteAtendimentoById('clone_cirilo', 'tid-1', 1)).toBe(false);
  });
});
