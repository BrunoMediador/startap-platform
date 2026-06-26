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
    // RETURNING agora traz status_changed (predicado avaliado ANTES do SET = estado prévio).
    mockQuery.mockResolvedValue({
      rows: [{ slot: 'clone_x', status_changed: true }],
      rowCount: 1,
    });

    const updated = await markCloneConnectedBySlot('clone_x');

    expect(updated).toBe(true);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(`SET status = 'conectado'`);
    // Carimba first_connected_at na 1ª vez e NUNCA sobrescreve (COALESCE) — sinal "ever paired".
    expect(sql).toContain('first_connected_at = COALESCE(first_connected_at, NOW())');
    // Guard: roda quando o status muda OU quando falta carimbar first_connected_at (clone legado).
    expect(sql).toContain(`status IS DISTINCT FROM 'conectado' OR first_connected_at IS NULL`);
    // RETURNING expõe se o STATUS mudou (contrato do boolean preservado).
    expect(sql).toContain('AS status_changed');
    // Parametrizado pelo slot (proteção SQL injection / isolamento por tenant).
    expect(params).toEqual(['clone_x']);
    // NUNCA toca trial_status nem cliente_telefone (sem regressão no trial).
    expect(sql).not.toContain('trial_status');
    expect(sql).not.toContain('cliente_telefone');
  });

  it('carimbou first_connected_at de clone legado JÁ conectado => false (status não mudou)', async () => {
    // Linha afetada (carimbou o timestamp) mas o status já era 'conectado' -> contrato pede false.
    mockQuery.mockResolvedValue({
      rows: [{ slot: 'clone_legado', status_changed: false }],
      rowCount: 1,
    });

    const updated = await markCloneConnectedBySlot('clone_legado');

    expect(updated).toBe(false);
  });

  it('no-op idempotente: rowCount 0 (já conectado+carimbado ou slot inexistente) => false', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const updated = await markCloneConnectedBySlot('clone_ja_conectado');

    expect(updated).toBe(false);
  });
});
