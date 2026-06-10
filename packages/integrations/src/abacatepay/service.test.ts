/**
 * Testes do servico idempotente ensurePixChargeForCycle.
 *
 * @startap/db (billing_charges) e o AbacatePayClient sao MOCKADOS — nao toca banco
 * nem API real. Cobre: cria+persiste, idempotencia (nao duplica), snapshot do valor,
 * e validacao de amount.
 */
import type { BillingChargeRow } from '@startap/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  insertPendingChargeIfAbsent,
  attachGatewayData,
  reissueGatewayData,
  // ── ADR 0014: modelo por data ──
  withBillingSlotLock,
  getActivePendingCharge,
  insertPendingCharge,
  attachGatewayDataById,
  reissueGatewayDataById,
} = vi.hoisted(() => ({
  insertPendingChargeIfAbsent: vi.fn(),
  attachGatewayData: vi.fn(),
  reissueGatewayData: vi.fn(),
  withBillingSlotLock: vi.fn(),
  getActivePendingCharge: vi.fn(),
  insertPendingCharge: vi.fn(),
  attachGatewayDataById: vi.fn(),
  reissueGatewayDataById: vi.fn(),
}));

vi.mock('@startap/db', () => ({
  billingCharges: {
    insertPendingChargeIfAbsent,
    attachGatewayData,
    reissueGatewayData,
    withBillingSlotLock,
    getActivePendingCharge,
    insertPendingCharge,
    attachGatewayDataById,
    reissueGatewayDataById,
  },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import type { AbacatePayClient } from './client.js';
import { ensurePixChargeForCycle, ensurePixChargeForSlot } from './service.js';

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

// "Agora" fixo pros testes de validade/expiracao. PIX expira em 2026-06-12T10:00Z.
const NOW = new Date('2026-06-11T10:00:00.000Z');
const FUTURE = new Date('2026-06-14T10:00:00.000Z'); // valido (> margem)
const PAST = new Date('2026-06-10T10:00:00.000Z'); // expirado

beforeEach(() => {
  insertPendingChargeIfAbsent.mockReset();
  attachGatewayData.mockReset();
  reissueGatewayData.mockReset();
  withBillingSlotLock.mockReset();
  getActivePendingCharge.mockReset();
  insertPendingCharge.mockReset();
  attachGatewayDataById.mockReset();
  reissueGatewayDataById.mockReset();
  // withBillingSlotLock so executa o callback com um client fake (sem banco real).
  withBillingSlotLock.mockImplementation((_slot: string, fn: (c: unknown) => Promise<unknown>) =>
    fn({}),
  );
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

// ── reissueIfExpired: os 4 caminhos do POST /pix ──────────────────────────────
describe('ensurePixChargeForCycle — reissueIfExpired (sempre PIX pagavel)', () => {
  const reissueInput = { ...input, reissueIfExpired: true };

  it('1) cobranca PAGA -> retorna paid, NAO chama gateway nem reescreve', async () => {
    insertPendingChargeIfAbsent.mockResolvedValueOnce({
      row: makeRow({ abacate_charge_id: 'pix_char_pago', status: 'paid', expires_at: PAST }),
      created: false,
    });
    const createPixCharge = vi.fn();

    const res = await ensurePixChargeForCycle(fakeClient(createPixCharge), reissueInput, NOW);

    expect(res.charge.status).toBe('paid');
    expect(res.created).toBe(false);
    expect(res.reissued).toBe(false);
    expect(createPixCharge).not.toHaveBeenCalled();
    expect(reissueGatewayData).not.toHaveBeenCalled();
    expect(attachGatewayData).not.toHaveBeenCalled();
  });

  it('2) pending VALIDA (validade no futuro) -> reusa, NAO chama gateway de novo', async () => {
    insertPendingChargeIfAbsent.mockResolvedValueOnce({
      row: makeRow({ abacate_charge_id: 'pix_char_valido', status: 'pending', expires_at: FUTURE }),
      created: false,
    });
    const createPixCharge = vi.fn();

    const res = await ensurePixChargeForCycle(fakeClient(createPixCharge), reissueInput, NOW);

    expect(res.charge.abacate_charge_id).toBe('pix_char_valido');
    expect(res.created).toBe(false);
    expect(res.reissued).toBe(false);
    expect(createPixCharge).not.toHaveBeenCalled();
    expect(reissueGatewayData).not.toHaveBeenCalled();
  });

  it('3) pending EXPIRADA -> REEMITE no gateway e atualiza a MESMA linha (novo id/expires)', async () => {
    insertPendingChargeIfAbsent.mockResolvedValueOnce({
      row: makeRow({ abacate_charge_id: 'pix_char_velho', status: 'pending', expires_at: PAST }),
      created: false,
    });
    reissueGatewayData.mockResolvedValueOnce(
      makeRow({
        abacate_charge_id: 'pix_char_novo',
        status: 'pending',
        br_code: '00020-novo',
        expires_at: new Date('2026-06-14T10:00:00.000Z'),
      }),
    );
    const createPixCharge = vi.fn().mockResolvedValue({
      id: 'pix_char_novo',
      brCode: '00020-novo',
      brCodeBase64: 'data:image/png;base64,NEW==',
      status: 'pending',
      expiresAt: '2026-06-14T10:00:00.000Z',
      platformFee: 80,
    });

    const res = await ensurePixChargeForCycle(fakeClient(createPixCharge), reissueInput, NOW);

    expect(res.created).toBe(true);
    expect(res.reissued).toBe(true);
    expect(res.charge.abacate_charge_id).toBe('pix_char_novo');
    expect(createPixCharge).toHaveBeenCalledTimes(1);
    // Usa o SNAPSHOT da linha (19900), nao re-le client_billing.
    expect(createPixCharge).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 19900 }));
    // Reemissao REUSA a linha: nenhuma insercao nova; atualiza a existente via reissue.
    expect(insertPendingChargeIfAbsent).toHaveBeenCalledTimes(1);
    expect(reissueGatewayData).toHaveBeenCalledTimes(1);
    expect(reissueGatewayData).toHaveBeenCalledWith(
      expect.objectContaining({
        slot: input.slot,
        cycle: input.cycle,
        abacateChargeId: 'pix_char_novo',
      }),
    );
    expect(attachGatewayData).not.toHaveBeenCalled();
  });

  it('3b) pending sem validade conhecida (expires_at null) com reissue -> reemite', async () => {
    insertPendingChargeIfAbsent.mockResolvedValueOnce({
      row: makeRow({
        abacate_charge_id: 'pix_char_sem_validade',
        status: 'pending',
        expires_at: null,
      }),
      created: false,
    });
    reissueGatewayData.mockResolvedValueOnce(makeRow({ abacate_charge_id: 'pix_char_novo2' }));
    const createPixCharge = vi.fn().mockResolvedValue({
      id: 'pix_char_novo2',
      brCode: 'x',
      brCodeBase64: 'y',
      status: 'pending',
      expiresAt: '2026-06-14T10:00:00.000Z',
      platformFee: null,
    });

    const res = await ensurePixChargeForCycle(fakeClient(createPixCharge), reissueInput, NOW);

    expect(res.reissued).toBe(true);
    expect(reissueGatewayData).toHaveBeenCalledTimes(1);
  });

  it('4) INEXISTENTE -> cria (insere + chama gateway + attach), nao reissue', async () => {
    insertPendingChargeIfAbsent.mockResolvedValueOnce({ row: makeRow(), created: true });
    attachGatewayData.mockResolvedValueOnce(
      makeRow({ abacate_charge_id: 'pix_char_criado', expires_at: FUTURE }),
    );
    const createPixCharge = vi.fn().mockResolvedValue({
      id: 'pix_char_criado',
      brCode: '00020...',
      brCodeBase64: 'data:image/png;base64,QQ==',
      status: 'pending',
      expiresAt: '2026-06-14T10:00:00.000Z',
      platformFee: 80,
    });

    const res = await ensurePixChargeForCycle(fakeClient(createPixCharge), reissueInput, NOW);

    expect(res.created).toBe(true);
    expect(res.reissued).toBe(false);
    expect(res.charge.abacate_charge_id).toBe('pix_char_criado');
    expect(createPixCharge).toHaveBeenCalledTimes(1);
    expect(attachGatewayData).toHaveBeenCalledTimes(1);
    expect(reissueGatewayData).not.toHaveBeenCalled();
  });

  it('expirada mas reissueIfExpired=false (default) -> reusa como esta, NAO chama gateway', async () => {
    insertPendingChargeIfAbsent.mockResolvedValueOnce({
      row: makeRow({ abacate_charge_id: 'pix_char_velho', status: 'pending', expires_at: PAST }),
      created: false,
    });
    const createPixCharge = vi.fn();

    // input legado (sem reissueIfExpired) — comportamento preservado.
    const res = await ensurePixChargeForCycle(fakeClient(createPixCharge), input, NOW);

    expect(res.created).toBe(false);
    expect(res.reissued).toBe(false);
    expect(createPixCharge).not.toHaveBeenCalled();
    expect(reissueGatewayData).not.toHaveBeenCalled();
  });
});

// ── ADR 0014: ensurePixChargeForSlot (modelo por data, advisory lock) ──────────
describe('ensurePixChargeForSlot (modelo por data de vencimento)', () => {
  const slotInput = {
    slot: 'barbearia-cirilo',
    duePeriod: '2026-06-10',
    amountCents: 19900,
  };

  it('lanca em amountCents invalido — nem entra no lock', async () => {
    const createPixCharge = vi.fn();
    await expect(
      ensurePixChargeForSlot(fakeClient(createPixCharge), { ...slotInput, amountCents: 0 }),
    ).rejects.toThrow(/amountCents invalido/);
    expect(withBillingSlotLock).not.toHaveBeenCalled();
  });

  it('REUSA quando ja ha pending VALIDA (nao chama gateway, nao insere)', async () => {
    getActivePendingCharge.mockResolvedValueOnce(
      makeRow({ id: '7', abacate_charge_id: 'pix_char_valido', expires_at: FUTURE }),
    );
    const createPixCharge = vi.fn();

    const res = await ensurePixChargeForSlot(fakeClient(createPixCharge), slotInput, NOW);

    expect(res.created).toBe(false);
    expect(res.reissued).toBe(false);
    expect(res.charge.abacate_charge_id).toBe('pix_char_valido');
    expect(createPixCharge).not.toHaveBeenCalled();
    expect(insertPendingCharge).not.toHaveBeenCalled();
    expect(reissueGatewayDataById).not.toHaveBeenCalled();
    // Tudo rodou sob o advisory lock por slot.
    expect(withBillingSlotLock).toHaveBeenCalledWith('barbearia-cirilo', expect.any(Function));
  });

  it('REEMITE (mesma linha, por id) quando a pending ativa esta EXPIRADA', async () => {
    getActivePendingCharge.mockResolvedValueOnce(
      makeRow({ id: '7', abacate_charge_id: 'pix_char_velho', expires_at: PAST }),
    );
    reissueGatewayDataById.mockResolvedValueOnce(
      makeRow({ id: '7', abacate_charge_id: 'pix_char_novo', expires_at: FUTURE }),
    );
    const createPixCharge = vi.fn().mockResolvedValue({
      id: 'pix_char_novo',
      brCode: 'x',
      brCodeBase64: 'y',
      status: 'pending',
      expiresAt: '2026-06-14T10:00:00.000Z',
      platformFee: 80,
    });

    const res = await ensurePixChargeForSlot(fakeClient(createPixCharge), slotInput, NOW);

    expect(res.created).toBe(true);
    expect(res.reissued).toBe(true);
    expect(res.charge.abacate_charge_id).toBe('pix_char_novo');
    expect(createPixCharge).toHaveBeenCalledTimes(1);
    // Reemissao chaveada por ID (modelo novo), reusa a MESMA linha — sem insert novo.
    expect(reissueGatewayDataById).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: '7', abacateChargeId: 'pix_char_novo' }),
    );
    expect(insertPendingCharge).not.toHaveBeenCalled();
    expect(attachGatewayDataById).not.toHaveBeenCalled();
  });

  it('GERA linha NOVA quando NAO ha pending valida (insere + gateway + attach por id)', async () => {
    getActivePendingCharge.mockResolvedValueOnce(null);
    insertPendingCharge.mockResolvedValueOnce(makeRow({ id: '99', cycle: '2026-06-10' }));
    attachGatewayDataById.mockResolvedValueOnce(
      makeRow({ id: '99', cycle: '2026-06-10', abacate_charge_id: 'pix_char_criado' }),
    );
    const createPixCharge = vi.fn().mockResolvedValue({
      id: 'pix_char_criado',
      brCode: '00020...',
      brCodeBase64: 'data:image/png;base64,QQ==',
      status: 'pending',
      expiresAt: '2026-06-14T10:00:00.000Z',
      platformFee: 80,
    });

    const res = await ensurePixChargeForSlot(fakeClient(createPixCharge), slotInput, NOW);

    expect(res.created).toBe(true);
    expect(res.reissued).toBe(false);
    expect(res.charge.abacate_charge_id).toBe('pix_char_criado');
    // cycle da linha nova = due_period 'YYYY-MM-DD'; snapshot do amount usado no gateway.
    expect(insertPendingCharge).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        slot: 'barbearia-cirilo',
        cycle: '2026-06-10',
        externalId: 'barbearia-cirilo-2026-06-10',
        amountCents: 19900,
      }),
    );
    expect(createPixCharge).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 19900 }));
    expect(attachGatewayDataById).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: '99', abacateChargeId: 'pix_char_criado' }),
    );
    expect(reissueGatewayDataById).not.toHaveBeenCalled();
  });

  it('RE-COBRANCA: duePeriod no passado -> gera nova linha (nao reaproveita paga antiga)', async () => {
    // Cenario re-cobranca: nenhuma pending valida (a antiga esta 'paid', fora do filtro de
    // getActivePendingCharge). Gera uma linha NOVA com o due_period passado.
    getActivePendingCharge.mockResolvedValueOnce(null);
    insertPendingCharge.mockResolvedValueOnce(makeRow({ id: '120', cycle: '2026-05-01' }));
    attachGatewayDataById.mockResolvedValueOnce(
      makeRow({ id: '120', abacate_charge_id: 'pix_char_recobranca' }),
    );
    const createPixCharge = vi.fn().mockResolvedValue({
      id: 'pix_char_recobranca',
      brCode: 'x',
      brCodeBase64: 'y',
      status: 'pending',
      expiresAt: '2026-06-14T10:00:00.000Z',
      platformFee: null,
    });

    const res = await ensurePixChargeForSlot(
      fakeClient(createPixCharge),
      { ...slotInput, duePeriod: '2026-05-01' },
      NOW,
    );

    expect(res.created).toBe(true);
    expect(res.charge.abacate_charge_id).toBe('pix_char_recobranca');
    expect(insertPendingCharge).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cycle: '2026-05-01', externalId: 'barbearia-cirilo-2026-05-01' }),
    );
  });
});
