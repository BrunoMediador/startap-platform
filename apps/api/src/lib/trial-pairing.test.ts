import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logFlowEvent: vi.fn(),
  getTrialInfoBySession: vi.fn(),
  findByPhoneHmac: vi.fn(),
  startTrial: vi.fn(),
  blockTrial: vi.fn(),
  markExempt: vi.fn(),
  consumeAdditionalNumber: vi.fn(),
  countConsumedBySlot: vi.fn(),
  withTrialSlotLock: vi.fn(),
  getSessionStatus: vi.fn(),
}));

vi.mock('@startap/db', () => ({
  flowExecutionLog: { logFlowEvent: mocks.logFlowEvent },
  trialLedger: {
    getTrialInfoBySession: mocks.getTrialInfoBySession,
    findByPhoneHmac: mocks.findByPhoneHmac,
    startTrial: mocks.startTrial,
    blockTrial: mocks.blockTrial,
    markExempt: mocks.markExempt,
    consumeAdditionalNumber: mocks.consumeAdditionalNumber,
    countConsumedBySlot: mocks.countConsumedBySlot,
    withTrialSlotLock: mocks.withTrialSlotLock,
  },
}));

vi.mock('@startap/integrations', () => ({
  waha: {
    sessions: { getSessionStatus: mocks.getSessionStatus },
  },
}));

import type { WahaWebhookBody } from '@startap/core/types';
import { handleSessionStatusEvent } from './trial-pairing.js';

const OPTS = { executionId: 'exec-1', startedAt: Date.now() };

function statusBody(status: string, meId?: string | null): WahaWebhookBody {
  return {
    event: 'session.status',
    session: 'clone_barbearia_x_ab12cd',
    payload: { status, me: meId !== undefined ? { id: meId } : undefined },
  } as unknown as WahaWebhookBody;
}

/** Formato REAL do NOWEB 2026.3.2: `me` no TOPO do envelope, irmão de payload
 * (spike docs/missoes/spike-waha-meid-customheaders.md). */
function envelopeBody(status: string, meId: string): WahaWebhookBody {
  return {
    event: 'session.status',
    session: 'clone_barbearia_x_ab12cd',
    me: { id: meId },
    payload: { status },
  } as unknown as WahaWebhookBody;
}

const TRIAL_CLONE = {
  slot: 'clone_barbearia_x_ab12cd',
  trial_status: 'awaiting' as const,
  cliente_telefone: '5531999998842',
  waha_sessao: 'clone_barbearia_x_ab12cd',
  next_due_date: null,
  amount_cents: 9999,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('TRIAL_PHONE_PEPPER', 'pepper-de-teste-com-32-caracteres!');
  mocks.logFlowEvent.mockResolvedValue(null);
  // Default: lock adquirido — executa a decisão (pass-through, como em prod sem
  // concorrência). Teste de lock ocupado sobrescreve com { acquired: false }.
  mocks.withTrialSlotLock.mockImplementation(async (_slot: string, fn: () => Promise<unknown>) => ({
    acquired: true,
    result: await fn(),
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('handleSessionStatusEvent', () => {
  it('ignora eventos que não são WORKING', async () => {
    const r = await handleSessionStatusEvent(statusBody('SCAN_QR_CODE'), OPTS);
    expect(r.status).toBe('ignored:session-status');
    expect(mocks.getTrialInfoBySession).not.toHaveBeenCalled();
  });

  it('NOOP absoluto para clone com trial_status=none (Cirilo/manuais intactos)', async () => {
    mocks.getTrialInfoBySession.mockResolvedValue({ ...TRIAL_CLONE, trial_status: 'none' });
    const r = await handleSessionStatusEvent(statusBody('WORKING', '5531999998842@c.us'), OPTS);
    expect(r.status).toBe('ignored:trial-none');
    expect(mocks.startTrial).not.toHaveBeenCalled();
    expect(mocks.blockTrial).not.toHaveBeenCalled();
  });

  it('número virgem + awaiting => inicia trial (consome ledger + D+10)', async () => {
    mocks.getTrialInfoBySession.mockResolvedValue(TRIAL_CLONE);
    mocks.findByPhoneHmac.mockResolvedValue(null);
    mocks.startTrial.mockResolvedValue({ nextDueDate: '2026-06-21' });

    const r = await handleSessionStatusEvent(statusBody('WORKING', '5531999998842@c.us'), OPTS);

    expect(r.status).toBe('ok:trial-started');
    expect(mocks.startTrial).toHaveBeenCalledWith(
      expect.objectContaining({
        slot: TRIAL_CLONE.slot,
        pairedPhone: '553199998842', // canônico (sem o 9º dígito)
      }),
    );
    // LGPD: hint nos metadados, nunca o número completo.
    const callArg = mocks.startTrial.mock.calls[0]?.[0] as { phoneHint: string };
    expect(callArg.phoneHint).not.toContain('99998842');
  });

  it('número já consumido em OUTRO clone => bloqueia (sem iniciar trial)', async () => {
    mocks.getTrialInfoBySession.mockResolvedValue(TRIAL_CLONE);
    mocks.findByPhoneHmac.mockResolvedValue({
      id: 1,
      phone_hmac: 'x',
      phone_hint: '+55 31 •••••-••42',
      status: 'consumed',
      slot: 'clone_outro_negocio_zz99',
      consumed_at: new Date(),
      created_at: new Date(),
      notes: null,
    });

    const r = await handleSessionStatusEvent(statusBody('WORKING', '5531999998842@c.us'), OPTS);

    expect(r.status).toBe('ok:trial-blocked');
    expect(mocks.blockTrial).toHaveBeenCalledWith({ slot: TRIAL_CLONE.slot });
    expect(mocks.startTrial).not.toHaveBeenCalled();
  });

  it('mesmo número re-pareando no MESMO clone => no-op idempotente', async () => {
    mocks.getTrialInfoBySession.mockResolvedValue({ ...TRIAL_CLONE, trial_status: 'active' });
    mocks.findByPhoneHmac.mockResolvedValue({
      id: 1,
      phone_hmac: 'x',
      phone_hint: '+55 31 •••••-••42',
      status: 'consumed',
      slot: TRIAL_CLONE.slot,
      consumed_at: new Date(),
      created_at: new Date(),
      notes: null,
    });

    const r = await handleSessionStatusEvent(statusBody('WORKING', '5531999998842@c.us'), OPTS);

    expect(r.status).toBe('ok:trial-already-counted');
    expect(mocks.startTrial).not.toHaveBeenCalled();
    expect(mocks.blockTrial).not.toHaveBeenCalled();
  });

  it('número exempt (whitelist do time) => segue normal SEM consumir', async () => {
    mocks.getTrialInfoBySession.mockResolvedValue(TRIAL_CLONE);
    mocks.findByPhoneHmac.mockResolvedValue({
      id: 2,
      phone_hmac: 'y',
      phone_hint: '+55 31 •••••-••42',
      status: 'exempt',
      slot: null,
      consumed_at: null,
      created_at: new Date(),
      notes: 'time interno',
    });

    const r = await handleSessionStatusEvent(statusBody('WORKING', '5531999998842@c.us'), OPTS);

    expect(r.status).toBe('ok:trial-exempt');
    expect(mocks.markExempt).toHaveBeenCalled();
    expect(mocks.startTrial).not.toHaveBeenCalled();
  });

  it('me.id divergente do cadastro => consome pelo me.id (re-vínculo, doc 020)', async () => {
    mocks.getTrialInfoBySession.mockResolvedValue({
      ...TRIAL_CLONE,
      cliente_telefone: '5531888887777', // cadastrou X...
    });
    mocks.findByPhoneHmac.mockResolvedValue(null);
    mocks.startTrial.mockResolvedValue({ nextDueDate: '2026-06-21' });

    // ...pareou Y (via QR, por exemplo).
    const r = await handleSessionStatusEvent(statusBody('WORKING', '5531999998842@c.us'), OPTS);

    expect(r.status).toBe('ok:trial-started');
    expect(mocks.startTrial).toHaveBeenCalledWith(
      expect.objectContaining({
        pairedPhone: '553199998842',
        notes: expect.stringContaining('re-vinculado'),
      }),
    );
  });

  it('troca de número no trial ativo: 2º número consome junto; 3º bloqueia', async () => {
    mocks.getTrialInfoBySession.mockResolvedValue({ ...TRIAL_CLONE, trial_status: 'active' });
    mocks.findByPhoneHmac.mockResolvedValue(null);

    mocks.countConsumedBySlot.mockResolvedValue(1);
    let r = await handleSessionStatusEvent(statusBody('WORKING', '5531777776666@c.us'), OPTS);
    expect(r.status).toBe('ok:trial-number-swapped');
    expect(mocks.consumeAdditionalNumber).toHaveBeenCalled();

    mocks.countConsumedBySlot.mockResolvedValue(2);
    r = await handleSessionStatusEvent(statusBody('WORKING', '5531666665555@c.us'), OPTS);
    expect(r.status).toBe('ok:trial-blocked');
    expect(mocks.blockTrial).toHaveBeenCalledWith(
      expect.objectContaining({ slot: TRIAL_CLONE.slot }),
    );
  });

  it('pepper ausente: LOGA e ignora — webhook NUNCA crasha (lição #247)', async () => {
    vi.stubEnv('TRIAL_PHONE_PEPPER', '');
    mocks.getTrialInfoBySession.mockResolvedValue(TRIAL_CLONE);

    const r = await handleSessionStatusEvent(statusBody('WORKING', '5531999998842@c.us'), OPTS);

    expect(r.status).toBe('ignored:no-pepper');
    expect(mocks.startTrial).not.toHaveBeenCalled();
  });

  // ── Origem do me.id (spike NOWEB 2026.3.2: `me` vem no TOPO do envelope) ────
  it('me.id no TOPO do envelope (formato real NOWEB) => usado direto, SEM GET extra', async () => {
    mocks.getTrialInfoBySession.mockResolvedValue(TRIAL_CLONE);
    mocks.findByPhoneHmac.mockResolvedValue(null);
    mocks.startTrial.mockResolvedValue({ nextDueDate: '2026-06-21' });

    const r = await handleSessionStatusEvent(envelopeBody('WORKING', '5531999998842@c.us'), OPTS);

    expect(r.status).toBe('ok:trial-started');
    expect(mocks.getSessionStatus).not.toHaveBeenCalled();
    expect(mocks.startTrial).toHaveBeenCalledWith(
      expect.objectContaining({ pairedPhone: '553199998842' }),
    );
  });

  it('me.id só dentro do payload (compat outras engines) => usado, SEM GET extra', async () => {
    mocks.getTrialInfoBySession.mockResolvedValue(TRIAL_CLONE);
    mocks.findByPhoneHmac.mockResolvedValue(null);
    mocks.startTrial.mockResolvedValue({ nextDueDate: '2026-06-21' });

    const r = await handleSessionStatusEvent(statusBody('WORKING', '5531999998842@c.us'), OPTS);

    expect(r.status).toBe('ok:trial-started');
    expect(mocks.getSessionStatus).not.toHaveBeenCalled();
  });

  it('sem me.id em lugar nenhum => fallback GET /sessions resolve e inicia trial', async () => {
    mocks.getTrialInfoBySession.mockResolvedValue(TRIAL_CLONE);
    mocks.findByPhoneHmac.mockResolvedValue(null);
    mocks.startTrial.mockResolvedValue({ nextDueDate: '2026-06-21' });
    mocks.getSessionStatus.mockResolvedValue({ me: { id: '5531999998842@c.us' } });

    const r = await handleSessionStatusEvent(statusBody('WORKING'), OPTS);

    expect(r.status).toBe('ok:trial-started');
    expect(mocks.getSessionStatus).toHaveBeenCalledWith(TRIAL_CLONE.waha_sessao, {
      timeoutMs: 8000,
    });
  });

  it('payload sem me.id: busca via GET /sessions; WAHA fora => ignora e tenta depois', async () => {
    mocks.getTrialInfoBySession.mockResolvedValue(TRIAL_CLONE);
    mocks.getSessionStatus.mockRejectedValue(new Error('timeout'));

    const r = await handleSessionStatusEvent(statusBody('WORKING'), OPTS);

    expect(r.status).toBe('ignored:no-me-id');
    expect(mocks.getSessionStatus).toHaveBeenCalledWith(TRIAL_CLONE.waha_sessao, {
      timeoutMs: 8000,
    });
  });

  it('erro inesperado de DB vira error:trial-hook (2xx pro WAHA, nunca lança)', async () => {
    mocks.getTrialInfoBySession.mockRejectedValue(new Error('db down'));
    const r = await handleSessionStatusEvent(statusBody('WORKING', '5531999998842@c.us'), OPTS);
    expect(r.status).toBe('error:trial-hook');
  });

  // ── Race do ledger (security review PR #268): decisão serializada por slot ──
  it('lock do slot ocupado (evento concorrente) => ignora SEM consumir nada', async () => {
    mocks.getTrialInfoBySession.mockResolvedValue(TRIAL_CLONE);
    mocks.withTrialSlotLock.mockResolvedValue({ acquired: false });

    const r = await handleSessionStatusEvent(statusBody('WORKING', '5531999998842@c.us'), OPTS);

    expect(r.status).toBe('ignored:concurrent-event');
    expect(mocks.withTrialSlotLock).toHaveBeenCalledWith(TRIAL_CLONE.slot, expect.any(Function));
    expect(mocks.startTrial).not.toHaveBeenCalled();
    expect(mocks.blockTrial).not.toHaveBeenCalled();
    expect(mocks.consumeAdditionalNumber).not.toHaveBeenCalled();
  });

  it('a decisão RE-LÊ o estado dentro do lock (leitura pré-lock pode estar velha)', async () => {
    // Pré-lock: awaiting. Dentro do lock (fresh): outro evento já iniciou o trial
    // e o número já está contado pro MESMO clone => no-op, sem duplo consumo.
    mocks.getTrialInfoBySession
      .mockResolvedValueOnce(TRIAL_CLONE)
      .mockResolvedValueOnce({ ...TRIAL_CLONE, trial_status: 'active' });
    mocks.findByPhoneHmac.mockResolvedValue({
      id: 1,
      phone_hmac: 'x',
      phone_hint: '+55 31 •••••-••42',
      status: 'consumed',
      slot: TRIAL_CLONE.slot,
      consumed_at: new Date(),
      created_at: new Date(),
      notes: null,
    });

    const r = await handleSessionStatusEvent(statusBody('WORKING', '5531999998842@c.us'), OPTS);

    expect(r.status).toBe('ok:trial-already-counted');
    expect(mocks.getTrialInfoBySession).toHaveBeenCalledTimes(2);
    expect(mocks.startTrial).not.toHaveBeenCalled();
  });
});
