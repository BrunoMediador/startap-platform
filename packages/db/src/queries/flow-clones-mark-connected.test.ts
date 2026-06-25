/**
 * Unit de markCloneConnectedBySlot — flip idempotente de flow_clones.status p/
 * 'conectado', desacoplado da contagem de trial (fix: trial-already-counted
 * deixava o status preso em 'desconectado' e silenciava os alertas ao dono).
 *
 * Mocka o `query` do client (sem DB real), mesmo padrão de
 * flow-clones-alert-owner.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { markCloneConnectedBySlot } = await import('./flow-clones.js');

describe('markCloneConnectedBySlot', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('flipa para conectado e retorna true quando o status mudou', async () => {
    mockQuery.mockResolvedValue({ rows: [{ slot: 'clone_x' }], rowCount: 1 });

    const updated = await markCloneConnectedBySlot('clone_x');

    expect(updated).toBe(true);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    // Guard idempotente: só escreve se ainda NÃO está conectado.
    expect(sql).toContain(`SET status = 'conectado'`);
    expect(sql).toContain(`status IS DISTINCT FROM 'conectado'`);
    // Parametrizado pelo slot (proteção SQL injection / isolamento por tenant).
    expect(params).toEqual(['clone_x']);
    // NUNCA toca trial_status nem cliente_telefone (sem regressão no trial).
    expect(sql).not.toContain('trial_status');
    expect(sql).not.toContain('cliente_telefone');
  });

  it('no-op idempotente: rowCount 0 (já conectado ou slot inexistente) => false', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const updated = await markCloneConnectedBySlot('clone_ja_conectado');

    expect(updated).toBe(false);
  });
});
