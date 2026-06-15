/**
 * Testes da DEDUÇÃO / ESTORNO de pacotes (ADR 0025 BLOCO 2b).
 *
 * `../client.js` é MOCKADO: `query` (leituras) e `pool.connect()` (transação). Validamos:
 *  - precedência determinística (escolherCreditoParaDeducao) — unit puro, sem DB;
 *  - dedução grava UMA redemption (-1, redeem) ON CONFLICT DO NOTHING, ligada ao evento;
 *  - IDEMPOTÊNCIA: retry do MESMO gcal_event_id não duplica (ON CONFLICT cobre);
 *  - "por fora": serviço não coberto / sem pacote ativo / usa_pacote=false → não desconta;
 *  - saldo 0/expirado/esgotado/cancelado → não desconta (agenda avulso);
 *  - estorno (+1, refund) funciona e é idempotente; sem redeem → no_redeem;
 *  - ISOLAMENTO cross-tenant: tenant_id entra no WHERE quando fornecido;
 *  - individual (colaborador_id NULL) E estabelecimento (preenchido);
 *  - fail-safe: erro de DB → ROLLBACK + avulso (atendimento não derrubado).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockConnect = vi.fn();
const mockRelease = vi.fn();

vi.mock('../client.js', () => ({
  pool: { connect: (...a: unknown[]) => mockConnect(...a) },
  query: (...a: unknown[]) => mockQuery(...a),
}));

const { escolherCreditoParaDeducao, redeemForBooking, refundForBooking, findSuspectDoubleRedeems } =
  await import('./packages.js');

import type { ClientPackageCredit } from './packages.js';

/** Crédito já normalizado (do tipo que escolherCreditoParaDeducao consome). */
function credit(over: Partial<ClientPackageCredit> = {}): ClientPackageCredit {
  const servicos = over.servicos_cobertos ?? ['Corte', 'Barba'];
  return {
    credit_id: over.credit_id ?? 1,
    package_id: over.package_id ?? 1,
    slot: over.slot ?? 'cirilobarbearia',
    nome: over.nome ?? 'Pacote 5 Cortes',
    sessoes_restantes: over.sessoes_restantes ?? 3,
    sessoes_total: over.sessoes_total ?? 5,
    data_expiracao: over.data_expiracao ?? '2999-12-31',
    expirado: over.expirado ?? false,
    estado: over.estado ?? 'ATIVO',
    servicos_cobertos: servicos,
    colaborador_id: over.colaborador_id ?? null,
    cobre: (s: string) => servicos.some((x) => x.trim().toLowerCase() === s.trim().toLowerCase()),
  };
}

/** Linha CRUA de crédito (como o SELECT FOR UPDATE devolve). */
function rawCredit(over: Record<string, unknown> = {}) {
  return {
    credit_id: '1',
    package_id: '1',
    slot: 'cirilobarbearia',
    nome: 'Pacote 5 Cortes',
    sessoes_total: 5,
    sessoes_restantes_cache: 3,
    saldo_ledger: '3',
    data_expiracao: '2999-12-31',
    expirado: false,
    status: 'active',
    servicos_cobertos: ['Corte', 'Barba'],
    colaborador_id: null,
    ...over,
  };
}

/**
 * Programa o fake client de transação. `activeRows` = retorno do SELECT FOR UPDATE.
 * `insertRowCount` = rowCount do INSERT redemption (0 = ON CONFLICT pegou OU guarda saldo>0
 *   barrou). `redeemJaExiste` decide o que a query EXISTS responde quando insertRowCount=0:
 *   true = retry idempotente (já havia redeem) -> reporta descontado; false = guarda barrou
 *   (corrida perdeu a última sessão) -> avulso. Default true (caso idempotência comum).
 * `rebuildSaldo` = saldo devolvido pelo UPDATE de cache.
 */
function programTx(opts: {
  activeRows?: unknown[];
  insertRowCount?: number;
  redeemJaExiste?: boolean;
  rebuildSaldo?: number;
}) {
  const activeRows = opts.activeRows ?? [];
  const insertRowCount = opts.insertRowCount ?? 1;
  const redeemJaExiste = opts.redeemJaExiste ?? true;
  const rebuildSaldo = opts.rebuildSaldo ?? 2;
  mockClientQuery.mockReset();
  mockClientQuery.mockImplementation(async (sql: string) => {
    if (/^\s*BEGIN/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/^\s*COMMIT/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/^\s*ROLLBACK/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/FOR UPDATE OF c/.test(sql)) return { rows: activeRows, rowCount: activeRows.length };
    if (/INSERT INTO package_redemptions/.test(sql)) return { rows: [], rowCount: insertRowCount };
    // Guarda anti-over-consumption: EXISTS(...reason='redeem') distingue retry de corrida.
    if (/EXISTS\([\s\S]*reason = 'redeem'/.test(sql))
      return { rows: [{ existe: redeemJaExiste }], rowCount: 1 };
    if (/FROM package_redemptions[\s\S]*reason = 'redeem'/.test(sql))
      return { rows: opts.activeRows?.length ? [{ credit_id: '1' }] : [] };
    if (/UPDATE client_package_credits/.test(sql))
      return { rows: [{ saldo: rebuildSaldo }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [] });
  mockRelease.mockReset();
  mockConnect.mockReset().mockResolvedValue({
    query: (...a: unknown[]) => mockClientQuery(...a),
    release: (...a: unknown[]) => mockRelease(...a),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('escolherCreditoParaDeducao — precedência determinística', () => {
  it('colaborador-específico ANTES de casa', () => {
    const casa = credit({ credit_id: 1, colaborador_id: null });
    const espec = credit({ credit_id: 2, colaborador_id: 42 });
    const escolhido = escolherCreditoParaDeducao([casa, espec], 42);
    expect(escolhido?.credit_id).toBe(2);
  });

  it('entre dois da casa: MENOR validade primeiro (expira antes)', () => {
    const tarde = credit({ credit_id: 1, data_expiracao: '2030-12-31' });
    const cedo = credit({ credit_id: 2, data_expiracao: '2026-01-31' });
    const escolhido = escolherCreditoParaDeducao([tarde, cedo], null);
    expect(escolhido?.credit_id).toBe(2);
  });

  it('mesma validade: MAIS ANTIGO (credit_id menor) — desempate estável', () => {
    const novo = credit({ credit_id: 9, data_expiracao: '2027-06-30' });
    const antigo = credit({ credit_id: 3, data_expiracao: '2027-06-30' });
    const escolhido = escolherCreditoParaDeducao([novo, antigo], null);
    expect(escolhido?.credit_id).toBe(3);
  });

  it('pacote colaborador-específico de OUTRO colaborador NÃO é elegível', () => {
    const espec = credit({ credit_id: 2, colaborador_id: 42 });
    expect(escolherCreditoParaDeducao([espec], 99)).toBeNull();
    // mas o da casa vale sempre:
    const casa = credit({ credit_id: 3, colaborador_id: null });
    expect(escolherCreditoParaDeducao([espec, casa], 99)?.credit_id).toBe(3);
  });

  it('lista vazia → null', () => {
    expect(escolherCreditoParaDeducao([], 1)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('redeemForBooking — dedução', () => {
  it('serviço COBERTO + pacote ATIVO: grava 1 redemption (-1, redeem) idempotente', async () => {
    programTx({ activeRows: [rawCredit()], insertRowCount: 1, rebuildSaldo: 2 });
    const r = await redeemForBooking({
      slot: 'cirilobarbearia',
      phoneHmac: 'h',
      gcalEventId: 'evt-1',
      servicoNome: 'Corte',
    });
    expect(r.descontou_do_pacote).toBe(true);
    expect(r.avulso).toBe(false);
    expect(r.motivo).toBe('descontado');
    expect(r.sessoes_restantes).toBe(2);

    const insert = mockClientQuery.mock.calls.find((c) =>
      /INSERT INTO package_redemptions/.test(String(c[0])),
    );
    expect(insert).toBeDefined();
    const sql = String(insert?.[0]);
    expect(sql).toContain("'redeem'");
    expect(sql).toContain('-1');
    expect(sql).toContain('ON CONFLICT (gcal_event_id, reason) DO NOTHING');
    // GUARDA anti-over-consumption: o INSERT só grava -1 se o saldo do ledger > 0.
    expect(sql).toContain('> 0');
    expect(sql).toContain('SUM(pr.delta)');
    // REGRESSÃO do P0 (#321): o SELECT de lock NÃO pode combinar GROUP BY com FOR UPDATE
    // (PG 16 rejeita: erro 0A000). O saldo vem de subquery escalar, não de GROUP BY.
    const selCall = mockClientQuery.mock.calls.find((c) => /FOR UPDATE OF c/.test(String(c[0])));
    const selSql = String(selCall?.[0]);
    expect(selSql).not.toMatch(/GROUP BY/i);
    expect(selSql).toContain('FOR UPDATE OF c');
    // NUNCA UPDATE solto no cache: a baixa é reconstruída do ledger.
    const cacheUpd = mockClientQuery.mock.calls.find((c) =>
      /UPDATE client_package_credits/.test(String(c[0])),
    );
    expect(String(cacheUpd?.[0])).toContain('SUM(pr.delta)');
    expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('IDEMPOTÊNCIA: retry do MESMO evento (ON CONFLICT pegou, 0 linhas, redeem já existe) → 1 desconto só', async () => {
    // INSERT devolve rowCount 0 (já existia); EXISTS confirma que há redeem → descontou=true (sem dupla baixa).
    programTx({
      activeRows: [rawCredit({ saldo_ledger: '2' })],
      insertRowCount: 0,
      redeemJaExiste: true,
      rebuildSaldo: 2,
    });
    const r = await redeemForBooking({
      slot: 's',
      phoneHmac: 'h',
      gcalEventId: 'evt-1',
      servicoNome: 'Corte',
    });
    expect(r.descontou_do_pacote).toBe(true);
    expect(r.sessoes_restantes).toBe(2); // saldo não caiu de novo
  });

  it('OVER-CONSUMPTION: guarda saldo>0 barra o INSERT (0 linhas, redeem NÃO existe) → avulso, sem -1', async () => {
    // Corrida: outra transação levou a última sessão; o INSERT com AND saldo>0 não produz linha
    // e NÃO há redeem prévio deste evento → cai pra avulso (sem_pacote), nunca grava -1 abaixo de 0.
    programTx({
      activeRows: [rawCredit({ saldo_ledger: '1' })],
      insertRowCount: 0,
      redeemJaExiste: false,
    });
    const r = await redeemForBooking({
      slot: 's',
      phoneHmac: 'h',
      gcalEventId: 'evt-race',
      servicoNome: 'Corte',
    });
    expect(r.descontou_do_pacote).toBe(false);
    expect(r.avulso).toBe(true);
    expect(r.motivo).toBe('sem_pacote');
    // garante que CONSULTOU o EXISTS (a guarda) e fez COMMIT (não rollback).
    const existsCall = mockClientQuery.mock.calls.find((c) =>
      /EXISTS\([\s\S]*reason = 'redeem'/.test(String(c[0])),
    );
    expect(existsCall).toBeDefined();
    expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('usa_pacote=false: NÃO desconta, agenda avulso, sem tocar o banco', async () => {
    programTx({ activeRows: [rawCredit()] });
    const r = await redeemForBooking({
      slot: 's',
      phoneHmac: 'h',
      gcalEventId: 'evt-2',
      servicoNome: 'Corte',
      usarPacote: false,
    });
    expect(r.descontou_do_pacote).toBe(false);
    expect(r.avulso).toBe(true);
    expect(r.motivo).toBe('nao_solicitado');
    expect(mockConnect).not.toHaveBeenCalled(); // nem abriu conexão
  });

  it('"por fora": serviço NÃO coberto → avulso (motivo sem_pacote)', async () => {
    programTx({ activeRows: [rawCredit({ servicos_cobertos: ['Corte'] })] });
    const r = await redeemForBooking({
      slot: 's',
      phoneHmac: 'h',
      gcalEventId: 'evt-3',
      servicoNome: 'Hidratação', // fora da cobertura
    });
    expect(r.descontou_do_pacote).toBe(false);
    expect(r.avulso).toBe(true);
    expect(r.motivo).toBe('sem_pacote');
  });

  it('saldo 0 (ESGOTADO no ledger) → não desconta, avulso', async () => {
    programTx({ activeRows: [rawCredit({ saldo_ledger: '0' })] });
    const r = await redeemForBooking({
      slot: 's',
      phoneHmac: 'h',
      gcalEventId: 'e',
      servicoNome: 'Corte',
    });
    expect(r.descontou_do_pacote).toBe(false);
    expect(r.motivo).toBe('sem_pacote'); // ESGOTADO não entra em ativos
  });

  it('EXPIRADO → não desconta (não está entre os ATIVOS)', async () => {
    programTx({ activeRows: [rawCredit({ expirado: true, data_expiracao: '2020-01-01' })] });
    const r = await redeemForBooking({
      slot: 's',
      phoneHmac: 'h',
      gcalEventId: 'e',
      servicoNome: 'Corte',
    });
    expect(r.descontou_do_pacote).toBe(false);
  });

  it('CANCELADO → não desconta', async () => {
    programTx({ activeRows: [rawCredit({ status: 'cancelled' })] });
    const r = await redeemForBooking({
      slot: 's',
      phoneHmac: 'h',
      gcalEventId: 'e',
      servicoNome: 'Corte',
    });
    expect(r.descontou_do_pacote).toBe(false);
  });

  it('ISOLAMENTO: tenant_id entra no WHERE do SELECT quando fornecido', async () => {
    programTx({ activeRows: [rawCredit()], insertRowCount: 1 });
    await redeemForBooking({
      slot: 's',
      tenantId: 'tenant-uuid-1',
      phoneHmac: 'h',
      gcalEventId: 'e',
      servicoNome: 'Corte',
    });
    const sel = mockClientQuery.mock.calls.find((c) => /FOR UPDATE OF c/.test(String(c[0])));
    expect(String(sel?.[0])).toContain('c.tenant_id = $3');
    expect(sel?.[1]).toEqual(['s', 'h', 'tenant-uuid-1']);
  });

  it('ESTABELECIMENTO: pacote do colaborador é usado quando colaboradorId casa', async () => {
    programTx({
      activeRows: [rawCredit({ credit_id: '7', colaborador_id: '42' })],
      insertRowCount: 1,
      rebuildSaldo: 4,
    });
    const r = await redeemForBooking({
      slot: 'estab',
      phoneHmac: 'h',
      gcalEventId: 'e',
      servicoNome: 'Corte',
      colaboradorId: 42,
    });
    expect(r.descontou_do_pacote).toBe(true);
    expect(r.colaborador_id).toBe(42);
  });

  it('fail-safe: erro de DB → ROLLBACK + avulso (motivo erro), não lança', async () => {
    mockClientQuery.mockReset().mockImplementation(async (sql: string) => {
      if (/^\s*BEGIN/i.test(sql)) return { rows: [] };
      if (/FOR UPDATE OF c/.test(sql)) throw new Error('pg down');
      return { rows: [] };
    });
    const r = await redeemForBooking({
      slot: 's',
      phoneHmac: 'h',
      gcalEventId: 'e',
      servicoNome: 'Corte',
    });
    expect(r.descontou_do_pacote).toBe(false);
    expect(r.avulso).toBe(true);
    expect(r.motivo).toBe('erro');
    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('refundForBooking — estorno manual idempotente', () => {
  function programRefund(opts: { hasRedeem: boolean; insertRowCount: number; saldo?: number }) {
    mockClientQuery.mockReset();
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM package_redemptions[\s\S]*reason = 'redeem'/.test(sql))
        return { rows: opts.hasRedeem ? [{ credit_id: '5' }] : [] };
      if (/INSERT INTO package_redemptions/.test(sql))
        return { rows: [], rowCount: opts.insertRowCount };
      if (/UPDATE client_package_credits/.test(sql))
        return { rows: [{ saldo: opts.saldo ?? 3 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  }

  it('estorna 1 sessão (+1, refund) quando há redeem do evento', async () => {
    programRefund({ hasRedeem: true, insertRowCount: 1, saldo: 3 });
    const r = await refundForBooking({ slot: 's', gcalEventId: 'evt-1', actor: 'ops' });
    expect(r.refunded).toBe(true);
    expect(r.reason).toBe('refunded');
    expect(r.sessoes_restantes).toBe(3);
    const insert = mockClientQuery.mock.calls.find((c) =>
      /INSERT INTO package_redemptions/.test(String(c[0])),
    );
    expect(String(insert?.[0])).toContain("'refund'");
    expect(String(insert?.[0])).toContain('ON CONFLICT (gcal_event_id, reason) DO NOTHING');
  });

  it('IDEMPOTENTE: 2ª chamada (ON CONFLICT pegou, 0 linhas) não devolve sessão de novo', async () => {
    programRefund({ hasRedeem: true, insertRowCount: 0, saldo: 3 });
    const r = await refundForBooking({ slot: 's', gcalEventId: 'evt-1' });
    expect(r.refunded).toBe(false);
    expect(r.reason).toBe('already_refunded');
  });

  it('sem redeem do evento → no_redeem (nada a estornar)', async () => {
    programRefund({ hasRedeem: false, insertRowCount: 0 });
    const r = await refundForBooking({ slot: 's', gcalEventId: 'sem-redeem' });
    expect(r.refunded).toBe(false);
    expect(r.reason).toBe('no_redeem');
  });

  it('tenant_id entra no WHERE do lookup quando fornecido (isolamento)', async () => {
    programRefund({ hasRedeem: true, insertRowCount: 1 });
    await refundForBooking({ slot: 's', tenantId: 't-1', gcalEventId: 'evt-1' });
    const sel = mockClientQuery.mock.calls.find((c) =>
      /FROM package_redemptions[\s\S]*reason = 'redeem'/.test(String(c[0])),
    );
    expect(String(sel?.[0])).toContain('tenant_id = $3');
    expect(sel?.[1]).toEqual(['evt-1', 's', 't-1']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('findSuspectDoubleRedeems — relatório de reconciliação (read-only)', () => {
  it('só leitura; parametriza janela + limit (e slot quando dado); nunca toca telefone', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await findSuspectDoubleRedeems({ slot: 'cirilobarbearia', janelaHoras: 24, limit: 50 });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("reason = 'redeem'");
    expect(sql).toContain('HAVING COUNT(*) > 1');
    expect(sql).toContain('rd.redeems - COALESCE(rf.refunds, 0) > 1');
    expect(sql).not.toMatch(/phone|telefone|hmac/i); // sem PII
    expect(params).toEqual([24, 50, 'cirilobarbearia']);
  });

  it('normaliza linha do banco (counts string -> number, event_ids array)', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          credit_id: '7',
          slot: 's',
          servico_nome: 'Corte',
          redeems: '2',
          refunds: '0',
          gcal_event_ids: ['evt-velho', 'evt-novo'],
          primeiro: '2026-06-14T10:00:00Z',
          ultimo: '2026-06-14T18:00:00Z',
        },
      ],
    });
    const out = await findSuspectDoubleRedeems();
    expect(out[0]).toMatchObject({
      credit_id: 7,
      redeems: 2,
      refunds: 0,
      gcal_event_ids: ['evt-velho', 'evt-novo'],
    });
  });

  it('sem slot: varre todos (params só janela default + limit)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await findSuspectDoubleRedeems();
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([48, 200]); // default 48h / limit 200
  });
});
