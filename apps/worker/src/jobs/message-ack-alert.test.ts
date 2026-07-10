/**
 * Testes do alerta de ENTREGA falhando de outbound (SCRUM-58).
 *
 * `@startap/db` (alerts + outboundMessages) e `@startap/integrations` (internalAlert) são MOCKADOS —
 * sem banco nem WAHA. O job só ORQUESTRA: varre alertáveis, agrega por sessão, aplica cooldown,
 * envia e carimba. As queries (outbound-messages.test.ts) e a copy (internal-alert) ficam fora daqui.
 *
 * Cobre o brief do card:
 *  - nack terminal (463/ack -1) + preso → 1 alerta AGREGADO por sessão;
 *  - cooldown por sessão: 2º ciclo dentro da janela → NÃO repete;
 *  - read (DEVICE/READ) nunca entra na varredura (listAlertable já filtra) → 0 alerta;
 *  - envio falho (sent=0) → NÃO carimba (nem outbounds, nem cooldown) → re-tenta;
 *  - fail-safe: erro de leitura de estado → pula a sessão (fail-closed), nunca lança;
 *  - poda de retenção roda; agregação prioriza um ERROR como exemplo (LGPD: hint mascarado).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getState = vi.fn();
const upsertState = vi.fn();
const listAlertable = vi.fn();
const markAlertedForSession = vi.fn();
const pruneOldOutbound = vi.fn();
const sendInternalAlert = vi.fn();
const displayNameForSlot = vi.fn(async (s: string) => `Nome de ${s}`);
const msgOutboundNaoEntregue = vi.fn((i: Record<string, unknown>) => `ALERTA ${JSON.stringify(i)}`);

vi.mock('@startap/db', () => ({
  alerts: { getState, upsertState },
  outboundMessages: { listAlertable, markAlertedForSession, pruneOldOutbound },
}));

vi.mock('@startap/integrations', () => ({
  internalAlert: { sendInternalAlert, msgOutboundNaoEntregue, displayNameForSlot },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { runMessageAckAlert, aggregateBySession, ackCooldownKey } = await import(
  './message-ack-alert.js'
);

type Row = {
  message_id: string;
  session: string;
  slot: string | null;
  phone_hint: string;
  ack_status: 'ERROR' | 'PENDING' | 'SERVER' | 'DEVICE' | 'READ';
  ack_rank: number;
  ack_code: number | null;
  alerted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function row(over: Partial<Row> = {}): Row {
  return {
    message_id: 'm1',
    session: 'cirilo',
    slot: 'clone_cirilo',
    phone_hint: '+55 11 •••••-••88',
    ack_status: 'ERROR',
    ack_rank: -1,
    ack_code: -1,
    alerted_at: null,
    created_at: new Date('2026-07-08T00:00:00Z'),
    updated_at: new Date('2026-07-08T00:00:00Z'),
    ...over,
  };
}

const OPTS = {
  stuckMin: 5,
  cooldownMin: 360,
  maxPerRun: 200,
  retentionDays: 7,
  now: new Date('2026-07-08T12:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  getState.mockResolvedValue(null);
  upsertState.mockResolvedValue(undefined);
  listAlertable.mockResolvedValue([]);
  markAlertedForSession.mockResolvedValue(1);
  pruneOldOutbound.mockResolvedValue(0);
  sendInternalAlert.mockResolvedValue({ sent: 1 });
});

describe('aggregateBySession', () => {
  it('agrega por sessão, conta nack/preso, prioriza ERROR como exemplo', () => {
    const groups = aggregateBySession([
      row({ message_id: 'a', session: 'cirilo', ack_status: 'PENDING', phone_hint: 'H-PEND' }),
      row({ message_id: 'b', session: 'cirilo', ack_status: 'ERROR', phone_hint: 'H-ERR' }),
      row({
        message_id: 'c',
        session: 'lola',
        slot: null,
        ack_status: 'SERVER',
        phone_hint: 'H-L',
      }),
    ]);
    expect(groups).toHaveLength(2);
    const cirilo = groups.find((g) => g.session === 'cirilo');
    expect(cirilo).toMatchObject({ total: 2, nackTerminal: 1, presos: 1, sampleStatus: 'ERROR' });
    expect(cirilo?.sampleHint).toBe('H-ERR'); // prioriza o exemplo ERROR
    const lola = groups.find((g) => g.session === 'lola');
    expect(lola).toMatchObject({ slot: null, total: 1, nackTerminal: 0, presos: 1 });
  });
});

describe('runMessageAckAlert', () => {
  it('nada alertável → poda roda, 0 alerta', async () => {
    pruneOldOutbound.mockResolvedValue(3);
    const r = await runMessageAckAlert(OPTS);
    expect(r.pruned).toBe(3);
    expect(r.scanned).toBe(0);
    expect(r.alerted).toBe(0);
    expect(sendInternalAlert).not.toHaveBeenCalled();
  });

  it('nack terminal + preso na mesma sessão → 1 alerta AGREGADO + marca + carimba cooldown', async () => {
    listAlertable.mockResolvedValue([
      row({ message_id: 'a', ack_status: 'ERROR' }),
      row({ message_id: 'b', ack_status: 'SERVER' }),
    ]);
    const r = await runMessageAckAlert(OPTS);
    expect(r.sessions).toBe(1);
    expect(sendInternalAlert).toHaveBeenCalledTimes(1);
    expect(markAlertedForSession).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'cirilo', at: OPTS.now }),
    );
    expect(upsertState).toHaveBeenCalledWith(
      expect.objectContaining({ checkKey: ackCooldownKey('cirilo'), lastAlertAt: OPTS.now }),
    );
    expect(r.alerted).toBe(1);
    // stuckBefore = now - 5min.
    const passedStuck = (markAlertedForSession.mock.calls[0][0] as { stuckBefore: Date })
      .stuckBefore;
    expect(passedStuck.getTime()).toBe(OPTS.now.getTime() - 5 * 60_000);
  });

  it('cooldown ativo (avisado há < janela) → NÃO repete, NÃO marca', async () => {
    listAlertable.mockResolvedValue([row()]);
    getState.mockResolvedValue({
      last_alert_at: new Date(OPTS.now.getTime() - 60 * 60_000), // 1h atrás < 6h
      alert_count: 1,
    });
    const r = await runMessageAckAlert(OPTS);
    expect(r.cooldownSuppressed).toBe(1);
    expect(sendInternalAlert).not.toHaveBeenCalled();
    expect(markAlertedForSession).not.toHaveBeenCalled();
  });

  it('envio falho (sent=0) → NÃO carimba (nem outbounds, nem cooldown)', async () => {
    listAlertable.mockResolvedValue([row()]);
    sendInternalAlert.mockResolvedValue({ sent: 0 });
    const r = await runMessageAckAlert(OPTS);
    expect(r.sendFailed).toBe(1);
    expect(r.alerted).toBe(0);
    expect(markAlertedForSession).not.toHaveBeenCalled();
    expect(upsertState).not.toHaveBeenCalled();
  });

  it('erro ao ler estado → pula a sessão (fail-closed), nunca lança', async () => {
    listAlertable.mockResolvedValue([row()]);
    getState.mockRejectedValue(new Error('pg down'));
    const r = await runMessageAckAlert(OPTS);
    expect(r.stateErrors).toBe(1);
    expect(sendInternalAlert).not.toHaveBeenCalled();
  });

  it('sessão sem slot (Lola) usa o nome da sessão como display', async () => {
    listAlertable.mockResolvedValue([row({ session: 'STARTAP_AI_PROD', slot: null })]);
    await runMessageAckAlert(OPTS);
    expect(displayNameForSlot).not.toHaveBeenCalled();
    const arg = msgOutboundNaoEntregue.mock.calls[0][0] as {
      displayName: string;
      slot: string | null;
    };
    expect(arg.slot).toBeNull();
    expect(arg.displayName).toBe('STARTAP_AI_PROD');
  });

  it('falha global inesperada não lança (fail-safe)', async () => {
    listAlertable.mockRejectedValue(new Error('boom'));
    await expect(runMessageAckAlert(OPTS)).resolves.toMatchObject({ alerted: 0 });
  });
});
