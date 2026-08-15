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
  // ── SCRUM-173: outbox da chamada ao gateway ──
  markGatewayCalling,
  outboxCallAllowed,
  PixChargeGatewayInFlightError,
} = vi.hoisted(() => {
  class PixChargeGatewayInFlightErrorImpl extends Error {
    slot: string;
    chargeId: string;
    constructor(slot: string, chargeId: string) {
      super('pix charge gateway call in flight');
      this.name = 'PixChargeGatewayInFlightError';
      this.slot = slot;
      this.chargeId = chargeId;
    }
  }
  return {
    getCharge: vi.fn(),
    withBillingSlotLock: vi.fn(),
    getActivePendingCharge: vi.fn(),
    insertPendingCharge: vi.fn(),
    attachGatewayDataById: vi.fn(),
    reissueGatewayDataById: vi.fn(),
    markGatewayCalling: vi.fn(),
    // Default real (nao mockado): so bloqueia se 'calling' E dentro do timeout. Os testes
    // de timeout ambiguo sobrescrevem com mockReturnValueOnce quando precisam.
    outboxCallAllowed: vi.fn(
      (row: { gateway_call_state?: string; gateway_call_started_at?: Date | null }) =>
        row.gateway_call_state !== 'calling',
    ),
    PixChargeGatewayInFlightError: PixChargeGatewayInFlightErrorImpl,
  };
});

vi.mock('@startap/db', () => ({
  billingCharges: {
    getCharge,
    withBillingSlotLock,
    getActivePendingCharge,
    insertPendingCharge,
    attachGatewayDataById,
    reissueGatewayDataById,
    markGatewayCalling,
    outboxCallAllowed,
    PixChargeGatewayInFlightError,
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
  markGatewayCalling.mockReset();
  outboxCallAllowed.mockReset();
  // withBillingSlotLock so executa o callback com um client fake (sem banco real). E
  // chamado MULTIPLAS vezes por operacao completa desde o SCRUM-173 (fase 1: recheck/
  // insert; fase 2: marca 'calling'; fase 3: persiste resultado) — cada chamada reabre o
  // "lock" (mock simplifica: sempre concede).
  withBillingSlotLock.mockImplementation((_slot: string, fn: (c: unknown) => Promise<unknown>) =>
    fn({}),
  );
  markGatewayCalling.mockResolvedValue(undefined);
  // Default: nunca bloqueia (linha nao esta 'calling'). Sobrescrito nos testes de outbox.
  outboxCallAllowed.mockReturnValue(true);
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

  it('OUTBOX (SCRUM-173): marca calling e COMMITA ANTES do POST, so ai chama o gateway, so ai persiste (3 transacoes)', async () => {
    const events: string[] = [];
    withBillingSlotLock.mockImplementation(
      async (_slot: string, fn: (client: unknown) => Promise<unknown>) => {
        events.push('BEGIN');
        const result = await fn({});
        events.push('COMMIT');
        return result;
      },
    );
    getCharge.mockImplementationOnce(async () => {
      events.push('recheck');
      return makeRow({ abacate_charge_id: null });
    });
    markGatewayCalling.mockImplementationOnce(async () => {
      events.push('mark-calling');
      return makeRow({ gateway_call_state: 'calling' });
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
    attachGatewayDataById.mockImplementationOnce(async () => {
      events.push('attach');
      return makeRow({ abacate_charge_id: 'pix_char_order', gateway_call_state: 'done' });
    });

    await ensurePixChargeForCycle(fakeClient(createPixCharge), input);

    // 3 transacoes distintas (BEGIN/COMMIT em par): recheck+insert, marca-calling, attach.
    // O COMMIT de 'mark-calling' acontece ANTES do POST ao gateway — e o nucleo do fix: a
    // intencao de chamar fica persistida e sobrevive a um crash durante o POST.
    expect(events).toEqual([
      'BEGIN',
      'recheck',
      'COMMIT',
      'BEGIN',
      'mark-calling',
      'COMMIT',
      'gateway',
      'BEGIN',
      'attach',
      'COMMIT',
    ]);
    expect(withBillingSlotLock).toHaveBeenCalledTimes(3);
  });

  it('SCRUM-173: timeout no gateway NAO desfaz o INSERT — linha fica calling, retry respeita outboxCallAllowed', async () => {
    const lockClient = { marker: 'same-client' };
    withBillingSlotLock.mockImplementation(
      async (_slot: string, fn: (client: unknown) => Promise<unknown>) => fn(lockClient),
    );
    // Linha NOVA (nao existe ainda) — reproduz o cenario do card: gateway CONFIRMA mas a
    // resposta se perde. Antes do fix, o INSERT desta linha seria desfeito pelo rollback.
    getCharge.mockResolvedValueOnce(null);
    insertPendingCharge.mockResolvedValueOnce(makeRow({ abacate_charge_id: null }));
    markGatewayCalling.mockResolvedValueOnce(
      makeRow({ gateway_call_state: 'calling', gateway_call_started_at: new Date() }),
    );
    const gatewayError = new Error('gateway timeout');
    const createPixCharge = vi.fn().mockImplementationOnce(async () => {
      throw gatewayError;
    });

    // A chamada falha (timeout) — mas o INSERT ja tinha sido commitado na fase 1, e a
    // marca 'calling' na fase 2 tambem ja foi commitada. NADA disso e desfeito (nao ha
    // transacao guarda-chuva pra dar ROLLBACK) — e exatamente essa persistencia que
    // resolve a causa raiz do card.
    await expect(ensurePixChargeForCycle(fakeClient(createPixCharge), input)).rejects.toThrow(
      gatewayError,
    );
    expect(insertPendingCharge).toHaveBeenCalledTimes(1);
    expect(markGatewayCalling).toHaveBeenCalledTimes(1);
    expect(attachGatewayDataById).not.toHaveBeenCalled();

    // Retry IMEDIATO (mesma janela de ambiguidade): outboxCallAllowed diz NAO (mock
    // simula 'calling' recente) -> nao chama createPixCharge de novo, nao cria 2a
    // cobranca. Esta e a asserção central do card: numero de chamadas ao gateway.
    outboxCallAllowed.mockReturnValueOnce(false);
    getCharge.mockResolvedValueOnce(
      makeRow({ abacate_charge_id: null, gateway_call_state: 'calling' }),
    );
    await expect(ensurePixChargeForCycle(fakeClient(createPixCharge), input)).rejects.toThrow(
      /gateway call in flight/,
    );
    expect(createPixCharge).toHaveBeenCalledTimes(1); // AINDA 1 — retry nao chamou de novo.
    expect(insertPendingCharge).toHaveBeenCalledTimes(1); // AINDA 1 — nao criou 2a linha.

    // So DEPOIS do timeout de ambiguidade passar, outboxCallAllowed libera nova tentativa
    // (mock simula isso) e o retry conclui normalmente pela MESMA linha.
    outboxCallAllowed.mockReturnValueOnce(true);
    getCharge.mockResolvedValueOnce(
      makeRow({ abacate_charge_id: null, gateway_call_state: 'calling' }),
    );
    markGatewayCalling.mockResolvedValueOnce(makeRow({ gateway_call_state: 'calling' }));
    createPixCharge.mockResolvedValueOnce({
      id: 'pix_after_timeout',
      brCode: 'retry-code',
      brCodeBase64: 'retry-base64',
      status: 'pending',
      expiresAt: null,
      platformFee: null,
    });
    attachGatewayDataById.mockResolvedValueOnce(
      makeRow({ abacate_charge_id: 'pix_after_timeout', gateway_call_state: 'done' }),
    );

    const retry = await ensurePixChargeForCycle(fakeClient(createPixCharge), input);
    expect(retry.charge.abacate_charge_id).toBe('pix_after_timeout');
    expect(createPixCharge).toHaveBeenCalledTimes(2); // so agora incrementa.
    expect(insertPendingCharge).toHaveBeenCalledTimes(1); // NUNCA criou 2a linha.
  });

  it('gateway falha (sem outbox em voo bloqueando) — 10 chamadas coalescidas propagam o mesmo erro, retry cria/completa e conclui', async () => {
    const lockClient = { marker: 'same-client' };
    withBillingSlotLock.mockImplementation(
      async (_slot: string, fn: (client: unknown) => Promise<unknown>) => fn(lockClient),
    );
    getCharge.mockImplementationOnce(async (_slot, _cycle, client) => {
      expect(client).toBe(lockClient);
      return makeRow({ abacate_charge_id: null });
    });
    markGatewayCalling.mockResolvedValueOnce(makeRow({ gateway_call_state: 'calling' }));
    const gatewayError = new Error('gateway down');
    const createPixCharge = vi.fn().mockImplementationOnce(async () => {
      throw gatewayError;
    });

    const failedRequests = Array.from({ length: 10 }, () =>
      ensurePixChargeForCycle(fakeClient(createPixCharge), input),
    );
    const failures = await Promise.allSettled(failedRequests);

    expect(failures).toHaveLength(10);
    expect(
      failures.every((failure) => failure.status === 'rejected' && failure.reason === gatewayError),
    ).toBe(true);
    // 2 transacoes rodaram (recheck, mark-calling) antes do gateway falhar; NENHUMA foi
    // desfeita (nao ha ROLLBACK que apague o mark-calling — e o proprio fix).
    expect(withBillingSlotLock).toHaveBeenCalledTimes(2);
    expect(createPixCharge).toHaveBeenCalledTimes(1);
    expect(insertPendingCharge).not.toHaveBeenCalled();
    expect(attachGatewayDataById).not.toHaveBeenCalled();

    // A Promise rejeitada nao pode permanecer no Map: retry do MESMO slot entra de novo.
    // outboxCallAllowed segue default true (linha 'calling' mas mock nao bloqueia aqui —
    // o teste de timeout ambiguo acima ja cobre o caso bloqueado) -> completa a chamada
    // ao gateway pela MESMA linha (fluxo "pending sem gateway -> completa").
    getCharge.mockResolvedValueOnce(
      makeRow({ abacate_charge_id: null, gateway_call_state: 'calling' }),
    );
    markGatewayCalling.mockResolvedValueOnce(makeRow({ gateway_call_state: 'calling' }));
    createPixCharge.mockResolvedValueOnce({
      id: 'pix_after_retry',
      brCode: 'retry-code',
      brCodeBase64: 'retry-base64',
      status: 'pending',
      expiresAt: null,
      platformFee: null,
    });
    attachGatewayDataById.mockResolvedValueOnce(
      makeRow({ abacate_charge_id: 'pix_after_retry', gateway_call_state: 'done' }),
    );

    const retry = await ensurePixChargeForCycle(fakeClient(createPixCharge), input);

    expect(retry.charge.abacate_charge_id).toBe('pix_after_retry');
    expect(createPixCharge).toHaveBeenCalledTimes(2);
    expect(attachGatewayDataById).toHaveBeenCalledTimes(1);
    // NUNCA criou linha nova — sempre a mesma (id '1' default do makeRow).
    expect(insertPendingCharge).not.toHaveBeenCalled();
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
    // 1a rodada (10 chamadas coalescidas em 1 operacao real): recheck+insert, mark-calling,
    // attach = 3 chamadas ao lock. 2a rodada (linha ja com gateway -> reuso, so recheck) = +1.
    expect(withBillingSlotLock).toHaveBeenCalledTimes(4);
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
