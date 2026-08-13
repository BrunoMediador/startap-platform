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
  getCharge,
  // ── ADR 0014: modelo por data ──
  withBillingSlotLock,
  getActivePendingCharge,
  insertPendingCharge,
  attachGatewayDataById,
  reissueGatewayDataById,
} = vi.hoisted(() => ({
  getCharge: vi.fn(),
  withBillingSlotLock: vi.fn(),
  getActivePendingCharge: vi.fn(),
  insertPendingCharge: vi.fn(),
  attachGatewayDataById: vi.fn(),
  reissueGatewayDataById: vi.fn(),
}));

vi.mock('@startap/db', () => ({
  billingCharges: {
    getCharge,
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
    superseded_charge_ids: [],
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
// SCRUM-124: expira daqui 1h — AINDA valido agora, mas DENTRO da janela de reemissao (2h).
const NEAR = new Date('2026-06-11T11:00:00.000Z');
const AHEAD_2H_MS = 2 * 60 * 60 * 1000;

beforeEach(() => {
  getCharge.mockReset();
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
    getCharge.mockResolvedValueOnce(null);
    insertPendingCharge.mockResolvedValueOnce(makeRow());
    attachGatewayDataById.mockResolvedValueOnce(
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
    expect(attachGatewayDataById).toHaveBeenCalledTimes(1);
  });

  it('mantem BEGIN -> lock -> recheck -> gateway -> attach -> COMMIT no mesmo client', async () => {
    const events: string[] = [];
    const lockClient = { marker: 'same-client' };
    withBillingSlotLock.mockImplementationOnce(
      async (_slot: string, fn: (client: unknown) => Promise<unknown>) => {
        events.push('BEGIN', 'lock');
        const result = await fn(lockClient);
        events.push('COMMIT');
        return result;
      },
    );
    getCharge.mockImplementationOnce(async (_slot, _cycle, client) => {
      expect(client).toBe(lockClient);
      events.push('recheck');
      return makeRow({ abacate_charge_id: null });
    });
    const createPixCharge = vi.fn().mockImplementationOnce(async () => {
      events.push('gateway');
      return {
        id: 'pix_char_order',
        brCode: 'x',
        brCodeBase64: 'y',
        status: 'pending',
        expiresAt: null,
        platformFee: null,
      };
    });
    attachGatewayDataById.mockImplementationOnce(async (client) => {
      expect(client).toBe(lockClient);
      events.push('attach');
      return makeRow({ abacate_charge_id: 'pix_char_order' });
    });

    await ensurePixChargeForCycle(fakeClient(createPixCharge), input);

    expect(events).toEqual(['BEGIN', 'lock', 'recheck', 'gateway', 'attach', 'COMMIT']);
  });

  it('faz ROLLBACK e nao persiste quando o gateway falha dentro do lock', async () => {
    const events: string[] = [];
    const lockClient = { marker: 'same-client' };
    withBillingSlotLock.mockImplementationOnce(
      async (_slot: string, fn: (client: unknown) => Promise<unknown>) => {
        events.push('BEGIN', 'lock');
        try {
          const result = await fn(lockClient);
          events.push('COMMIT');
          return result;
        } catch (error) {
          events.push('ROLLBACK');
          throw error;
        }
      },
    );
    getCharge.mockImplementationOnce(async (_slot, _cycle, client) => {
      expect(client).toBe(lockClient);
      events.push('recheck');
      return makeRow({ abacate_charge_id: null });
    });
    const gatewayError = new Error('gateway down');
    const createPixCharge = vi.fn().mockImplementationOnce(async () => {
      events.push('gateway');
      throw gatewayError;
    });

    const failedRequests = Array.from({ length: 10 }, () =>
      ensurePixChargeForCycle(fakeClient(createPixCharge), input),
    );
    const failures = await Promise.allSettled(failedRequests);

    expect(events).toEqual(['BEGIN', 'lock', 'recheck', 'gateway', 'ROLLBACK']);
    expect(failures).toHaveLength(10);
    expect(
      failures.every((failure) => failure.status === 'rejected' && failure.reason === gatewayError),
    ).toBe(true);
    expect(withBillingSlotLock).toHaveBeenCalledTimes(1);
    expect(createPixCharge).toHaveBeenCalledTimes(1);
    expect(attachGatewayDataById).not.toHaveBeenCalled();

    // A Promise rejeitada nao pode permanecer no Map: retry do MESMO slot entra num
    // novo lock, chama o gateway novamente e conclui normalmente.
    getCharge.mockResolvedValueOnce(makeRow({ abacate_charge_id: null }));
    createPixCharge.mockResolvedValueOnce({
      id: 'pix_after_retry',
      brCode: 'retry-code',
      brCodeBase64: 'retry-base64',
      status: 'pending',
      expiresAt: null,
      platformFee: null,
    });
    attachGatewayDataById.mockResolvedValueOnce(makeRow({ abacate_charge_id: 'pix_after_retry' }));

    const retry = await ensurePixChargeForCycle(fakeClient(createPixCharge), input);

    expect(retry.charge.abacate_charge_id).toBe('pix_after_retry');
    expect(withBillingSlotLock).toHaveBeenCalledTimes(2);
    expect(createPixCharge).toHaveBeenCalledTimes(2);
    expect(attachGatewayDataById).toHaveBeenCalledTimes(1);
  });

  it('coalesce 10 chamadas locais do mesmo slot antes do pool e limpa o single-flight', async () => {
    let releaseGateway: ((value: unknown) => void) | undefined;
    const gatewayPending = new Promise((resolve) => {
      releaseGateway = resolve;
    });
    getCharge.mockResolvedValueOnce(null);
    insertPendingCharge.mockResolvedValueOnce(makeRow());
    attachGatewayDataById.mockResolvedValueOnce(makeRow({ abacate_charge_id: 'pix_one' }));
    const createPixCharge = vi.fn(() => gatewayPending);

    const requests = Array.from({ length: 10 }, () =>
      ensurePixChargeForCycle(fakeClient(createPixCharge), input),
    );
    await vi.waitFor(() => expect(withBillingSlotLock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(createPixCharge).toHaveBeenCalledTimes(1));
    releaseGateway?.({
      id: 'pix_one',
      brCode: 'x',
      brCodeBase64: 'y',
      status: 'pending',
      expiresAt: null,
      platformFee: null,
    });

    const results = await Promise.all(requests);
    expect(results.every((result) => result.charge.id === '1')).toBe(true);
    expect(insertPendingCharge).toHaveBeenCalledTimes(1);

    getCharge.mockResolvedValueOnce(makeRow({ abacate_charge_id: 'pix_one' }));
    await ensurePixChargeForCycle(fakeClient(createPixCharge), input);
    expect(withBillingSlotLock).toHaveBeenCalledTimes(2);
  });

  it('lock cross-instance ocupado propaga busy sem chamar gateway', async () => {
    withBillingSlotLock.mockRejectedValueOnce(new Error('billing slot busy'));
    const createPixCharge = vi.fn();

    await expect(ensurePixChargeForCycle(fakeClient(createPixCharge), input)).rejects.toThrow(
      'billing slot busy',
    );

    expect(getCharge).not.toHaveBeenCalled();
    expect(createPixCharge).not.toHaveBeenCalled();
  });

  it('idempotencia: ja existe com gateway -> NAO chama o gateway de novo (created=false)', async () => {
    getCharge.mockResolvedValueOnce(
      makeRow({ abacate_charge_id: 'pix_char_existing', br_code: '00020...' }),
    );
    const createPixCharge = vi.fn();

    const res = await ensurePixChargeForCycle(fakeClient(createPixCharge), input);

    expect(res.created).toBe(false);
    expect(res.charge.abacate_charge_id).toBe('pix_char_existing');
    expect(createPixCharge).not.toHaveBeenCalled();
    expect(attachGatewayDataById).not.toHaveBeenCalled();
  });

  it('linha existe pending SEM gateway (falha anterior) -> completa a chamada', async () => {
    getCharge.mockResolvedValueOnce(makeRow({ abacate_charge_id: null }));
    attachGatewayDataById.mockResolvedValueOnce(makeRow({ abacate_charge_id: 'pix_char_retry' }));
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
    expect(withBillingSlotLock).not.toHaveBeenCalled();
  });
});

// ── reissueIfExpired: os 4 caminhos do POST /pix ──────────────────────────────
describe('ensurePixChargeForCycle — reissueIfExpired (sempre PIX pagavel)', () => {
  const reissueInput = { ...input, reissueIfExpired: true };

  it('1) cobranca PAGA -> retorna paid, NAO chama gateway nem reescreve', async () => {
    getCharge.mockResolvedValueOnce(
      makeRow({ abacate_charge_id: 'pix_char_pago', status: 'paid', expires_at: PAST }),
    );
    const createPixCharge = vi.fn();

    const res = await ensurePixChargeForCycle(fakeClient(createPixCharge), reissueInput, NOW);

    expect(res.charge.status).toBe('paid');
    expect(res.created).toBe(false);
    expect(res.reissued).toBe(false);
    expect(createPixCharge).not.toHaveBeenCalled();
    expect(reissueGatewayDataById).not.toHaveBeenCalled();
    expect(attachGatewayDataById).not.toHaveBeenCalled();
  });

  it('2) pending VALIDA (validade no futuro) -> reusa, NAO chama gateway de novo', async () => {
    getCharge.mockResolvedValueOnce(
      makeRow({ abacate_charge_id: 'pix_char_valido', status: 'pending', expires_at: FUTURE }),
    );
    const createPixCharge = vi.fn();

    const res = await ensurePixChargeForCycle(fakeClient(createPixCharge), reissueInput, NOW);

    expect(res.charge.abacate_charge_id).toBe('pix_char_valido');
    expect(res.created).toBe(false);
    expect(res.reissued).toBe(false);
    expect(createPixCharge).not.toHaveBeenCalled();
    expect(reissueGatewayDataById).not.toHaveBeenCalled();
  });

  it('3) pending EXPIRADA -> REEMITE no gateway e atualiza a MESMA linha (novo id/expires)', async () => {
    getCharge.mockResolvedValueOnce(
      makeRow({ abacate_charge_id: 'pix_char_velho', status: 'pending', expires_at: PAST }),
    );
    reissueGatewayDataById.mockResolvedValueOnce(
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
    expect(getCharge).toHaveBeenCalledTimes(1);
    expect(reissueGatewayDataById).toHaveBeenCalledTimes(1);
    expect(reissueGatewayDataById).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: '1',
        abacateChargeId: 'pix_char_novo',
      }),
    );
    expect(attachGatewayDataById).not.toHaveBeenCalled();
  });

  it('3b) pending sem validade conhecida (expires_at null) com reissue -> reemite', async () => {
    getCharge.mockResolvedValueOnce(
      makeRow({
        abacate_charge_id: 'pix_char_sem_validade',
        status: 'pending',
        expires_at: null,
      }),
    );
    reissueGatewayDataById.mockResolvedValueOnce(makeRow({ abacate_charge_id: 'pix_char_novo2' }));
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
    expect(reissueGatewayDataById).toHaveBeenCalledTimes(1);
  });

  it('4) INEXISTENTE -> cria (insere + chama gateway + attach), nao reissue', async () => {
    getCharge.mockResolvedValueOnce(null);
    insertPendingCharge.mockResolvedValueOnce(makeRow());
    attachGatewayDataById.mockResolvedValueOnce(
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
    expect(attachGatewayDataById).toHaveBeenCalledTimes(1);
    expect(reissueGatewayDataById).not.toHaveBeenCalled();
  });

  it('expirada mas reissueIfExpired=false (default) -> reusa como esta, NAO chama gateway', async () => {
    getCharge.mockResolvedValueOnce(
      makeRow({ abacate_charge_id: 'pix_char_velho', status: 'pending', expires_at: PAST }),
    );
    const createPixCharge = vi.fn();

    // input legado (sem reissueIfExpired) — comportamento preservado.
    const res = await ensurePixChargeForCycle(fakeClient(createPixCharge), input, NOW);

    expect(res.created).toBe(false);
    expect(res.reissued).toBe(false);
    expect(createPixCharge).not.toHaveBeenCalled();
    expect(reissueGatewayDataById).not.toHaveBeenCalled();
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

  // ── SCRUM-124: reemissao ANTECIPADA (fecha o buraco de ~24h sem PIX pagavel) ──────
  it('SCRUM-124: REEMITE ANTECIPADO quando a pending expira DENTRO da janela reissueAheadMs (mesma linha, sem duplicar)', async () => {
    // Pending ainda valida AGORA (expira daqui 1h) mas DENTRO da janela de 2h -> reemite
    // a proxima ANTES do vencimento, sem deixar buraco. REGRESSAO: sem o fix o service
    // ignora reissueAheadMs, considera valida (1h > margem) e REUSA (created=false) -> RED.
    getActivePendingCharge.mockResolvedValueOnce(
      makeRow({ id: '7', abacate_charge_id: 'pix_char_expira_logo', expires_at: NEAR }),
    );
    reissueGatewayDataById.mockResolvedValueOnce(
      makeRow({ id: '7', abacate_charge_id: 'pix_char_antecipado', expires_at: FUTURE }),
    );
    const createPixCharge = vi.fn().mockResolvedValue({
      id: 'pix_char_antecipado',
      brCode: 'x',
      brCodeBase64: 'y',
      status: 'pending',
      expiresAt: '2026-06-14T10:00:00.000Z',
      platformFee: 80,
    });

    const res = await ensurePixChargeForSlot(
      fakeClient(createPixCharge),
      { ...slotInput, reissueAheadMs: AHEAD_2H_MS },
      NOW,
    );

    // Reemitiu (proxima cobranca nasce ANTES do vencimento) reusando a MESMA linha (id '7').
    expect(res.created).toBe(true);
    expect(res.reissued).toBe(true);
    expect(res.charge.abacate_charge_id).toBe('pix_char_antecipado');
    expect(createPixCharge).toHaveBeenCalledTimes(1);
    expect(reissueGatewayDataById).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: '7', abacateChargeId: 'pix_char_antecipado' }),
    );
    // GARANTIA anti-duplicacao: NAO insere 2a linha — reusa a existente.
    expect(insertPendingCharge).not.toHaveBeenCalled();
  });

  it('SCRUM-124: NAO reemite quando a pending e valida ALEM da janela (reusa, sem 2a cobranca)', async () => {
    // Expira daqui 3 dias (>> janela 2h) -> reusa. Prova que a reemissao antecipada NAO e
    // "gerar mais agressivo": nada de churn de gateway nem cobranca duplicada.
    getActivePendingCharge.mockResolvedValueOnce(
      makeRow({ id: '7', abacate_charge_id: 'pix_char_valido_longe', expires_at: FUTURE }),
    );
    const createPixCharge = vi.fn();

    const res = await ensurePixChargeForSlot(
      fakeClient(createPixCharge),
      { ...slotInput, reissueAheadMs: AHEAD_2H_MS },
      NOW,
    );

    expect(res.created).toBe(false);
    expect(res.reissued).toBe(false);
    expect(res.charge.abacate_charge_id).toBe('pix_char_valido_longe');
    expect(createPixCharge).not.toHaveBeenCalled();
    expect(reissueGatewayDataById).not.toHaveBeenCalled();
    expect(insertPendingCharge).not.toHaveBeenCalled();
  });

  it('SCRUM-124: SEM reissueAheadMs (portal/legado) a pending que expira em 1h ainda e REUSADA', async () => {
    // Portal (geracao sob demanda) nao passa a janela -> horizonte == agora -> so reemite se
    // JA expirada. Garante que o fix nao muda o caminho on-demand (nem risco de duplicar QR).
    getActivePendingCharge.mockResolvedValueOnce(
      makeRow({ id: '7', abacate_charge_id: 'pix_char_valido', expires_at: NEAR }),
    );
    const createPixCharge = vi.fn();

    const res = await ensurePixChargeForSlot(fakeClient(createPixCharge), slotInput, NOW);

    expect(res.created).toBe(false);
    expect(res.reissued).toBe(false);
    expect(createPixCharge).not.toHaveBeenCalled();
    expect(reissueGatewayDataById).not.toHaveBeenCalled();
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
