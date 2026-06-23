/**
 * Testes do LIFECYCLE pós-venda de pacote (ADR 0025 BLOCO 2c):
 *  - recargaCredit: soma sessões + redemption(+N, recharge) + cresce sessoes_total + reativa
 *    status (exhausted -> active) + nova validade opcional;
 *  - IDEMPOTÊNCIA: mesma idempotencyKey (ON CONFLICT) NÃO soma de novo nem mexe na validade;
 *  - mudarVencimento: UPDATE data_expiracao escopado, sem tocar o ledger;
 *  - cancelarCredito: status='cancelled', ledger intacto;
 *  - ISOLAMENTO: tenant_id entra no WHERE/escopo quando fornecido;
 *  - validação de input (sessões fora de faixa, validade dupla, datas malformadas);
 *  - fail-safe: erro de DB -> ROLLBACK + reason 'erro', sem lançar.
 *
 * `../client.js` é MOCKADO (pool.connect()/query), igual aos testes de dedução.
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

const { recargaCredit, mudarVencimento, cancelarCredito, reativarCredito } = await import(
  './packages.js'
);

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  mockRelease.mockReset();
  mockConnect.mockReset().mockResolvedValue({
    query: (...a: unknown[]) => mockClientQuery(...a),
    release: (...a: unknown[]) => mockRelease(...a),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('recargaCredit — renovação no MESMO crédito', () => {
  /**
   * Programa a transação de recarga. `creditExists` = SELECT FOR UPDATE acha o crédito.
   * `insertRowCount` = rowCount do INSERT redemption (1 = aplicou; 0 = idempotente/já aplicada).
   * `rebuildSaldo` = saldo devolvido pelo rebuild. `snapshot` = total/validade/status pós-update.
   */
  function programRecarga(opts: {
    creditExists?: boolean;
    insertRowCount?: number;
    rebuildSaldo?: number;
    snapshot?: { sessoes_total?: number; data_expiracao?: string; status?: string };
  }) {
    const creditExists = opts.creditExists ?? true;
    const insertRowCount = opts.insertRowCount ?? 1;
    const rebuildSaldo = opts.rebuildSaldo ?? 7;
    const snap = {
      sessoes_total: opts.snapshot?.sessoes_total ?? 9,
      data_expiracao: opts.snapshot?.data_expiracao ?? '2027-01-31',
      status: opts.snapshot?.status ?? 'active',
    };
    mockClientQuery.mockReset();
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM client_package_credits[\s\S]*FOR UPDATE/.test(sql))
        return {
          rows: creditExists ? [{ id: '1', slot: 's', tenant_id: 't' }] : [],
          rowCount: creditExists ? 1 : 0,
        };
      if (/INSERT INTO package_redemptions/.test(sql))
        return { rows: [], rowCount: insertRowCount };
      if (/UPDATE client_package_credits c/.test(sql))
        return { rows: [{ saldo: rebuildSaldo }], rowCount: 1 };
      if (/UPDATE client_package_credits SET/.test(sql)) return { rows: [], rowCount: 1 };
      if (/SELECT sessoes_total/.test(sql)) return { rows: [snap], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  }

  it('soma sessões: INSERT(+N, recharge) idempotente + cresce sessoes_total + recomputa saldo', async () => {
    programRecarga({ insertRowCount: 1, rebuildSaldo: 7, snapshot: { sessoes_total: 9 } });
    const r = await recargaCredit({ slot: 's', creditId: 1, sessoes: 5, idempotencyKey: 'k1' });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('recharged');
    expect(r.sessoes_restantes).toBe(7);
    expect(r.sessoes_total).toBe(9);

    const ins = mockClientQuery.mock.calls.find((c) =>
      /INSERT INTO package_redemptions/.test(String(c[0])),
    );
    const sql = String(ins?.[0]);
    expect(sql).toContain("'recharge'");
    expect(sql).toContain('ON CONFLICT (gcal_event_id, reason) DO NOTHING');
    // chave sintética = 'recharge:<creditId>:<idempotencyKey>'
    expect(ins?.[1]?.[1]).toBe('recharge:1:k1');
    expect(ins?.[1]?.[3]).toBe(5); // delta = +sessoes
    // cresce sessoes_total
    const upd = mockClientQuery.mock.calls.find((c) =>
      /UPDATE client_package_credits SET sessoes_total = sessoes_total \+/.test(String(c[0])),
    );
    expect(upd).toBeDefined();
    expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('REATIVA status: rebuild leva exhausted -> active (saldo voltou a >0)', async () => {
    programRecarga({ insertRowCount: 1, rebuildSaldo: 5, snapshot: { status: 'active' } });
    const r = await recargaCredit({ slot: 's', creditId: 1, sessoes: 5, idempotencyKey: 'k2' });
    expect(r.status).toBe('active'); // snapshot pós-rebuild
    // o rebuild (UPDATE client_package_credits c) re-deriva status do ledger
    const rebuild = mockClientQuery.mock.calls.find((c) =>
      /UPDATE client_package_credits c[\s\S]*status = CASE/.test(String(c[0])),
    );
    expect(rebuild).toBeDefined();
  });

  it('IDEMPOTÊNCIA: mesma idempotencyKey (INSERT 0 linhas) NÃO soma de novo nem mexe na validade', async () => {
    programRecarga({ insertRowCount: 0, rebuildSaldo: 2, snapshot: { sessoes_total: 4 } });
    const r = await recargaCredit({
      slot: 's',
      creditId: 1,
      sessoes: 5,
      idempotencyKey: 'dup',
      novaValidade: { adicionarDias: 30 },
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('already_applied');
    expect(r.sessoes_total).toBe(4); // NÃO cresceu
    // NÃO houve o UPDATE de sessoes_total (a 1ª chamada já fez tudo).
    const grew = mockClientQuery.mock.calls.find((c) =>
      /UPDATE client_package_credits SET sessoes_total = sessoes_total \+/.test(String(c[0])),
    );
    expect(grew).toBeUndefined();
    expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('nova validade por DIAS: UPDATE usa CURRENT_DATE + N (sem fuso do Node)', async () => {
    programRecarga({ insertRowCount: 1 });
    await recargaCredit({
      slot: 's',
      creditId: 1,
      sessoes: 3,
      idempotencyKey: 'k3',
      novaValidade: { adicionarDias: 60 },
    });
    const upd = mockClientQuery.mock.calls.find((c) =>
      /UPDATE client_package_credits SET sessoes_total/.test(String(c[0])),
    );
    expect(String(upd?.[0])).toContain('CURRENT_DATE + ($3::int)');
    expect(upd?.[1]).toContain(60);
  });

  it('nova validade por DATA fixa: UPDATE usa $N::date', async () => {
    programRecarga({ insertRowCount: 1 });
    await recargaCredit({
      slot: 's',
      creditId: 1,
      sessoes: 3,
      idempotencyKey: 'k4',
      novaValidade: { dataExpiracao: '2027-12-31' },
    });
    const upd = mockClientQuery.mock.calls.find((c) =>
      /UPDATE client_package_credits SET sessoes_total/.test(String(c[0])),
    );
    expect(String(upd?.[0])).toContain('::date');
    expect(upd?.[1]).toContain('2027-12-31');
  });

  it('ISOLAMENTO: tenant_id entra no escopo do SELECT FOR UPDATE quando fornecido', async () => {
    programRecarga({ insertRowCount: 1 });
    await recargaCredit({
      slot: 's',
      tenantId: 't-uuid',
      creditId: 1,
      sessoes: 1,
      idempotencyKey: 'k5',
    });
    const sel = mockClientQuery.mock.calls.find((c) =>
      /FROM client_package_credits[\s\S]*FOR UPDATE/.test(String(c[0])),
    );
    expect(String(sel?.[0])).toContain('tenant_id = $3');
    expect(sel?.[1]).toEqual([1, 's', 't-uuid']);
  });

  it('crédito de outro clone (SELECT 0 linhas) → not_found, sem escrever', async () => {
    programRecarga({ creditExists: false });
    const r = await recargaCredit({ slot: 's', creditId: 999, sessoes: 1, idempotencyKey: 'k6' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_found');
    const ins = mockClientQuery.mock.calls.find((c) =>
      /INSERT INTO package_redemptions/.test(String(c[0])),
    );
    expect(ins).toBeUndefined();
  });

  it('valida sessões: 0 / negativo / acima de 1000 → invalid (não abre conexão)', async () => {
    for (const s of [0, -1, 1001, 1.5]) {
      const r = await recargaCredit({ slot: 's', creditId: 1, sessoes: s, idempotencyKey: 'k' });
      expect(r.reason).toBe('invalid');
    }
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('valida validade: data E dias juntos → invalid', async () => {
    const r = await recargaCredit({
      slot: 's',
      creditId: 1,
      sessoes: 1,
      idempotencyKey: 'k',
      novaValidade: { dataExpiracao: '2027-01-01', adicionarDias: 30 },
    });
    expect(r.reason).toBe('invalid');
  });

  it('valida validade: data malformada → invalid', async () => {
    const r = await recargaCredit({
      slot: 's',
      creditId: 1,
      sessoes: 1,
      idempotencyKey: 'k',
      novaValidade: { dataExpiracao: '31/12/2027' },
    });
    expect(r.reason).toBe('invalid');
  });

  it('idempotencyKey ausente → invalid', async () => {
    const r = await recargaCredit({
      slot: 's',
      creditId: 1,
      sessoes: 1,
      idempotencyKey: '',
    });
    expect(r.reason).toBe('invalid');
  });

  it('fail-safe: erro de DB → ROLLBACK + reason erro, não lança', async () => {
    mockClientQuery.mockReset().mockImplementation(async (sql: string) => {
      if (/^\s*BEGIN/i.test(sql)) return { rows: [] };
      if (/FROM client_package_credits[\s\S]*FOR UPDATE/.test(sql)) throw new Error('pg down');
      return { rows: [] };
    });
    const r = await recargaCredit({ slot: 's', creditId: 1, sessoes: 1, idempotencyKey: 'k' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('erro');
    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('mudarVencimento — sem tocar o ledger', () => {
  function programMudar(opts: { updRowCount?: number; status?: string; saldo?: number }) {
    const updRowCount = opts.updRowCount ?? 1;
    mockClientQuery.mockReset();
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/UPDATE client_package_credits[\s\S]*SET data_expiracao/.test(sql))
        return { rows: updRowCount ? [{ id: '1' }] : [], rowCount: updRowCount };
      if (/UPDATE client_package_credits c/.test(sql))
        return { rows: [{ saldo: opts.saldo ?? 3 }], rowCount: 1 };
      if (/SELECT sessoes_total/.test(sql))
        return {
          rows: [
            { sessoes_total: 5, data_expiracao: '2028-01-01', status: opts.status ?? 'active' },
          ],
          rowCount: 1,
        };
      return { rows: [], rowCount: 0 };
    });
  }

  it('por DATA fixa: UPDATE data_expiracao = $N::date, NÃO insere no ledger', async () => {
    programMudar({ updRowCount: 1 });
    const r = await mudarVencimento({ slot: 's', creditId: 1, dataExpiracao: '2028-01-01' });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('updated');
    expect(r.data_expiracao).toBe('2028-01-01');
    const ins = mockClientQuery.mock.calls.find((c) =>
      /INSERT INTO package_redemptions/.test(String(c[0])),
    );
    expect(ins).toBeUndefined(); // ledger intocado
  });

  it('por DIAS: UPDATE usa CURRENT_DATE + N', async () => {
    programMudar({ updRowCount: 1 });
    await mudarVencimento({ slot: 's', creditId: 1, adicionarDias: 45 });
    const upd = mockClientQuery.mock.calls.find((c) =>
      /SET data_expiracao = CURRENT_DATE/.test(String(c[0])),
    );
    expect(upd).toBeDefined();
  });

  it('data E dias juntos OU nenhum → invalid (precisa de exatamente um)', async () => {
    expect((await mudarVencimento({ slot: 's', creditId: 1 })).reason).toBe('invalid');
    expect(
      (
        await mudarVencimento({
          slot: 's',
          creditId: 1,
          dataExpiracao: '2028-01-01',
          adicionarDias: 30,
        })
      ).reason,
    ).toBe('invalid');
  });

  it('crédito de outro clone (0 linhas) → not_found', async () => {
    programMudar({ updRowCount: 0 });
    const r = await mudarVencimento({ slot: 's', creditId: 999, dataExpiracao: '2028-01-01' });
    expect(r.reason).toBe('not_found');
  });

  it('ISOLAMENTO: tenant_id no WHERE do UPDATE quando fornecido', async () => {
    programMudar({ updRowCount: 1 });
    await mudarVencimento({ slot: 's', tenantId: 't', creditId: 1, dataExpiracao: '2028-01-01' });
    const upd = mockClientQuery.mock.calls.find((c) =>
      /UPDATE client_package_credits[\s\S]*SET data_expiracao/.test(String(c[0])),
    );
    expect(String(upd?.[0])).toContain('tenant_id = $3');
    // params: [creditId, slot, tenantId, validade]
    expect(upd?.[1]).toEqual([1, 's', 't', '2028-01-01']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('cancelarCredito — status cancelled, ledger intacto', () => {
  function programCancelar(updRowCount: number) {
    mockClientQuery.mockReset();
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/UPDATE client_package_credits[\s\S]*status = 'cancelled'/.test(sql))
        return { rows: updRowCount ? [{ status: 'cancelled' }] : [], rowCount: updRowCount };
      return { rows: [], rowCount: 0 };
    });
  }

  it('marca cancelled, NÃO insere no ledger', async () => {
    programCancelar(1);
    const r = await cancelarCredito({ slot: 's', creditId: 1, actor: 'ops' });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('cancelled');
    expect(r.status).toBe('cancelled');
    const ins = mockClientQuery.mock.calls.find((c) =>
      /INSERT INTO package_redemptions/.test(String(c[0])),
    );
    expect(ins).toBeUndefined();
  });

  it('crédito de outro clone (0 linhas) → not_found', async () => {
    programCancelar(0);
    const r = await cancelarCredito({ slot: 's', creditId: 999 });
    expect(r.reason).toBe('not_found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('reativarCredito — limpa cancelled e recarrega', () => {
  it('limpa status cancelled (UPDATE ... WHERE status = cancelled) antes da recarga', async () => {
    // 1ª query (fora da tx de recarga) = limpar cancelled; depois a recarga roda sua própria tx.
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });
    mockClientQuery.mockReset();
    mockClientQuery.mockImplementation(async (sql: string) => {
      // pré-passo: UPDATE ... status = 'active' ... AND status = 'cancelled'
      if (/UPDATE client_package_credits[\s\S]*status = 'cancelled'/.test(sql))
        return { rows: [], rowCount: 1 };
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM client_package_credits[\s\S]*FOR UPDATE/.test(sql))
        return { rows: [{ id: '1', slot: 's', tenant_id: 't' }], rowCount: 1 };
      if (/INSERT INTO package_redemptions/.test(sql)) return { rows: [], rowCount: 1 };
      if (/UPDATE client_package_credits SET sessoes_total/.test(sql))
        return { rows: [], rowCount: 1 };
      if (/UPDATE client_package_credits c/.test(sql)) return { rows: [{ saldo: 5 }], rowCount: 1 };
      if (/SELECT sessoes_total/.test(sql))
        return {
          rows: [{ sessoes_total: 5, data_expiracao: '2027-01-01', status: 'active' }],
          rowCount: 1,
        };
      return { rows: [], rowCount: 0 };
    });
    const r = await reativarCredito({
      slot: 's',
      creditId: 1,
      sessoes: 5,
      idempotencyKey: 'react-1',
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('recharged');
    const clear = mockClientQuery.mock.calls.find((c) => /status = 'cancelled'/.test(String(c[0])));
    expect(clear).toBeDefined();
  });
});
