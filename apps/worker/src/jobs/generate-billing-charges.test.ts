/**
 * Testes do job F4 (ADR 0014 §G): geracao + reconciliacao + expiracao de cobrancas PIX.
 *
 * `../config.js`, `@startap/db` e `@startap/integrations` sao MOCKADOS — sem banco nem rede.
 * A flag BILLING_DUE_DATE_MODEL e controlada pelo mock de config (recriado por teste via
 * vi.resetModules + import dinamico).
 *
 * Cobre:
 *  - flag OFF -> NO-OP: nao le billing, nao instancia gateway, nao toca banco.
 *  - GERACAO so na janela (a_vencer/vencido); em_dia/sem_config nao geram.
 *  - PULA slot na janela SEM amount_cents (loga skip, nao gera).
 *  - RECONCILIACAO: pending PAID no gateway -> applyPaidWebhook (idempotente), sem duplicar.
 *  - EXPIRACAO: pending vencida (expires_at no passado) -> markChargeExpired.
 *  - idempotencia em reruns (1 pending/slot vem do ensurePixChargeForSlot mockado).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks dos modulos externos ao job ──────────────────────────────────────────
const listBilling = vi.fn();
const computeBillingState = vi.fn();
const ensurePixChargeForSlot = vi.fn();
const listPendingChargesWithGateway = vi.fn();
const markChargeExpired = vi.fn();
const applyPaidWebhook = vi.fn();
const getChargeStatus = vi.fn();

class FakeAbacatePayNotConfiguredError extends Error {}
class FakeAbacatePayClient {
  getChargeStatus = getChargeStatus;
  constructor(public cfg: { apiKey?: string }) {
    if (!cfg.apiKey) throw new FakeAbacatePayNotConfiguredError('no key');
  }
}

vi.mock('@startap/db', () => ({
  clientBilling: { listBilling, computeBillingState },
  billingCharges: { listPendingChargesWithGateway, markChargeExpired },
  billingWebhookEvents: { applyPaidWebhook },
}));

vi.mock('@startap/integrations', () => ({
  abacatepay: {
    AbacatePayClient: FakeAbacatePayClient,
    AbacatePayNotConfiguredError: FakeAbacatePayNotConfiguredError,
    ensurePixChargeForSlot,
  },
}));

const NOW = new Date('2026-06-10T11:00:00.000Z');

/**
 * Recarrega o job com um config.BILLING_DUE_DATE_MODEL controlado por teste.
 * `apiKey` aceita null para simular "sem chave" (default 'abc_dev_key' quando omitido —
 * passar undefined dispararia o default do JS, por isso o sentinela e null).
 */
async function loadJob(flag: boolean, apiKey: string | null = 'abc_dev_key') {
  vi.resetModules();
  vi.doMock('../config.js', () => ({
    config: {
      BILLING_DUE_DATE_MODEL: flag,
      ABACATEPAY_API_KEY: apiKey ?? undefined,
      ABACATEPAY_BASE_URL: 'https://api.abacatepay.com',
      BILLING_REISSUE_AHEAD_MIN: 120,
    },
  }));
  return import('./generate-billing-charges.js');
}

beforeEach(() => {
  listBilling.mockReset().mockResolvedValue([]);
  computeBillingState.mockReset();
  ensurePixChargeForSlot.mockReset();
  listPendingChargesWithGateway.mockReset().mockResolvedValue([]);
  markChargeExpired.mockReset().mockResolvedValue(null);
  applyPaidWebhook.mockReset();
  getChargeStatus.mockReset();
});

afterEach(() => {
  vi.doUnmock('../config.js');
});

describe('runGenerateBillingCharges — flag OFF (NO-OP)', () => {
  it('flag OFF -> nao le billing, nao instancia gateway, nao toca banco', async () => {
    const { runGenerateBillingCharges } = await loadJob(false);
    const r = await runGenerateBillingCharges(NOW);

    expect(r.skipped).toBe(true);
    expect(r.generated).toBe(0);
    expect(r.reconciledPaid).toBe(0);
    expect(r.expired).toBe(0);
    // Nenhuma leitura/escrita: o NO-OP retorna antes de qualquer chamada.
    expect(listBilling).not.toHaveBeenCalled();
    expect(listPendingChargesWithGateway).not.toHaveBeenCalled();
    expect(ensurePixChargeForSlot).not.toHaveBeenCalled();
    expect(applyPaidWebhook).not.toHaveBeenCalled();
  });
});

describe('runGenerateBillingCharges — GERACAO (so na janela)', () => {
  it('gera SO para slots na janela (a_vencer/vencido); ignora em_dia/sem_config', async () => {
    listBilling.mockResolvedValue([
      { slot: 'a_vencer_slot', next_due_date: '2026-06-15', amount_cents: 19900 },
      { slot: 'vencido_slot', next_due_date: '2026-05-01', amount_cents: 9900 },
      { slot: 'em_dia_slot', next_due_date: '2026-12-01', amount_cents: 19900 },
      { slot: 'sem_config_slot', next_due_date: null, amount_cents: null },
    ]);
    computeBillingState.mockImplementation((due: string | null) => {
      if (due === '2026-06-15') return { state: 'a_vencer', podeGerarPix: true };
      if (due === '2026-05-01') return { state: 'vencido', podeGerarPix: true };
      if (due === '2026-12-01') return { state: 'em_dia', podeGerarPix: false };
      return { state: 'sem_config', podeGerarPix: false };
    });
    ensurePixChargeForSlot.mockResolvedValue({
      charge: { id: '1' },
      created: true,
      reissued: false,
    });

    const { runGenerateBillingCharges } = await loadJob(true);
    const r = await runGenerateBillingCharges(NOW);

    expect(r.skipped).toBe(false);
    expect(r.slotsScanned).toBe(4);
    expect(r.generated).toBe(2);
    expect(ensurePixChargeForSlot).toHaveBeenCalledTimes(2);
    // amount = snapshot do slot; duePeriod = next_due_date vigente.
    expect(ensurePixChargeForSlot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        slot: 'a_vencer_slot',
        duePeriod: '2026-06-15',
        amountCents: 19900,
      }),
      NOW,
    );
    expect(ensurePixChargeForSlot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ slot: 'vencido_slot', duePeriod: '2026-05-01', amountCents: 9900 }),
      NOW,
    );
  });

  // SCRUM-124: o cron passa a janela de reemissao antecipada (BILLING_REISSUE_AHEAD_MIN em
  // ms) pro service — e o que faz a proxima cobranca nascer ANTES do vencimento (sem gap).
  it('repassa reissueAheadMs (reemissao antecipada) pro ensurePixChargeForSlot', async () => {
    listBilling.mockResolvedValue([
      { slot: 'a_vencer_slot', next_due_date: '2026-06-15', amount_cents: 19900 },
    ]);
    computeBillingState.mockReturnValue({ state: 'a_vencer', podeGerarPix: true });
    ensurePixChargeForSlot.mockResolvedValue({
      charge: { id: '1' },
      created: false,
      reissued: false,
    });

    const { runGenerateBillingCharges } = await loadJob(true);
    // default do param = config.BILLING_REISSUE_AHEAD_MIN (120) * 60_000 = 7_200_000 ms.
    await runGenerateBillingCharges(NOW);

    expect(ensurePixChargeForSlot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ slot: 'a_vencer_slot', reissueAheadMs: 120 * 60_000 }),
      NOW,
    );
  });

  it('PULA slot na janela SEM amount_cents (loga skip, nao gera)', async () => {
    listBilling.mockResolvedValue([
      { slot: 'sem_valor', next_due_date: '2026-06-15', amount_cents: null },
    ]);
    computeBillingState.mockReturnValue({ state: 'a_vencer', podeGerarPix: true });

    const { runGenerateBillingCharges } = await loadJob(true);
    const r = await runGenerateBillingCharges(NOW);

    expect(r.skippedNoAmount).toBe(1);
    expect(r.generated).toBe(0);
    expect(ensurePixChargeForSlot).not.toHaveBeenCalled();
  });

  it('idempotente: ensurePixChargeForSlot REUSA (created=false) -> nao conta como gerada', async () => {
    listBilling.mockResolvedValue([
      { slot: 'ja_tem_pending', next_due_date: '2026-06-15', amount_cents: 19900 },
    ]);
    computeBillingState.mockReturnValue({ state: 'a_vencer', podeGerarPix: true });
    // 2a execucao: a pending da 1a ja existe -> reusa.
    ensurePixChargeForSlot.mockResolvedValue({
      charge: { id: '1' },
      created: false,
      reissued: false,
    });

    const { runGenerateBillingCharges } = await loadJob(true);
    const r = await runGenerateBillingCharges(NOW);

    expect(r.generated).toBe(0);
    expect(ensurePixChargeForSlot).toHaveBeenCalledTimes(1);
  });
});

describe('runGenerateBillingCharges — RECONCILIACAO + EXPIRACAO', () => {
  beforeEach(() => {
    listBilling.mockResolvedValue([]); // foca nas pendentes
  });

  it('reconcilia pending PAID orfa (webhook perdido) sem duplicar — applyPaidWebhook idempotente', async () => {
    listPendingChargesWithGateway.mockResolvedValue([
      {
        id: '50',
        slot: 'cirilo',
        abacate_charge_id: 'pix_char_x',
        amount_cents: 19900,
        expires_at: new Date('2026-06-20T00:00:00Z'), // ainda valida (futuro)
      },
    ]);
    getChargeStatus.mockResolvedValue({ id: 'pix_char_x', status: 'paid', paidAmountCents: 19900 });
    applyPaidWebhook.mockResolvedValue({ outcome: 'applied', slot: 'cirilo', resumed: true });

    const { runGenerateBillingCharges } = await loadJob(true);
    const r = await runGenerateBillingCharges(NOW);

    expect(r.reconciledPaid).toBe(1);
    expect(markChargeExpired).not.toHaveBeenCalled(); // ainda valida -> nao expira
    // event_id SINTETICO determinístico + dueDateModel ON (avanco max(due,hoje)).
    expect(applyPaidWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'recon:pix_char_x',
        abacateChargeId: 'pix_char_x',
        paidAmountCents: 19900,
        dueDateModel: true,
      }),
    );
  });

  it('gateway ainda PENDING -> nao reconcilia, nao toca billing', async () => {
    listPendingChargesWithGateway.mockResolvedValue([
      {
        id: '51',
        slot: 'lola',
        abacate_charge_id: 'pix_char_y',
        amount_cents: 9900,
        expires_at: new Date('2026-06-20T00:00:00Z'),
      },
    ]);
    getChargeStatus.mockResolvedValue({
      id: 'pix_char_y',
      status: 'pending',
      paidAmountCents: null,
    });

    const { runGenerateBillingCharges } = await loadJob(true);
    const r = await runGenerateBillingCharges(NOW);

    expect(r.reconciledPaid).toBe(0);
    expect(applyPaidWebhook).not.toHaveBeenCalled();
  });

  it('EXPIRA pending vencida (expires_at no passado) e NAO tenta reconciliar', async () => {
    listPendingChargesWithGateway.mockResolvedValue([
      {
        id: '52',
        slot: 'ricardo',
        abacate_charge_id: 'pix_char_z',
        amount_cents: 19900,
        expires_at: new Date('2026-06-01T00:00:00Z'), // ja passou relativo a NOW
      },
    ]);
    markChargeExpired.mockResolvedValue({ id: '52', status: 'expired' });

    const { runGenerateBillingCharges } = await loadJob(true);
    const r = await runGenerateBillingCharges(NOW);

    expect(r.expired).toBe(1);
    expect(markChargeExpired).toHaveBeenCalledWith('52', NOW);
    // Expirada: nao consulta gateway nem aplica webhook.
    expect(getChargeStatus).not.toHaveBeenCalled();
    expect(applyPaidWebhook).not.toHaveBeenCalled();
  });

  // SCRUM-141: QR VELHO abandonado por reemissao antecipada foi pago, webhook PERDIDO.
  // A reconciliacao normal so olha o abacate_charge_id VIGENTE (ainda pending) — o pagamento
  // do QR velho fica invisivel. A recuperacao polla os superseded_charge_ids e credita via
  // fallback por external_id.
  it('recupera QR velho (superseded) PAID integral + webhook perdido via external_id, e NAO reconcilia o vigente', async () => {
    listPendingChargesWithGateway.mockResolvedValue([
      {
        id: '60',
        slot: 'samuel',
        external_id: 'samuel-2026-06-10',
        abacate_charge_id: 'pix_char_new', // QR vigente (ainda pending no gateway)
        superseded_charge_ids: ['pix_char_old'], // QR velho abandonado pela reemissao
        amount_cents: 5000,
        expires_at: new Date('2026-06-20T00:00:00Z'), // vigente ainda valido
      },
    ]);
    getChargeStatus.mockImplementation((id: string) =>
      id === 'pix_char_old'
        ? Promise.resolve({ id, status: 'paid', paidAmountCents: 5000 })
        : Promise.resolve({ id, status: 'pending', paidAmountCents: null }),
    );
    // outcome 'applied' (pago >= snapshot): so ENTAO e correto dar continue/parar de pollar.
    applyPaidWebhook.mockResolvedValue({
      outcome: 'applied',
      slot: 'samuel',
      resumed: true,
      amountCents: 5000,
      paidAmountCents: 5000,
    });

    const { runGenerateBillingCharges } = await loadJob(true);
    const r = await runGenerateBillingCharges(NOW);

    expect(r.recoveredSuperseded).toBe(1);
    expect(r.reconciledPaid).toBe(0); // creditado pelo QR velho -> nao reconcilia o vigente
    // Credita pelo id ANTIGO, com external_id como fallback e event_id determinístico.
    expect(applyPaidWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'recon:pix_char_old',
        abacateChargeId: 'pix_char_old',
        externalId: 'samuel-2026-06-10',
        paidAmountCents: 5000,
        dueDateModel: true,
      }),
    );
    // `continue` apos recuperar (SO com 'applied'): o QR vigente NAO e pollado nem expira.
    expect(getChargeStatus).toHaveBeenCalledWith('pix_char_old');
    expect(getChargeStatus).not.toHaveBeenCalledWith('pix_char_new');
    expect(markChargeExpired).not.toHaveBeenCalled();
  });

  // FIX (security review #517, 25/07): 'underpaid' NAO pode dar `continue`. A linha do
  // superseded ja vira 'paid' (sem avancar vencimento) — se pularmos o vigente aqui, um
  // pagamento integral do QR VIGENTE fica pra sempre invisivel (a linha ja e 'paid',
  // listPendingChargesWithGateway filtra so 'pending' -> nunca mais recupera). Sem este
  // teste, o `continue` incondicional antigo passava verde e o dinheiro do vigente sumia
  // em silencio.
  it('QR velho (superseded) pago A MENOS (underpaid) NAO aborta a linha — reconcilia o vigente pago integral', async () => {
    listPendingChargesWithGateway.mockResolvedValue([
      {
        id: '63',
        slot: 'samuel',
        external_id: 'samuel-2026-06-10',
        abacate_charge_id: 'pix_char_new', // QR vigente — foi pago INTEGRAL em paralelo
        superseded_charge_ids: ['pix_char_old'], // QR velho pago A MENOS
        amount_cents: 5000,
        expires_at: new Date('2026-06-20T00:00:00Z'),
      },
    ]);
    getChargeStatus.mockImplementation(
      (id: string) =>
        id === 'pix_char_old'
          ? Promise.resolve({ id, status: 'paid', paidAmountCents: 2000 }) // pago a menos
          : Promise.resolve({ id, status: 'paid', paidAmountCents: 5000 }), // vigente OK
    );
    applyPaidWebhook.mockImplementation((input: { abacateChargeId: string }) =>
      input.abacateChargeId === 'pix_char_old'
        ? Promise.resolve({
            outcome: 'underpaid',
            slot: 'samuel',
            resumed: false,
            amountCents: 5000,
            paidAmountCents: 2000,
          })
        : Promise.resolve({
            outcome: 'applied',
            slot: 'samuel',
            resumed: true,
            amountCents: 5000,
            paidAmountCents: 5000,
          }),
    );

    const { runGenerateBillingCharges } = await loadJob(true);
    const r = await runGenerateBillingCharges(NOW);

    // O velho (underpaid) conta como recuperado, MAS NAO interrompe o loop.
    expect(r.recoveredSuperseded).toBe(1);
    // O vigente, pago integral, É reconciliado — sem o fix isso ficaria 0 (dinheiro sumido).
    expect(r.reconciledPaid).toBe(1);
    expect(getChargeStatus).toHaveBeenCalledWith('pix_char_old');
    expect(getChargeStatus).toHaveBeenCalledWith('pix_char_new');
    expect(applyPaidWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'recon:pix_char_old', abacateChargeId: 'pix_char_old' }),
    );
    expect(applyPaidWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'recon:pix_char_new', abacateChargeId: 'pix_char_new' }),
    );
  });

  it('QR velho (superseded) ainda PENDING -> nao recupera, cai na reconciliacao normal do vigente', async () => {
    listPendingChargesWithGateway.mockResolvedValue([
      {
        id: '61',
        slot: 'samuel',
        external_id: 'samuel-2026-06-10',
        abacate_charge_id: 'pix_char_new',
        superseded_charge_ids: ['pix_char_old'],
        amount_cents: 5000,
        expires_at: new Date('2026-06-20T00:00:00Z'),
      },
    ]);
    // Nenhum dos dois pago: velho e vigente pending.
    getChargeStatus.mockResolvedValue({ id: 'x', status: 'pending', paidAmountCents: null });

    const { runGenerateBillingCharges } = await loadJob(true);
    const r = await runGenerateBillingCharges(NOW);

    expect(r.recoveredSuperseded).toBe(0);
    expect(r.reconciledPaid).toBe(0);
    expect(applyPaidWebhook).not.toHaveBeenCalled();
    // Pollou o velho E o vigente (nao houve `continue`).
    expect(getChargeStatus).toHaveBeenCalledWith('pix_char_old');
    expect(getChargeStatus).toHaveBeenCalledWith('pix_char_new');
  });

  it('sem superseded_charge_ids (linha sem historico) -> comportamento inalterado', async () => {
    listPendingChargesWithGateway.mockResolvedValue([
      {
        id: '62',
        slot: 'lola',
        external_id: 'lola-2026-06-10',
        abacate_charge_id: 'pix_char_y',
        // superseded_charge_ids ausente (linha antiga / sem reemissao)
        amount_cents: 9900,
        expires_at: new Date('2026-06-20T00:00:00Z'),
      },
    ]);
    getChargeStatus.mockResolvedValue({
      id: 'pix_char_y',
      status: 'pending',
      paidAmountCents: null,
    });

    const { runGenerateBillingCharges } = await loadJob(true);
    const r = await runGenerateBillingCharges(NOW);

    expect(r.recoveredSuperseded).toBe(0);
    // So o vigente e pollado; nada quebra por superseded ausente.
    expect(getChargeStatus).toHaveBeenCalledTimes(1);
    expect(getChargeStatus).toHaveBeenCalledWith('pix_char_y');
  });

  it('reruns nao duplicam efeito: 2a rodada com mesma pending PAID reusa o event_id sintetico', async () => {
    listPendingChargesWithGateway.mockResolvedValue([
      {
        id: '50',
        slot: 'cirilo',
        abacate_charge_id: 'pix_char_x',
        amount_cents: 19900,
        expires_at: new Date('2026-06-20T00:00:00Z'),
      },
    ]);
    getChargeStatus.mockResolvedValue({ id: 'pix_char_x', status: 'paid', paidAmountCents: 19900 });
    // 2a rodada: applyPaidWebhook ja viu este event_id -> outcome 'duplicate' (idempotente).
    applyPaidWebhook.mockResolvedValue({ outcome: 'duplicate', slot: null, resumed: false });

    const { runGenerateBillingCharges } = await loadJob(true);
    const r = await runGenerateBillingCharges(NOW);

    // 'duplicate' nao conta como reconciliacao nova (efeito ja aplicado antes).
    expect(r.reconciledPaid).toBe(0);
    expect(applyPaidWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'recon:pix_char_x' }),
    );
  });
});

describe('runGenerateBillingCharges — gateway nao configurado', () => {
  it('flag ON mas SEM ABACATEPAY_API_KEY -> aborta com erro contado, sem crashar', async () => {
    const { runGenerateBillingCharges } = await loadJob(true, null);
    const r = await runGenerateBillingCharges(NOW);

    expect(r.skipped).toBe(false);
    expect(r.errors).toBe(1);
    expect(listBilling).not.toHaveBeenCalled();
  });
});
