/**
 * Testes do alerta interno de bot PAGANTE silenciado por inadimplência (SCRUM-67).
 *
 * `@startap/db` (alerts + clientBilling) e `@startap/integrations` (internalAlert) são MOCKADOS —
 * sem banco nem WAHA. O job só ORQUESTRA (decisão de silêncio + cooldown + envio); a query
 * (listBillingClonesForSilenceCheck) e a copy (msgBotSilenciadoInadimplencia, testada em
 * internal-alert.test.ts) ficam fora do escopo aqui.
 *
 * Cobre o brief do card:
 *  - pagante silenciado -> 1 alerta; 2º ciclo dentro do cooldown -> NÃO repete (< 24h);
 *  - pagante EM DIA -> nenhum alerta;
 *  - trial / sem last_payment_at -> nenhum alerta (só PAGANTE);
 *  - gate OFF (BILLING_OVERDUE_SILENCE) -> NO-OP total (nem consulta o banco);
 *  - envio falho (sent=0) -> NÃO carimba cooldown (re-tenta no próximo ciclo);
 *  - fail-safe: erro de leitura de estado -> pula o slot (fail-closed), nunca lança;
 *  - LGPD: a chave de cooldown usa slot (sem PII); a mensagem carrega só slot/nome/dias.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getState = vi.fn();
const upsertState = vi.fn();
const listBillingClonesForSilenceCheck = vi.fn();
const sendInternalAlert = vi.fn();
const msgBotSilenciadoInadimplencia = vi.fn(
  (i: { displayName: string; slot: string; nextDueDate: string; diasAtraso: number }) =>
    `SILENCIADO ${i.displayName} slot=${i.slot} venc=${i.nextDueDate} dias=${i.diasAtraso}`,
);

vi.mock('@startap/db', () => ({
  alerts: { getState, upsertState },
  clientBilling: { listBillingClonesForSilenceCheck, GRACE_DAYS: 3 },
}));

vi.mock('@startap/integrations', () => ({
  internalAlert: { sendInternalAlert, msgBotSilenciadoInadimplencia },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { runBillingSilenceAlert, evaluateOverdueSilence, silenceCooldownKey } = await import(
  './billing-silence-alert.js'
);

interface Candidate {
  slot: string;
  display_name: string | null;
  next_due_date: string | null;
  amount_cents: number | null;
  last_payment_at: Date | null;
  dias_atraso: number;
}

const SLOT = 'clone_barbearia_cirilo_ab12cd';

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    slot: SLOT,
    display_name: 'Barbearia do Cirilo',
    next_due_date: '2026-06-01',
    amount_cents: 8500,
    last_payment_at: new Date('2026-05-01T00:00:00Z'),
    dias_atraso: 10, // vencido há 10 dias (> GRACE_DAYS=3) => silenciado
    ...over,
  };
}

const OPTS = { overdueSilenceEnabled: true, cooldownMin: 1440, now: new Date() };

beforeEach(() => {
  vi.clearAllMocks();
  getState.mockResolvedValue(null); // sem cooldown anterior
  upsertState.mockResolvedValue(undefined);
  sendInternalAlert.mockResolvedValue({ sent: 1 });
  listBillingClonesForSilenceCheck.mockResolvedValue([]);
});

describe('evaluateOverdueSilence — decisão pura (paridade com o gate do router)', () => {
  it('PAGANTE + vencido além da carência -> silenciado', () => {
    expect(evaluateOverdueSilence(candidate({ dias_atraso: 4 }))).toEqual({
      silenced: true,
      diasAtraso: 4,
    });
  });

  it('exatamente na carência (dias = GRACE_DAYS) -> AINDA responde (não silenciado)', () => {
    expect(evaluateOverdueSilence(candidate({ dias_atraso: 3 })).silenced).toBe(false);
  });

  it('EM DIA (dias de atraso negativo) -> não silenciado', () => {
    expect(evaluateOverdueSilence(candidate({ dias_atraso: -5 })).silenced).toBe(false);
  });

  it('sem pagamento (trial/sintético) -> não silenciado mesmo vencido', () => {
    expect(evaluateOverdueSilence(candidate({ last_payment_at: null })).silenced).toBe(false);
  });

  it('sem valor (amount_cents 0/null) -> não é billing -> não silenciado', () => {
    expect(evaluateOverdueSilence(candidate({ amount_cents: 0 })).silenced).toBe(false);
    expect(evaluateOverdueSilence(candidate({ amount_cents: null })).silenced).toBe(false);
  });
});

describe('runBillingSilenceAlert — gate real (BILLING_OVERDUE_SILENCE)', () => {
  it('gate OFF -> NO-OP total (nem consulta o banco)', async () => {
    const r = await runBillingSilenceAlert({ ...OPTS, overdueSilenceEnabled: false });
    expect(r.skipped).toBe(true);
    expect(listBillingClonesForSilenceCheck).not.toHaveBeenCalled();
    expect(sendInternalAlert).not.toHaveBeenCalled();
  });
});

describe('runBillingSilenceAlert — caminho feliz (pagante silenciado)', () => {
  it('dispara 1 alerta interno e carimba o cooldown SÓ APÓS o envio', async () => {
    listBillingClonesForSilenceCheck.mockResolvedValue([candidate()]);

    const r = await runBillingSilenceAlert(OPTS);

    expect(r.silenced).toBe(1);
    expect(r.alerted).toBe(1);
    expect(sendInternalAlert).toHaveBeenCalledTimes(1);
    // A mensagem foi montada com os dados do clone (nome + slot + venc + dias).
    expect(msgBotSilenciadoInadimplencia).toHaveBeenCalledWith({
      displayName: 'Barbearia do Cirilo',
      slot: SLOT,
      nextDueDate: '2026-06-01',
      diasAtraso: 10,
    });
    // Carimbo do cooldown por slot (sem PII), APÓS o envio bem-sucedido.
    expect(upsertState).toHaveBeenCalledTimes(1);
    const stamp = upsertState.mock.calls[0][0];
    expect(stamp.checkKey).toBe(silenceCooldownKey(SLOT));
    expect(stamp.checkKey).toContain(SLOT);
    expect(stamp.lastAlertAt).toBe(OPTS.now);
    // Ordem: envio ANTES do carimbo (nunca marca "avisei" antes de entregar).
    expect(sendInternalAlert.mock.invocationCallOrder[0]).toBeLessThan(
      upsertState.mock.invocationCallOrder[0],
    );
  });

  it('usa o slot como rótulo quando não há display_name', async () => {
    listBillingClonesForSilenceCheck.mockResolvedValue([candidate({ display_name: null })]);
    await runBillingSilenceAlert(OPTS);
    expect(msgBotSilenciadoInadimplencia).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: SLOT }),
    );
  });
});

describe('runBillingSilenceAlert — cooldown por slot (não spamma todo ciclo)', () => {
  it('2º ciclo dentro da janela (avisado há 1h, cooldown 24h) -> NÃO repete', async () => {
    listBillingClonesForSilenceCheck.mockResolvedValue([candidate()]);
    getState.mockResolvedValue({
      check_key: silenceCooldownKey(SLOT),
      state: 'down',
      down_since: null,
      last_alert_at: new Date(OPTS.now.getTime() - 60 * 60_000), // 1h atrás
      alert_count: 1,
      pending_down_count: 0,
      updated_at: new Date(),
    });

    const r = await runBillingSilenceAlert(OPTS);

    expect(r.silenced).toBe(1);
    expect(r.cooldownSuppressed).toBe(1);
    expect(r.alerted).toBe(0);
    expect(sendInternalAlert).not.toHaveBeenCalled();
    expect(upsertState).not.toHaveBeenCalled();
  });

  it('janela de cooldown expirada (avisado há 25h) -> volta a alertar', async () => {
    listBillingClonesForSilenceCheck.mockResolvedValue([candidate()]);
    getState.mockResolvedValue({
      check_key: silenceCooldownKey(SLOT),
      state: 'down',
      down_since: null,
      last_alert_at: new Date(OPTS.now.getTime() - 25 * 60 * 60_000), // 25h atrás
      alert_count: 3,
      pending_down_count: 0,
      updated_at: new Date(),
    });

    const r = await runBillingSilenceAlert(OPTS);

    expect(r.alerted).toBe(1);
    expect(sendInternalAlert).toHaveBeenCalledTimes(1);
    // alert_count incrementa a partir do anterior.
    expect(upsertState.mock.calls[0][0].alertCount).toBe(4);
  });
});

describe('runBillingSilenceAlert — só PAGANTE, só silenciado', () => {
  it('mistura de clones: alerta SÓ o pagante silenciado (ignora em-dia e trial)', async () => {
    listBillingClonesForSilenceCheck.mockResolvedValue([
      candidate({ slot: 'clone_pagante_silenciado', dias_atraso: 9 }), // ALERTA
      candidate({ slot: 'clone_em_dia', dias_atraso: -8 }), // em dia -> não
      candidate({ slot: 'clone_trial', last_payment_at: null, dias_atraso: 12 }), // trial -> não
    ]);

    const r = await runBillingSilenceAlert(OPTS);

    expect(r.scanned).toBe(3);
    expect(r.silenced).toBe(1);
    expect(r.alerted).toBe(1);
    expect(sendInternalAlert).toHaveBeenCalledTimes(1);
    expect(msgBotSilenciadoInadimplencia).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'clone_pagante_silenciado' }),
    );
  });
});

describe('runBillingSilenceAlert — envio falho e fail-safe', () => {
  it('envio não entregue (sent=0) -> NÃO carimba cooldown (re-tenta no próximo ciclo)', async () => {
    listBillingClonesForSilenceCheck.mockResolvedValue([candidate()]);
    sendInternalAlert.mockResolvedValue({ sent: 0 });

    const r = await runBillingSilenceAlert(OPTS);

    expect(r.silenced).toBe(1);
    expect(r.alerted).toBe(0);
    expect(r.sendFailed).toBe(1);
    expect(upsertState).not.toHaveBeenCalled(); // não marca "avisei" sem ter saído
  });

  it('FAIL-CLOSED: erro ao ler o estado -> pula o slot, não envia, não lança', async () => {
    listBillingClonesForSilenceCheck.mockResolvedValue([candidate()]);
    getState.mockRejectedValue(new Error('db down'));

    const r = await runBillingSilenceAlert(OPTS);

    expect(r.stateErrors).toBe(1);
    expect(r.alerted).toBe(0);
    expect(sendInternalAlert).not.toHaveBeenCalled();
  });

  it('falha global na varredura -> NUNCA lança (worker segue)', async () => {
    listBillingClonesForSilenceCheck.mockRejectedValue(new Error('boom'));
    await expect(runBillingSilenceAlert(OPTS)).resolves.toMatchObject({
      skipped: false,
      alerted: 0,
    });
  });

  it('carimbo do cooldown falha após envio OK -> conta como alertado (não reverte a entrega)', async () => {
    listBillingClonesForSilenceCheck.mockResolvedValue([candidate()]);
    upsertState.mockRejectedValue(new Error('db blip'));

    const r = await runBillingSilenceAlert(OPTS);

    expect(r.alerted).toBe(1); // já entregou; falha de carimbo não regride o envio
    expect(sendInternalAlert).toHaveBeenCalledTimes(1);
  });
});

describe('silenceCooldownKey — LGPD (sem telefone/CPF)', () => {
  it('chave usa o slot, nunca telefone', () => {
    expect(silenceCooldownKey('clone_x')).toBe('billsilence:clone_x');
    expect(silenceCooldownKey('clone_x')).not.toMatch(/\d{8,}/);
  });
});
