/**
 * Unit de markCloneStoppedBySession (SCRUM-64) — flip idempotente de flow_clones.status
 * p/ 'parado' quando a sessão WAHA é PARADA de propósito (POST /stop). Distinto de
 * 'desconectado' (queda inesperada): o monitor exclui 'parado' -> sem alerta de queda falso.
 *
 * Mocka o `query` do client (sem DB real), mesmo padrão de flow-clones-mark-connected.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { markCloneStoppedBySession } = await import('./flow-clones.js');

describe('markCloneStoppedBySession', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('flipa para parado e retorna true quando uma linha (conectado/desconectado) muda', async () => {
    mockQuery.mockResolvedValue({ rows: [{ slot: 'clone_x' }], rowCount: 1 });

    const changed = await markCloneStoppedBySession('sess_x');

    expect(changed).toBe(true);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(`SET status = 'parado'`);
    // Só flipa sessões que estavam no ar — não clobbera pré-setup (rascunho/aguardando_qr/falhou).
    expect(sql).toContain(`status IN ('conectado', 'desconectado')`);
    // Chaveado por waha_sessao (mesma âncora do sync do painel), parametrizado (anti-injection).
    expect(sql).toContain('WHERE waha_sessao = $1');
    expect(params).toEqual(['sess_x']);
    // NUNCA toca trial_status/cliente_telefone/first_connected_at (só o status).
    expect(sql).not.toContain('trial_status');
    expect(sql).not.toContain('cliente_telefone');
    expect(sql).not.toContain('first_connected_at');
  });

  it('no-op idempotente: rowCount 0 (já parado, pré-setup ou sessão inexistente) => false', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const changed = await markCloneStoppedBySession('sess_ja_parada');

    expect(changed).toBe(false);
  });
});
