/**
 * Testes do READ CUTOVER do tenant_id (ADR 0018, Fase 2b) — rollup por cliente.
 *
 * `../client.js` é MOCKADO — não toca banco. Cobre:
 *  - flag OFF (default): clientRollup junta por `slot` (SQL atual, sem tenant_id).
 *  - flag ON:            clientRollup junta por `tenant_id` (SQL do cutover).
 *  - PARIDADE: rollupBySlot e rollupByTenant devolvem os MESMOS números pros
 *    clientes atuais (Cirilo pagante + Edu trial) -> compareRollupParity().identical.
 *  - MISMATCH: divergência num cliente é detectada (rede de segurança do QA).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock('../client.js', () => ({
  query: queryMock,
  pool: {},
}));

import { clientRollup, compareRollupParity } from './tenant-read-rollup.js';

beforeEach(() => {
  queryMock.mockReset();
});

// Linhas cruas como o pg devolve (numéricos agregados vêm como string via ::text).
const cirilo = {
  slot: 'clone_cirilobarbearia_c8w2f0',
  tenant_id: '11111111-1111-1111-1111-111111111111',
  amount_cents: 8500,
  next_due_date: '2026-06-27',
  calls: '120',
  total_tokens: '45000',
  cost_usd: '0.42',
};
const edu = {
  slot: 'clone_edu_barbeiro_glh7vd',
  tenant_id: '22222222-2222-2222-2222-222222222222',
  amount_cents: 9999,
  next_due_date: '2026-06-20',
  calls: '30',
  total_tokens: '8000',
  cost_usd: '0.08',
};

describe('clientRollup (flag TENANT_READ_CUTOVER)', () => {
  it('flag OFF (default): junta por slot, SQL atual, sem expor tenant_id na junção', async () => {
    queryMock.mockResolvedValueOnce({ rows: [cirilo, edu], rowCount: 2 });

    const res = await clientRollup(30, {} as NodeJS.ProcessEnv);

    expect(res.mode).toBe('slot');
    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    const norm = sql.replace(/\s+/g, ' ');
    expect(norm).toContain('LEFT JOIN client_billing cb ON cb.slot = fc.slot');
    expect(norm).toContain('u ON u.slot = fc.slot');
    expect(norm).not.toContain('u.tenant_id = fc.tenant_id');
    expect(res.rows[0].calls).toBe(120);
  });

  it('flag ON: junta por tenant_id (UUID), não por string slot', async () => {
    queryMock.mockResolvedValueOnce({ rows: [cirilo, edu], rowCount: 2 });

    const res = await clientRollup(30, { TENANT_READ_CUTOVER: 'true' } as NodeJS.ProcessEnv);

    expect(res.mode).toBe('tenant_id');
    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    const norm = sql.replace(/\s+/g, ' ');
    expect(norm).toContain('cb.tenant_id = fc.tenant_id');
    expect(norm).toContain('u ON u.tenant_id = fc.tenant_id');
    expect(norm).toContain('tenant_id IS NOT NULL');
    expect(res.rows[0].tenant_id).toBe(cirilo.tenant_id);
  });

  it('valor != "true" mantém OFF (safe-by-default)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await clientRollup(7, { TENANT_READ_CUTOVER: '1' } as NodeJS.ProcessEnv);
    expect(res.mode).toBe('slot');
  });
});

describe('compareRollupParity — QA valida ANTES de ligar a flag', () => {
  it('paridade perfeita: slot e tenant_id batem para Cirilo + Edu -> identical=true', async () => {
    // 1ª chamada = rollupBySlot; 2ª = rollupByTenant (Promise.all preserva ordem dos args).
    queryMock.mockResolvedValueOnce({ rows: [cirilo, edu], rowCount: 2 }); // slot
    queryMock.mockResolvedValueOnce({ rows: [cirilo, edu], rowCount: 2 }); // tenant

    const report = await compareRollupParity(30);

    expect(report.identical).toBe(true);
    expect(report.slotCount).toBe(2);
    expect(report.tenantCount).toBe(2);
    expect(report.mismatches).toEqual([]);
  });

  it('cost_usd com ruído de float < 1e-9 ainda é paridade', async () => {
    const ciriloTenant = { ...cirilo, cost_usd: '0.4200000001' };
    queryMock.mockResolvedValueOnce({ rows: [cirilo], rowCount: 1 });
    queryMock.mockResolvedValueOnce({ rows: [ciriloTenant], rowCount: 1 });

    const report = await compareRollupParity(30);

    expect(report.identical).toBe(true);
  });

  it('divergência num cliente é detectada (rede de segurança): identical=false + diff', async () => {
    const ciriloBug = { ...cirilo, total_tokens: '99999' }; // tenant_id soma errado
    queryMock.mockResolvedValueOnce({ rows: [cirilo, edu], rowCount: 2 }); // slot
    queryMock.mockResolvedValueOnce({ rows: [ciriloBug, edu], rowCount: 2 }); // tenant

    const report = await compareRollupParity(30);

    expect(report.identical).toBe(false);
    expect(report.mismatches).toHaveLength(1);
    const m = report.mismatches[0];
    expect(m.slot).toBe(cirilo.slot);
    expect(m.presence).toBe('both');
    expect(m.diffs.map((d) => d.field)).toContain('total_tokens');
  });

  it('cliente presente só num caminho é mismatch de conjunto', async () => {
    queryMock.mockResolvedValueOnce({ rows: [cirilo, edu], rowCount: 2 }); // slot tem Edu
    queryMock.mockResolvedValueOnce({ rows: [cirilo], rowCount: 1 }); // tenant não tem Edu

    const report = await compareRollupParity(30);

    expect(report.identical).toBe(false);
    const eduDiff = report.mismatches.find((m) => m.slot === edu.slot);
    expect(eduDiff?.presence).toBe('only_slot');
  });

  it('amount_cents/next_due_date NULL (sem billing) batem nos dois lados', async () => {
    const semBilling: typeof cirilo = {
      ...cirilo,
      amount_cents: null as unknown as number,
      next_due_date: null as unknown as string,
    };
    queryMock.mockResolvedValueOnce({ rows: [semBilling], rowCount: 1 });
    queryMock.mockResolvedValueOnce({ rows: [semBilling], rowCount: 1 });

    const report = await compareRollupParity(30);

    expect(report.identical).toBe(true);
  });
});
