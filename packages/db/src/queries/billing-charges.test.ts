/**
 * Testes das queries de billing_charges (ADR 0013).
 *
 * O `query` de ../client.js e MOCKADO — nao toca banco. Foco: a SQL de reissueGatewayData
 * sobrescreve a MESMA linha (slot, cycle), volta status='pending' e EXCLUI cobranca paga
 * (WHERE status <> 'paid') — invariante C2: reemissao nunca reescreve cobranca ja paga.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock('../client.js', () => ({ query: queryMock }));

import { reissueGatewayData } from './billing-charges.js';

beforeEach(() => {
  queryMock.mockReset();
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
});
