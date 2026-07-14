/**
 * Unit de bindSessionIfUnset (auditoria 13/07) — núcleo da idempotência do reparo
 * on-demand da sessão WAHA no beco sem saída do signup. O UPDATE só casa a linha
 * ainda-NULL (WHERE id=$2 AND waha_sessao IS NULL): a 1ª request ganha (rowCount 1 ->
 * true), a 2ª casa 0 linhas (-> false) e NUNCA sobrescreve um clone que já progrediu.
 *
 * Este teste trava o SQL real (o predicado IS NULL) na camada de db — os testes de
 * rota (portal-conexao.test.ts) mockam bindSessionIfUnset, então sem isto um refactor
 * que afrouxe/remova o `AND waha_sessao IS NULL` passaria verde e reabriria a corrida.
 *
 * Mocka o `query` do client (sem DB real), mesmo padrão de
 * flow-clones-mark-connected.test.ts / flow-clones-mark-stopped.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { bindSessionIfUnset } = await import('./flow-clones.js');

describe('bindSessionIfUnset', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('vincula e retorna true quando a linha estava NULL (rowCount 1)', async () => {
    // A 1ª request ganha a corrida: o WHERE casou a linha ainda-NULL.
    mockQuery.mockResolvedValue({ rows: [{ id: 7, slot: 'clone_x' }], rowCount: 1 });

    const bound = await bindSessionIfUnset(7, 'clone_x');

    expect(bound).toBe(true);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('UPDATE flow_clones');
    expect(sql).toContain('SET waha_sessao = $1');
    // Vincular deixa o clone pronto pra parear (mesmo destino do ramo feliz do signup).
    expect(sql).toContain(`status = 'aguardando_qr'`);
    // NÚCLEO DA IDEMPOTÊNCIA: só casa a linha ainda-NULL -> 2 requests nunca vinculam 2x.
    expect(sql).toContain('WHERE id = $2 AND waha_sessao IS NULL');
    // Parametrizado (anti-injection / isolamento por tenant): sessão em $1, id em $2.
    expect(params).toEqual(['clone_x', 7]);
    // NUNCA toca trial_status/cliente_telefone (o reparo não conta trial nem mexe em PII).
    expect(sql).not.toContain('trial_status');
    expect(sql).not.toContain('cliente_telefone');
  });

  it('corrida perdida: rowCount 0 (já vinculada ou clone inexistente) => false', async () => {
    // A 2ª request simultânea (ou clone que já progrediu) casa 0 linhas -> NÃO sobrescreve.
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const bound = await bindSessionIfUnset(7, 'clone_x');

    expect(bound).toBe(false);
  });
});
