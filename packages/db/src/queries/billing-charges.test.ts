/**
 * Testes das queries de billing_charges (ADR 0013 / ADR 0014).
 *
 * O `query` e o `pool.connect()` de ../client.js sao MOCKADOS — nao tocam banco.
 *
 * Cobre:
 *  - reissueGatewayData: sobrescreve a MESMA linha (slot, cycle), volta status='pending'
 *    e EXCLUI cobranca paga (WHERE status <> 'paid') — invariante C2.
 *  - ADR 0014: withBillingSlotLock + getActivePendingCharge (recheck) — a proteca que
 *    SUBSTITUIU o UNIQUE(slot,cycle): "no maximo 1 pending valida por slot" e transacional
 *    (advisory lock por slot + recheck), nao mais de banco. Inclui simulacao de DUAS
 *    geracoes concorrentes no mesmo slot: a 2a ve a pending da 1a e reusa (1 pending so).
 */
import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, connectMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  connectMock: vi.fn(),
}));

vi.mock('../client.js', () => ({
  query: queryMock,
  pool: { connect: connectMock },
}));

import {
  BillingSlotBusyError,
  claimGatewayCall,
  GATEWAY_CALL_AMBIGUOUS_TIMEOUT_MS,
  getActivePendingCharge,
  getResumableChargeForSlot,
  insertPendingCharge,
  reissueGatewayData,
  withBillingSlotLock,
} from './billing-charges.js';

beforeEach(() => {
  queryMock.mockReset();
  connectMock.mockReset();
});

const reissueInput = {
  slot: 'clone_x',
  cycle: '2026-06',
  abacateChargeId: 'pix_char_novo',
  brCode: '00020-novo',
  brCodeBase64: 'data:image/png;base64,NEW==',
  expiresAt: new Date('2026-06-14T10:00:00.000Z'),
};

describe('reissueGatewayData', () => {
  it('atualiza a MESMA linha (slot, cycle), volta status=pending e exclui paga no WHERE', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: '1', slot: 'clone_x', cycle: '2026-06', status: 'pending' }],
      rowCount: 1,
    });

    const row = await reissueGatewayData(reissueInput);

    expect(row).toMatchObject({ slot: 'clone_x', cycle: '2026-06', status: 'pending' });
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    const flat = sql.replace(/\s+/g, ' ');
    // Atualiza por (slot, cycle) — escopo multi-tenant; nunca por id de input.
    expect(flat).toContain('WHERE slot = $1 AND cycle = $2');
    // Invariante C2: nao reescreve cobranca paga.
    expect(flat).toContain("status <> 'paid'");
    // Reseta status pra pending (a linha podia estar 'expired').
    expect(flat).toContain("status = 'pending'");
    // Parametrizada: dados do gateway entram como $3..$6, nunca concatenados.
    expect(params).toEqual([
      'clone_x',
      '2026-06',
      'pix_char_novo',
      '00020-novo',
      'data:image/png;base64,NEW==',
      reissueInput.expiresAt,
    ]);
  });

  it('retorna null quando nada foi reescrito (linha inexistente ou ja paga)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const row = await reissueGatewayData(reissueInput);
    expect(row).toBeNull();
  });

  // SCRUM-141: o abacate_charge_id ANTIGO precisa ir pra superseded_charge_ids (append
  // idempotente) — o QR velho segue pagavel e a reconciliacao do cron F4 polla por ele.
  it('preserva o abacate_charge_id antigo em superseded_charge_ids (append idempotente)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: '1', status: 'pending' }], rowCount: 1 });
    await reissueGatewayData(reissueInput);
    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    const flat = sql.replace(/\s+/g, ' ');
    // Faz APPEND do id antigo (RHS = valor antigo da linha; $3 = novo id).
    expect(flat).toContain('array_append(COALESCE(superseded_charge_ids');
    // Idempotente: nao duplica se o id antigo ja estiver no array; ignora NULL/igual.
    expect(flat).toContain('abacate_charge_id IS NOT NULL');
    expect(flat).toContain('abacate_charge_id <> $3');
    expect(flat).toContain('NOT (abacate_charge_id = ANY (COALESCE(superseded_charge_ids');
    // COLUMNS retornado inclui a coluna nova.
    expect(flat).toContain("COALESCE(superseded_charge_ids, '{}') AS superseded_charge_ids");
  });
});

// ── ADR 0014: invariante "1 pending por slot" via advisory lock + recheck ───────
// A protecao que SUBSTITUIU o UNIQUE(slot,cycle) (removido na migration 043). A
// unicidade nao e mais de banco: e transacional (pg_advisory_xact_lock por slot +
// recheck de getActivePendingCharge sob o lock). Estes testes exercitam as funcoes
// REAIS contra um client fake roteado por substring da SQL.

interface LockScenario {
  /** linha devolvida por getActivePendingCharge no recheck (null = nao ha pending valida). */
  activePending: { id: string; slot: string; cycle: string; status: string } | null;
  /** linha devolvida pelo INSERT de insertPendingCharge (so quando nao ha pending). */
  inserted?: { id: string; slot: string; cycle: string; status: string };
}

/** Calls capturadas no fake client (ordem/PADRAO da SQL). */
const lockCalls: { sql: string; params: unknown[] }[] = [];

function makeLockClient(s: LockScenario) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      lockCalls.push({ sql, params: params ?? [] });
      const q = sql.replace(/\s+/g, ' ');
      if (q.includes('BEGIN') || q.includes('COMMIT') || q.includes('ROLLBACK')) {
        return { rows: [], rowCount: 0 };
      }
      if (q.includes('pg_try_advisory_xact_lock')) {
        return { rows: [{ locked: true }], rowCount: 1 };
      }
      // recheck: SELECT ... WHERE status = 'pending' ... ORDER BY id DESC
      if (q.includes('FROM billing_charges') && q.includes("status = 'pending'")) {
        return s.activePending
          ? { rows: [s.activePending], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      // insertPendingCharge: INSERT ... RETURNING
      if (q.includes('INSERT INTO billing_charges')) {
        return { rows: [s.inserted ?? null], rowCount: s.inserted ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
}

function sqls(): string[] {
  return lockCalls.map((c) => c.sql.replace(/\s+/g, ' ').trim());
}

// ── SCRUM-173/ADR 0039 F1: leitura de PRODUTO vs leitura de GERACAO ──────────────
// getActivePendingCharge (produto/portal) exige br_code IS NOT NULL; getResumableChargeForSlot
// (geracao) NAO exige — reaproveita ate linha orfa presa em gateway_call_state='calling'.
describe('F1 — getActivePendingCharge (produto) vs getResumableChargeForSlot (geracao)', () => {
  it('getActivePendingCharge (leitura de PRODUTO) filtra br_code IS NOT NULL — linha travada em calling NUNCA aparece pro portal', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await getActivePendingCharge('clone_x', new Date('2026-06-09T00:00:00Z'));
    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat).toContain("status = 'pending'");
    expect(flat).toContain('br_code IS NOT NULL');
  });

  it('getResumableChargeForSlot (leitura de GERACAO) NAO filtra br_code — reaproveita linha orfa em vez de duplicar', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await getResumableChargeForSlot('clone_x', new Date('2026-06-09T00:00:00Z'));
    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat).toContain("status = 'pending'");
    expect(flat).not.toContain('br_code IS NOT NULL');
  });
});

// ── SCRUM-173/ADR 0039 F2 (+ P2 do QA) — claim atomico com relogio do BANCO ──────
describe('claimGatewayCall — UPDATE condicional atomico (F2), relogio do banco (P2)', () => {
  it('UPDATE de UMA UNICA statement: WHERE checa status<>paid + (nao-calling OU sem timestamp OU expirado) usando NOW() do banco', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: '1', gateway_call_state: 'calling' }],
      rowCount: 1,
    });

    const row = await claimGatewayCall({ query: queryMock } as unknown as PoolClient, '1');

    expect(row).toMatchObject({ id: '1' });
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    const flat = sql.replace(/\s+/g, ' ');
    // Clausula obrigatoria 1 (arquiteto): nunca rechama gateway pra cobranca ja paga.
    expect(flat).toContain("status <> 'paid'");
    // Clausula obrigatoria 2 (arquiteto): sem timestamp NUNCA trava pra sempre.
    expect(flat).toContain('gateway_call_started_at IS NULL');
    expect(flat).toContain("gateway_call_state <> 'calling'");
    // Relogio do BANCO (P2 do QA) — NOW() dentro do SQL, nao Date do processo Node.
    expect(flat).toContain('gateway_call_started_at < NOW() - ($2::int * INTERVAL');
    expect(flat).toContain('gateway_call_started_at = NOW()');
    // O timeout de ambiguidade e PARAMETRO (fonte unica GATEWAY_CALL_AMBIGUOUS_TIMEOUT_MS).
    expect(params).toEqual(['1', GATEWAY_CALL_AMBIGUOUS_TIMEOUT_MS]);
  });

  it('0 linhas afetadas (claim perdido) -> retorna null, SEM lancar', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const row = await claimGatewayCall({ query: queryMock } as unknown as PoolClient, '1');
    expect(row).toBeNull();
  });

  it('aceita ambiguousTimeoutMs customizado como parametro (fonte unica testavel)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: '1' }], rowCount: 1 });
    await claimGatewayCall({ query: queryMock } as unknown as PoolClient, '1', 60_000);
    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['1', 60_000]);
  });
});

describe('withBillingSlotLock — transacao + advisory lock por slot (ADR 0014)', () => {
  beforeEach(() => {
    lockCalls.length = 0;
  });

  it('abre BEGIN, adquire pg_try_advisory_xact_lock por slot e COMMITa ao final', async () => {
    const client = makeLockClient({ activePending: null });
    connectMock.mockResolvedValueOnce(client);

    const out = await withBillingSlotLock('clone_x', async () => 'ok');

    expect(out).toBe('ok');
    const ran = sqls();
    expect(ran.some((q) => q.includes('BEGIN'))).toBe(true);
    expect(ran.some((q) => q.includes('COMMIT'))).toBe(true);
    // O lock e chaveado por slot (hashtext('billing:'||slot)), parametrizado ($1=slot).
    const lockCall = lockCalls.find((c) => c.sql.includes('pg_try_advisory_xact_lock'));
    expect(lockCall).toBeDefined();
    expect(lockCall?.sql).toContain("hashtext('billing:' || $1)");
    expect(lockCall?.params).toEqual(['clone_x']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('ROLLBACK + release se o callback lanca (lock liberado, nada commitado)', async () => {
    const client = makeLockClient({ activePending: null });
    connectMock.mockResolvedValueOnce(client);

    await expect(
      withBillingSlotLock('clone_x', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const ran = sqls();
    expect(ran.some((q) => q.includes('ROLLBACK'))).toBe(true);
    expect(ran.some((q) => q.includes('COMMIT'))).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('lock ocupado falha rapido sem executar callback', async () => {
    const client = makeLockClient({ activePending: null });
    client.query.mockImplementation(async (sql: string) => {
      lockCalls.push({ sql, params: [] });
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return { rows: [{ locked: false }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    connectMock.mockResolvedValueOnce(client);
    const fn = vi.fn();

    await expect(withBillingSlotLock('clone_x', fn)).rejects.toBeInstanceOf(BillingSlotBusyError);

    expect(fn).not.toHaveBeenCalled();
    expect(sqls()).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('rollback falho descarta a conexao com release(true)', async () => {
    const client = makeLockClient({ activePending: null });
    client.query.mockImplementation(async (sql: string) => {
      lockCalls.push({ sql, params: [] });
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return { rows: [{ locked: true }], rowCount: 1 };
      }
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      return { rows: [], rowCount: 0 };
    });
    connectMock.mockResolvedValueOnce(client);

    await expect(
      withBillingSlotLock('clone_x', async () => {
        throw new Error('gateway failed');
      }),
    ).rejects.toThrow('gateway failed');

    expect(client.release).toHaveBeenCalledWith(true);
  });
});

describe('invariante 1-pending/slot: recheck sob o lock (ADR 0014)', () => {
  beforeEach(() => {
    lockCalls.length = 0;
  });

  it('(a) JA HA pending valida sob o lock -> reusa, NAO chama insertPendingCharge', async () => {
    const existing = { id: '7', slot: 'clone_x', cycle: '2026-06-10', status: 'pending' };
    const client = makeLockClient({ activePending: existing });
    connectMock.mockResolvedValueOnce(client);

    // Simula o caminho de geracao: dentro do lock, recheck; se ha pending, reusa.
    const result = await withBillingSlotLock('clone_x', async (c: PoolClient) => {
      const active = await getActivePendingCharge('clone_x', new Date('2026-06-09T00:00:00Z'), c);
      if (active) return { reused: active, created: null as null };
      // (nao deve chegar aqui neste cenario)
      const row = await insertPendingCharge(c, {
        slot: 'clone_x',
        cycle: '2026-06-10',
        externalId: 'clone_x-2026-06-10',
        amountCents: 19900,
      });
      return { reused: null, created: row };
    });

    expect(result.reused).toMatchObject({ id: '7', status: 'pending' });
    expect(result.created).toBeNull();
    // Nenhum INSERT — reusou a pending existente (idempotencia sob o lock).
    expect(sqls().some((q) => q.includes('INSERT INTO billing_charges'))).toBe(false);
    // O recheck rodou DENTRO da transacao do lock (mesmo client), nunca via `query` global.
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('(b) duas geracoes CONCORRENTES no mesmo slot -> resulta em 1 pending (2a reusa)', async () => {
    // Modela a serializacao do advisory lock: a 1a geracao roda primeiro (nao ha pending,
    // insere); a 2a roda DEPOIS (o lock so libera no COMMIT da 1a) e, no recheck, ja VE a
    // pending da 1a e reusa. Sem inserir uma 2a cobranca.
    const newRow = { id: '10', slot: 'clone_x', cycle: '2026-06-10', status: 'pending' };

    // 1a geracao: recheck nao acha pending -> insere a linha nova.
    const client1 = makeLockClient({ activePending: null, inserted: newRow });
    // 2a geracao: recheck JA acha a pending criada pela 1a -> reusa.
    const client2 = makeLockClient({ activePending: newRow });
    connectMock.mockResolvedValueOnce(client1).mockResolvedValueOnce(client2);

    async function generateOnce(): Promise<{ created: boolean; id: string }> {
      return withBillingSlotLock('clone_x', async (c: PoolClient) => {
        const active = await getActivePendingCharge('clone_x', new Date('2026-06-09T00:00:00Z'), c);
        if (active) return { created: false, id: active.id };
        const row = await insertPendingCharge(c, {
          slot: 'clone_x',
          cycle: '2026-06-10',
          externalId: 'clone_x-2026-06-10',
          amountCents: 19900,
        });
        return { created: true, id: row.id };
      });
    }

    // Execucao serializada pelo lock (1a depois 2a) — o que o advisory lock garante na pratica.
    const r1 = await generateOnce();
    const r2 = await generateOnce();

    // A 1a criou; a 2a reusou a MESMA linha (mesmo id) — 1 pending por slot.
    expect(r1).toEqual({ created: true, id: '10' });
    expect(r2).toEqual({ created: false, id: '10' });
    // Exatamente UM INSERT no total (somando os dois clients): a 2a nao inseriu.
    const inserts = [...client1.query.mock.calls, ...client2.query.mock.calls].filter(([sql]) =>
      String(sql).replace(/\s+/g, ' ').includes('INSERT INTO billing_charges'),
    );
    expect(inserts).toHaveLength(1);
  });
});
