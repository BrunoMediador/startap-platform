/**
 * Testes do servico idempotente ensurePixChargeForCycle.
 *
 * @startap/db (billing_charges) e o AbacatePayClient sao MOCKADOS — nao toca banco
 * nem API real. Cobre: cria+persiste, idempotencia (nao duplica), snapshot do valor,
 * e validacao de amount.
 */
import type { BillingChargeRow } from '@startap/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { insertPendingChargeIfAbsent, attachGatewayData } = vi.hoisted(() => ({
  insertPendingChargeIfAbsent: vi.fn(),
  attachGatewayData: vi.fn(),
}));

vi.mock('@startap/db', () => ({
  billingCharges: { insertPendingChargeIfAbsent, attachGatewayData },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import type { AbacatePayClient } from './client.js';
import { ensurePixChargeForCycle } from './service.js';

function makeRow(over: Partial<BillingChargeRow> = {}): BillingChargeRow {
  return {
    id: '1',
    slot: 'barbearia-cirilo',
    cycle: '2026-06',
    external_id: 'barbearia-cirilo-2026-06',
    abacate_charge_id: null,
    amount_cents: 19900,
    paid_amount_cents: null,
    status: 'pending',
    br_code: null,
    br_code_base64: null,
    expires_at: null,
    paid_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

function fakeClient(createImpl: ReturnType<typeof vi.fn>): AbacatePayClient {
  return { createPixCharge: createImpl } as unknown as AbacatePayClient;
}

const input = { slot: 'barbearia-cirilo', cycle: '2026-06', amountCents: 19900 };

beforeEach(() => {
  insertPendingChargeIfAbsent.mockReset();
  attachGatewayData.mockReset();
});

describe('ensurePixChargeForCycle', () => {
  it('cria no gateway e persiste quando nao existe (created=true)', async () => {
    insertPendingChargeIfAbsent.mockResolvedValueOnce({ row: makeRow(), created: true });
    attachGatewayData.mockResolvedValueOnce(
      makeRow({
        abacate_charge_id: 'pix_char_new',
        br_code: '00020...',
        br_code_base64: 'data:image/png;base64,QQ==',
        expires_at: new Date('2026-06-12T10:00:00Z'),
      }),
    );
    const createPixCharge = vi.fn().mockResolvedValue({
      id: 'pix_char_new',
      brCode: '00020...',
      brCodeBase64: 'data:image/png;base64,QQ==',
      status: 'pending',
      expiresAt: '2026-06-12T10:00:00.000Z',
      platformFee: 80,
    });

    const res = await ensurePixChargeForCycle(fakeClient(createPixCharge), input);

    expect(res.created).toBe(true);
    expect(res.charge.abacate_charge_id).toBe('pix_char_new');
    expect(createPixCharge).toHaveBeenCalledTimes(1);
    // Usa o SNAPSHOT da linha (row.amount_cents), nao re-le client_billing.
    expect(createPixCharge).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 19900, slot: 'barbearia-cirilo', cycle: '2026-06' }),
    );
    expect(attachGatewayData).toHaveBeenCalledTimes(1);
  });

  it('idempotencia: ja existe com gateway -> NAO chama o gateway de novo (created=false)', async () => {
    insertPendingChargeIfAbsent.mockResolvedValueOnce({
      row: makeRow({ abacate_charge_id: 'pix_char_existing', br_code: '00020...' }),
      created: false,
    });
    const createPixCharge = vi.fn();

    const res = await ensurePixChargeForCycle(fakeClient(createPixCharge), input);

    expect(res.created).toBe(false);
    expect(res.charge.abacate_charge_id).toBe('pix_char_existing');
    expect(createPixCharge).not.toHaveBeenCalled();
    expect(attachGatewayData).not.toHaveBeenCalled();
  });

  it('linha existe pending SEM gateway (falha anterior) -> completa a chamada', async () => {
    insertPendingChargeIfAbsent.mockResolvedValueOnce({
      row: makeRow({ abacate_charge_id: null }),
      created: false,
    });
    attachGatewayData.mockResolvedValueOnce(makeRow({ abacate_charge_id: 'pix_char_retry' }));
    const createPixCharge = vi.fn().mockResolvedValue({
      id: 'pix_char_retry',
      brCode: 'x',
      brCodeBase64: 'y',
      status: 'pending',
      expiresAt: null,
      platformFee: null,
    });

    const res = await ensurePixChargeForCycle(fakeClient(createPixCharge), input);

    expect(createPixCharge).toHaveBeenCalledTimes(1);
    expect(res.charge.abacate_charge_id).toBe('pix_char_retry');
  });

  it('lanca em amountCents invalido (nao inteiro / <= 0)', async () => {
    const createPixCharge = vi.fn();
    await expect(
      ensurePixChargeForCycle(fakeClient(createPixCharge), { ...input, amountCents: 0 }),
    ).rejects.toThrow(/amountCents invalido/);
    await expect(
      ensurePixChargeForCycle(fakeClient(createPixCharge), { ...input, amountCents: -50 }),
    ).rejects.toThrow(/amountCents invalido/);
    expect(insertPendingChargeIfAbsent).not.toHaveBeenCalled();
  });
});
