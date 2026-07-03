/**
 * Unit de get/updateAlertOwnerPhoneBySlot (SCRUM-59 PR-E) — o DONO edita no portal o
 * número que recebe os avisos ao dono (lead/escalação do modo atendente E desconexão).
 *
 * Mocka o `query` do client (sem DB real), mesmo padrão dos demais testes de flow-clones.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { getAlertOwnerPhoneBySlot, updateAlertOwnerPhoneBySlot } = await import('./flow-clones.js');

describe('getAlertOwnerPhoneBySlot', () => {
  beforeEach(() => mockQuery.mockReset());

  it('devolve o número RAW (só dígitos) do clone', async () => {
    mockQuery.mockResolvedValue({ rows: [{ alert_owner_phone: '5535998877248' }] });
    expect(await getAlertOwnerPhoneBySlot('clone_x')).toBe('5535998877248');
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('SELECT alert_owner_phone FROM flow_clones WHERE slot = $1');
    expect(params).toEqual(['clone_x']); // parametrizado (isolamento por tenant)
  });

  it('null quando a coluna está vazia/nula', async () => {
    mockQuery.mockResolvedValue({ rows: [{ alert_owner_phone: '' }] });
    expect(await getAlertOwnerPhoneBySlot('clone_x')).toBeNull();
    mockQuery.mockResolvedValue({ rows: [{ alert_owner_phone: null }] });
    expect(await getAlertOwnerPhoneBySlot('clone_x')).toBeNull();
  });

  it('null quando o slot não existe', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await getAlertOwnerPhoneBySlot('inexistente')).toBeNull();
  });
});

describe('updateAlertOwnerPhoneBySlot', () => {
  beforeEach(() => mockQuery.mockReset());

  it('grava o número normalizado (só dígitos) escopado por slot; true quando afetou 1 linha', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });
    // entra com máscara -> guard normaliza pra dígitos antes de gravar.
    const ok = await updateAlertOwnerPhoneBySlot('clone_x', '+55 (35) 99887-7248');
    expect(ok).toBe(true);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('UPDATE flow_clones SET alert_owner_phone = $2');
    expect(sql).toContain('WHERE slot = $1');
    expect(params).toEqual(['clone_x', '5535998877248']); // dígitos, slot parametrizado
  });

  it('NO-OP (false) e NÃO grava quando o número é inválido (guard defensivo, nunca zera)', async () => {
    for (const bad of ['', '11999998888', '5535999', '00998877248', 'abc']) {
      const ok = await updateAlertOwnerPhoneBySlot('clone_x', bad);
      expect(ok).toBe(false);
    }
    expect(mockQuery).not.toHaveBeenCalled(); // nunca chegou a escrever
  });

  it('false quando o slot não existe (rowCount 0)', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });
    expect(await updateAlertOwnerPhoneBySlot('inexistente', '5535998877248')).toBe(false);
  });
});
