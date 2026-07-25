/**
 * Testes do alerta interno de TRIAL prestes a expirar com bot DESLIGADO pelo dono (SCRUM-125).
 *
 * `@startap/db` (alerts + clientBilling) e `@startap/integrations` (internalAlert) são MOCKADOS —
 * sem banco nem WAHA. O job só ORQUESTRA (decisão de risco + cooldown + envio); a query
 * (listTrialOwnerPausedCandidates) e a copy (msgTrialOwnerPausado, testada em internal-alert) ficam
 * fora do escopo aqui.
 *
 * Cobre o brief do card:
 *  - trial owner-paused há dias + perto do vencimento -> 1 alerta; 2º ciclo no cooldown -> NÃO repete;
 *  - pausado há POUCO (< minPausedDays) -> nenhum alerta;
 *  - vencimento FORA da janela -> nenhum alerta;
 *  - já-vencido (dias_ate_vencer <= 0) -> alerta (churn no relógio);
 *  - envio falho (sent=0) -> NÃO carimba cooldown (re-tenta);
 *  - fail-safe: erro de leitura de estado -> pula o slot (fail-closed), nunca lança;
 *  - LGPD: a chave de cooldown usa slot (sem PII).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getState = vi.fn();
const upsertState = vi.fn();
const listTrialOwnerPausedCandidates = vi.fn();
const sendInternalAlert = vi.fn();
const msgTrialOwnerPausado = vi.fn(
  (i: {
    displayName: string;
    slot: string;
    nextDueDate: string;
    diasAteVencer: number;
    diasPausado: number;
  }) =>
    `TRIAL-RISCO ${i.displayName} slot=${i.slot} venc=${i.nextDueDate} ate=${i.diasAteVencer} pausa=${i.diasPausado}`,
);

vi.mock('@startap/db', () => ({
  alerts: { getState, upsertState },
  clientBilling: { listTrialOwnerPausedCandidates },
}));

vi.mock('@startap/integrations', () => ({
  internalAlert: { sendInternalAlert, msgTrialOwnerPausado },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { runTrialOwnerPauseAlert, evaluateTrialAtRisk, trialPauseCooldownKey } = await import(
  './trial-owner-pause-alert.js'
);

interface Candidate {
  slot: string;
  display_name: string | null;
  next_due_date: string | null;
  last_payment_at: Date | null;
  suspended_at: Date | null;
  dias_ate_vencer: number;
  dias_pausado: number;
}

const SLOT = 'clone_meduzza_barbearia_q23psc';

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    slot: SLOT,
    display_name: 'Meduzza Barbearia',
    next_due_date: '2026-07-27',
    last_payment_at: null, // trial
    suspended_at: new Date('2026-07-20T22:52:00Z'),
    dias_ate_vencer: 2, // vence em 2 dias
    dias_pausado: 5, // dono pausou há 5 dias
    ...over,
  };
}

const OPTS = {
  minPausedDays: 2,
  dueWindowDays: 7,
  cooldownMin: 1440,
  now: new Date('2026-07-25T12:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  getState.mockResolvedValue(null); // sem alerta anterior por default
  upsertState.mockResolvedValue(undefined);
  sendInternalAlert.mockResolvedValue({ sent: 1 });
});

describe('trialPauseCooldownKey', () => {
  it('usa o slot, sem PII', () => {
    expect(trialPauseCooldownKey(SLOT)).toBe(`trialpause:${SLOT}`);
  });
});

describe('evaluateTrialAtRisk — decisão pura', () => {
  it('pausado há >= min E dentro da janela -> em risco', () => {
    expect(evaluateTrialAtRisk(candidate(), 2, 7)).toBe(true);
  });
  it('pausado há POUCO -> não', () => {
    expect(evaluateTrialAtRisk(candidate({ dias_pausado: 1 }), 2, 7)).toBe(false);
  });
  it('vencimento FORA da janela -> não', () => {
    expect(evaluateTrialAtRisk(candidate({ dias_ate_vencer: 30 }), 2, 7)).toBe(false);
  });
  it('já vencido (dias_ate_vencer <= 0) -> em risco', () => {
    expect(evaluateTrialAtRisk(candidate({ dias_ate_vencer: -3 }), 2, 7)).toBe(true);
  });
  it('sem next_due_date -> não (defensivo)', () => {
    expect(evaluateTrialAtRisk(candidate({ next_due_date: null }), 2, 7)).toBe(false);
  });
});

describe('runTrialOwnerPauseAlert', () => {
  it('trial em risco -> envia 1 alerta e carimba cooldown', async () => {
    listTrialOwnerPausedCandidates.mockResolvedValue([candidate()]);

    const r = await runTrialOwnerPauseAlert(OPTS);

    expect(r.scanned).toBe(1);
    expect(r.atRisk).toBe(1);
    expect(r.alerted).toBe(1);
    expect(sendInternalAlert).toHaveBeenCalledTimes(1);
    expect(upsertState).toHaveBeenCalledTimes(1);
    expect(upsertState.mock.calls[0][0]).toMatchObject({
      checkKey: `trialpause:${SLOT}`,
      lastAlertAt: OPTS.now,
    });
  });

  it('cooldown ativo (avisado há < janela) -> NÃO repete', async () => {
    listTrialOwnerPausedCandidates.mockResolvedValue([candidate()]);
    getState.mockResolvedValue({
      last_alert_at: new Date(OPTS.now.getTime() - 60 * 60_000), // 1h atrás (< 24h)
      alert_count: 1,
    });

    const r = await runTrialOwnerPauseAlert(OPTS);

    expect(r.atRisk).toBe(1);
    expect(r.cooldownSuppressed).toBe(1);
    expect(r.alerted).toBe(0);
    expect(sendInternalAlert).not.toHaveBeenCalled();
    expect(upsertState).not.toHaveBeenCalled();
  });

  it('cooldown expirado (> janela) -> re-alerta', async () => {
    listTrialOwnerPausedCandidates.mockResolvedValue([candidate()]);
    getState.mockResolvedValue({
      last_alert_at: new Date(OPTS.now.getTime() - 25 * 60 * 60_000), // 25h atrás (> 24h)
      alert_count: 1,
    });

    const r = await runTrialOwnerPauseAlert(OPTS);

    expect(r.alerted).toBe(1);
    expect(upsertState.mock.calls[0][0]).toMatchObject({ alertCount: 2 });
  });

  it('pausado há pouco -> nenhum alerta (não é candidato)', async () => {
    listTrialOwnerPausedCandidates.mockResolvedValue([candidate({ dias_pausado: 1 })]);

    const r = await runTrialOwnerPauseAlert(OPTS);

    expect(r.scanned).toBe(1);
    expect(r.atRisk).toBe(0);
    expect(sendInternalAlert).not.toHaveBeenCalled();
  });

  it('envio falho (sent=0) -> NÃO carimba cooldown (re-tenta no próximo ciclo)', async () => {
    listTrialOwnerPausedCandidates.mockResolvedValue([candidate()]);
    sendInternalAlert.mockResolvedValue({ sent: 0 });

    const r = await runTrialOwnerPauseAlert(OPTS);

    expect(r.sendFailed).toBe(1);
    expect(r.alerted).toBe(0);
    expect(upsertState).not.toHaveBeenCalled();
  });

  it('erro ao ler estado -> pula o slot (fail-closed), não lança', async () => {
    listTrialOwnerPausedCandidates.mockResolvedValue([candidate()]);
    getState.mockRejectedValue(new Error('db down'));

    const r = await runTrialOwnerPauseAlert(OPTS);

    expect(r.stateErrors).toBe(1);
    expect(r.alerted).toBe(0);
    expect(sendInternalAlert).not.toHaveBeenCalled();
  });

  it('erro global na varredura -> fail-safe, retorna resultado vazio sem lançar', async () => {
    listTrialOwnerPausedCandidates.mockRejectedValue(new Error('boom'));

    const r = await runTrialOwnerPauseAlert(OPTS);

    expect(r.scanned).toBe(0);
    expect(r.alerted).toBe(0);
  });
});
