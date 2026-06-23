/**
 * Testes da data layer de colaboradores — FOCO no comissao_pct (app de gestão,
 * cenário EMPRESA, ADR 0026):
 *  - READ: NUMERIC do pg chega como string -> a API entrega number (mapColaboradorRow).
 *  - CREATE: comissao_pct ausente -> 0 (default da coluna); presente -> vai no INSERT.
 *  - UPDATE parcial: SEM comissao_pct -> o SET nem menciona a coluna (não zera ninguém);
 *    COM comissao_pct -> entra no SET; valor sai saneado (clamp 0–100, 2 casas).
 *
 * `../client.js` é MOCKADO (pool.connect()/query), mesmo padrão de packages-lifecycle.test.ts.
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

const { create, update, listBySlot } = await import('./clone-colaboradores.js');

// Linha CRUA como o pg devolve: NUMERIC vira string ('15.50'), não number.
const RAW_ROW = {
  id: 1,
  nome: 'Ana',
  gcal_calendar_id: null,
  gcal_status: 'pending',
  servicos: ['Corte'],
  ativo: true,
  ordem: 0,
  comissao_pct: '15.50',
  created_at: '2026-06-23T00:00:00Z',
  updated_at: '2026-06-23T00:00:00Z',
};

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  mockRelease.mockReset();
  mockConnect.mockReset().mockResolvedValue({
    query: (...a: unknown[]) => mockClientQuery(...a),
    release: (...a: unknown[]) => mockRelease(...a),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('listBySlot — comissao_pct vem como number', () => {
  it('converte a string NUMERIC do pg pra number no JSON', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [RAW_ROW], rowCount: 1 });
    const [row] = await listBySlot('clone_x');
    expect(row.comissao_pct).toBe(15.5);
    expect(typeof row.comissao_pct).toBe('number');
    // SELECT escopado por slot.
    expect(mockQuery.mock.calls[0][1]).toEqual(['clone_x']);
    expect(String(mockQuery.mock.calls[0][0])).toContain('comissao_pct');
  });

  it('NULL/indefinido -> 0 (fallback seguro)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...RAW_ROW, comissao_pct: null }], rowCount: 1 });
    const [row] = await listBySlot('clone_x');
    expect(row.comissao_pct).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('create — comissao_pct', () => {
  /** Programa a transação de create: BEGIN/COMMIT ok; INSERT devolve a linha crua dada. */
  function programCreate(insRow: Record<string, unknown>) {
    mockClientQuery.mockReset().mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO clone_colaboradores/i.test(sql)) return { rows: [insRow], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  }

  it('ausente -> grava 0 e devolve number', async () => {
    programCreate({ ...RAW_ROW, comissao_pct: '0' });
    const row = await create({ slot: 'clone_x', tenantId: 'tid-1', nome: 'Ana' }, null);
    const ins = mockClientQuery.mock.calls.find((c) =>
      /INSERT INTO clone_colaboradores/i.test(String(c[0])),
    );
    expect(ins?.[1]?.[6]).toBe(0); // 7º bind = comissao_pct
    expect(row.comissao_pct).toBe(0);
  });

  it('presente -> vai saneado pro INSERT (clamp + 2 casas) e volta number', async () => {
    programCreate({ ...RAW_ROW, comissao_pct: '30.00' });
    await create({ slot: 'clone_x', tenantId: 'tid-1', nome: 'Ana', comissao_pct: 30 }, null);
    const ins = mockClientQuery.mock.calls.find((c) =>
      /INSERT INTO clone_colaboradores/i.test(String(c[0])),
    );
    expect(ins?.[1]?.[6]).toBe(30);
  });

  it('acima de 100 é clampado pra 100 antes do INSERT', async () => {
    programCreate({ ...RAW_ROW, comissao_pct: '100.00' });
    await create({ slot: 'clone_x', tenantId: 'tid-1', nome: 'Ana', comissao_pct: 150 }, null);
    const ins = mockClientQuery.mock.calls.find((c) =>
      /INSERT INTO clone_colaboradores/i.test(String(c[0])),
    );
    expect(ins?.[1]?.[6]).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('update — comissao_pct (update parcial)', () => {
  function programUpdate(updRow: Record<string, unknown> | null) {
    mockClientQuery.mockReset().mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/UPDATE clone_colaboradores/i.test(sql))
        return updRow ? { rows: [updRow], rowCount: 1 } : { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
  }

  it('SEM comissao_pct no patch -> o SET NÃO toca a coluna (não zera ninguém)', async () => {
    programUpdate({ ...RAW_ROW, nome: 'Ana B' });
    await update('clone_x', 1, { nome: 'Ana B' }, null);
    const upd = mockClientQuery.mock.calls.find((c) =>
      /UPDATE clone_colaboradores/i.test(String(c[0])),
    );
    // O RETURNING sempre lista comissao_pct (lemos de volta); o que NÃO pode aparecer é
    // a ATRIBUIÇÃO `comissao_pct =` no SET — isso sobrescreveria quem não enviou.
    expect(String(upd?.[0])).not.toContain('comissao_pct =');
  });

  it('COM comissao_pct -> entra no SET e volta number', async () => {
    programUpdate({ ...RAW_ROW, comissao_pct: '20.00' });
    const row = await update('clone_x', 1, { comissao_pct: 20 }, null);
    const upd = mockClientQuery.mock.calls.find((c) =>
      /UPDATE clone_colaboradores/i.test(String(c[0])),
    );
    expect(String(upd?.[0])).toContain('comissao_pct =');
    // O valor saneado (20) está entre os binds.
    expect((upd?.[1] as unknown[]).includes(20)).toBe(true);
    expect(row?.comissao_pct).toBe(20);
  });

  it('comissao_pct=0 explícito É aplicado (zerar é intencional, ≠ ausente)', async () => {
    programUpdate({ ...RAW_ROW, comissao_pct: '0.00' });
    await update('clone_x', 1, { comissao_pct: 0 }, null);
    const upd = mockClientQuery.mock.calls.find((c) =>
      /UPDATE clone_colaboradores/i.test(String(c[0])),
    );
    expect(String(upd?.[0])).toContain('comissao_pct =');
    expect((upd?.[1] as unknown[]).includes(0)).toBe(true);
  });

  it('valor inválido (não-number) -> ColaboradorRuleError, sem tocar o banco', async () => {
    programUpdate({ ...RAW_ROW });
    await expect(update('clone_x', 1, { comissao_pct: Number.NaN }, null)).rejects.toThrow(
      /comissao_pct/,
    );
    // Nem abriu transação (validação ANTES do connect).
    expect(mockConnect).not.toHaveBeenCalled();
  });
});
