/**
 * SCRUM-53 — o alerta INTERNO do monitor não pode ficar carimbado como "avisado" quando o envio
 * falhou. O carimbo (upsertState com last_alert_at/alert_count) acontece ANTES do send como lock
 * otimista contra ciclos concorrentes; se o send falha (sessão remetente ALERTAS caída etc.),
 * `applyTransition` DESFAZ o carimbo (restoreStateIfUnchanged) pra o próximo ciclo re-tentar —
 * sem pisar numa reserva mais nova de outro ciclo (o predicado do restore é o valor que ESTE
 * ciclo gravou). Cobre a transição up->down; checks já down permanecem silenciosos.
 *
 * Mesma fiação de mocks do monitor.test.ts + `restoreStateIfUnchanged`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  listEnabledRecipients: vi.fn(),
  getSenderSession: vi.fn(),
  listMonitoredSessions: vi.fn(),
  listStates: vi.fn(),
  reserveGlobalSend: vi.fn(),
  upsertState: vi.fn(),
  restoreStateIfUnchanged: vi.fn(),
  poolConnect: vi.fn(),
  sendText: vi.fn(),
  notifyClientDisconnect: vi.fn(),
}));

vi.mock('@startap/db', () => ({
  pool: { connect: mocks.poolConnect },
  alerts: {
    getConfig: mocks.getConfig,
    listEnabledRecipients: mocks.listEnabledRecipients,
    getSenderSession: mocks.getSenderSession,
    listMonitoredSessions: mocks.listMonitoredSessions,
    listStates: mocks.listStates,
    reserveGlobalSend: mocks.reserveGlobalSend,
    upsertState: mocks.upsertState,
    restoreStateIfUnchanged: mocks.restoreStateIfUnchanged,
  },
}));

vi.mock('@startap/integrations', () => ({
  waha: { sendText: mocks.sendText },
}));

vi.mock('./client-disconnect-notify.js', () => ({
  notifyClientDisconnect: mocks.notifyClientDisconnect,
}));

vi.mock('../config.js', () => ({
  config: {
    WAHA_URL: 'http://waha:3000',
    WAHA_API_KEY: 'k',
    ALERTS_API_HEALTH_URL: 'http://startap-api:3040/health',
    ALERTS_MAX_PER_WINDOW: 50,
    ALERTS_WINDOW_MIN: 30,
    // Flag ON: torna a checagem "up→down falho NÃO avisa o dono" LOAD-BEARING (senão o bloco de
    // notify nunca roda e a asserção clientNotified===0 seria vácua).
    CLIENT_DISCONNECT_ALERT_ENABLED: true,
  },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { runMonitor } from './monitor.js';

function recipient(id: number, phone: string) {
  return { id, phone, label: null, enabled: true, created_at: new Date() };
}

function pgUp() {
  mocks.poolConnect.mockResolvedValue({
    query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    release: vi.fn(),
  });
}

function stateRow(checkKey: string, overrides: Record<string, unknown> = {}) {
  return {
    check_key: checkKey,
    state: 'up' as const,
    down_since: null,
    last_alert_at: null,
    alert_count: 0,
    pending_down_count: 0,
    updated_at: new Date(),
    ...overrides,
  };
}

/** 1 poll down acumulado (pending=1): o 2º poll down confirma up->down. */
function wahaPending(sessao: string) {
  return stateRow(`waha:${sessao}`, { pending_down_count: 1 });
}

function stubWahaSessions(list: Array<{ name: string; status: string }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => list }),
  );
}

/** O que o ciclo carimbou no upsertState do check informado (pega o último). */
function lastStampFor(checkKey: string) {
  const call = [...mocks.upsertState.mock.calls]
    .reverse()
    .find((c) => (c[0] as { checkKey: string }).checkKey === checkKey);
  return call?.[0] as { state: string; lastAlertAt: Date; alertCount: number } | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getConfig.mockResolvedValue({
    enabled: true,
    sender_slot: 'alertas',
    check_waha: true,
    check_health: false,
    cooldown_min: 30,
  });
  mocks.getSenderSession.mockResolvedValue('ALERTAS');
  mocks.reserveGlobalSend.mockResolvedValue({ allowed: true, sentInWindow: 1 });
  mocks.upsertState.mockResolvedValue(undefined);
  mocks.restoreStateIfUnchanged.mockResolvedValue(true);
  mocks.notifyClientDisconnect.mockResolvedValue({ ok: true, sent: true });
  mocks.listEnabledRecipients.mockResolvedValue([recipient(1, '5535999990011')]);
  pgUp();
});

describe('monitor SCRUM-53 — carimbo NÃO fica consumido quando o envio falha DEFINITIVAMENTE', () => {
  // Falha DEFINITIVA (certeza de não-entrega): sessão FAILED -> WAHA recusa o /api/sendText com 422.
  const DEFINITIVE = new Error('WAHA /api/sendText -> HTTP 422: Session status is not WORKING');

  it('up->down + send FALHA DEFINITIVA (recipient rejeita) -> desfaz o carimbo e o ciclo seguinte re-tenta', async () => {
    stubWahaSessions([{ name: 'clone_seven_7', status: 'FAILED' }]);
    mocks.listMonitoredSessions.mockResolvedValue([
      { sessao: 'clone_seven_7', label: 'Seven 7 Barber', slot: 'clone_seven_7' },
    ]);
    mocks.listStates.mockResolvedValue([wahaPending('clone_seven_7')]);
    mocks.sendText.mockRejectedValue(DEFINITIVE);

    const r = await runMonitor();

    // Nada foi entregue; a falha foi contabilizada (sem derrubar o job).
    expect(r.sent).toBe(0);
    expect(r.sendErrors).toBeGreaterThanOrEqual(1);
    // Carimbou 'down' ANTES do envio (lock otimista)...
    const stamp = lastStampFor('waha:clone_seven_7');
    expect(stamp?.state).toBe('down');
    // ...e, como o envio falhou, compensou: restaurou pro estado anterior.
    expect(mocks.restoreStateIfUnchanged).toHaveBeenCalledTimes(1);
    const comp = mocks.restoreStateIfUnchanged.mock.calls[0][0];
    expect(comp.checkKey).toBe('waha:clone_seven_7');
    // Predicado do lock = o valor que ESTE ciclo gravou (só o dono desfaz).
    expect(comp.expect.state).toBe('down');
    expect(comp.expect.alertCount).toBe(1);
    expect(comp.expect.lastAlertAt).toBe(stamp?.lastAlertAt);
    // Volta a 'up' PRESERVANDO o pending anterior (=1): o próximo poll down re-confirma a queda.
    expect(comp.restore.state).toBe('up');
    expect(comp.restore.pendingDownCount).toBe(1);
  });

  it('up->down + send FALHA DEFINITIVA -> NÃO marca a transição como avisada (não avisa o dono do clone)', async () => {
    stubWahaSessions([{ name: 'clone_seven_7', status: 'FAILED' }]);
    mocks.listMonitoredSessions.mockResolvedValue([
      { sessao: 'clone_seven_7', label: 'Seven 7 Barber', slot: 'clone_seven_7' },
    ]);
    mocks.listStates.mockResolvedValue([wahaPending('clone_seven_7')]);
    mocks.sendText.mockRejectedValue(DEFINITIVE);

    const r = await runMonitor();

    // LOAD-BEARING (flag ON no mock): o aviso ao dono sairia pela MESMA sessão remetente (também
    // falharia) -> NÃO dispara na falha definitiva (justWentDown=false).
    expect(mocks.notifyClientDisconnect).not.toHaveBeenCalled();
    expect(r.clientNotified).toBe(0);
  });

  it('up->down + send AMBÍGUO (timeout) -> NÃO compensa (mantém carimbo) e SEGUE como transição avisada', async () => {
    stubWahaSessions([{ name: 'clone_seven_7', status: 'FAILED' }]);
    mocks.listMonitoredSessions.mockResolvedValue([
      { sessao: 'clone_seven_7', label: 'Seven 7 Barber', slot: 'clone_seven_7' },
    ]);
    mocks.listStates.mockResolvedValue([wahaPending('clone_seven_7')]);
    // Timeout do Promise.race: NÃO prova não-entrega (pode ter saído) -> mantém o carimbo (P2).
    mocks.sendText.mockRejectedValue(new Error('sendText timeout'));

    const r = await runMonitor();

    expect(r.sent).toBe(0); // nada CONFIRMADO como entregue
    // Ambíguo: NÃO reverte o carimbo (não re-tenta a cada ciclo -> não spamma).
    expect(mocks.restoreStateIfUnchanged).not.toHaveBeenCalled();
    // E segue como transição avisada (justWentDown=true) -> o aviso ao dono é TENTADO (o notify tem
    // cooldown+taxonomia próprios que evitam duplicar).
    expect(mocks.notifyClientDisconnect).toHaveBeenCalledTimes(1);
  });

  it('up->down + send OK -> NÃO compensa (carimbo legítimo permanece)', async () => {
    stubWahaSessions([{ name: 'clone_seven_7', status: 'FAILED' }]);
    mocks.listMonitoredSessions.mockResolvedValue([
      { sessao: 'clone_seven_7', label: 'Seven 7 Barber', slot: 'clone_seven_7' },
    ]);
    mocks.listStates.mockResolvedValue([wahaPending('clone_seven_7')]);
    mocks.sendText.mockResolvedValue(undefined);

    const r = await runMonitor();

    expect(r.sent).toBe(1);
    expect(mocks.restoreStateIfUnchanged).not.toHaveBeenCalled();
  });

  it('sem sessão remetente -> suprime terminalmente sem compensar para a reconexão', async () => {
    stubWahaSessions([{ name: 'clone_seven_7', status: 'FAILED' }]);
    mocks.getSenderSession.mockResolvedValue(null); // remetente ALERTAS não mapeado
    mocks.listMonitoredSessions.mockResolvedValue([
      { sessao: 'clone_seven_7', label: 'Seven 7 Barber', slot: 'clone_seven_7' },
    ]);
    mocks.listStates.mockResolvedValue([wahaPending('clone_seven_7')]);

    const r = await runMonitor();

    expect(r.sent).toBe(0);
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(mocks.restoreStateIfUnchanged).not.toHaveBeenCalled();
  });

  it('down->down, mesmo após 25h: não tenta novo envio nem mexe no carimbo do episódio', async () => {
    stubWahaSessions([{ name: 'clone_seven_7', status: 'FAILED' }]);
    mocks.listMonitoredSessions.mockResolvedValue([
      { sessao: 'clone_seven_7', label: 'Seven 7 Barber', slot: 'clone_seven_7' },
    ]);
    const downSince = new Date(Date.now() - 26 * 60 * 60_000); // caído há 26h
    const prevAlertAt = new Date(Date.now() - 25 * 60 * 60_000);
    mocks.listStates.mockResolvedValue([
      stateRow('waha:clone_seven_7', {
        state: 'down',
        down_since: downSince,
        last_alert_at: prevAlertAt,
        alert_count: 2,
      }),
    ]);
    const r = await runMonitor();

    expect(r.sent).toBe(0);
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(mocks.restoreStateIfUnchanged).not.toHaveBeenCalled();
  });
});

describe('monitor SCRUM-126 — 422 tardio (colado no SEND_TIMEOUT) classifica DEFINITIVA e desfaz o carimbo', () => {
  // Reproduz o incidente Cirilo: a sessão FAILED faz o WAHA responder 422, mas a resposta pousa
  // ~20ms DEPOIS do deadline de envio (10s). Antes do fix o timeout vencia a corrida e TODA falha
  // virava "ambígua": o carimbo ficava, o rollback (SCRUM-53) nunca rodava e o alerta se perdia em
  // silêncio (alert_count 1→4 sem NENHUMA entrega). Agora o grace deixa o 422 subir e ser
  // classificado por STATUS. Timers fake pra dirigir o deadline+grace de forma determinística.
  const SEND_TIMEOUT_MS = 10_000;
  const SEND_ERROR_GRACE_MS = 1_000; // SCRUM-140: espelha o valor real (era 3_000)

  function wireDownClone() {
    stubWahaSessions([{ name: 'clone_cirilo', status: 'FAILED' }]);
    mocks.listMonitoredSessions.mockResolvedValue([
      { sessao: 'clone_cirilo', label: 'Cirilo', slot: 'clone_cirilo' },
    ]);
    mocks.listStates.mockResolvedValue([wahaPending('clone_cirilo')]);
  }

  it('(a) WAHA responde 422 ~20ms APÓS o timeout → falha DEFINITIVA → rollback do carimbo (reenvia no próximo ciclo)', async () => {
    vi.useFakeTimers();
    try {
      wireDownClone();
      mocks.sendText.mockImplementation(
        () =>
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(new Error('WAHA /api/sendText -> HTTP 422: Session status is not WORKING')),
              SEND_TIMEOUT_MS + 20,
            ),
          ),
      );

      const promise = runMonitor();
      await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + SEND_ERROR_GRACE_MS + 50);
      const r = await promise;

      expect(r.sent).toBe(0);
      // ROLLBACK: o carimbo é desfeito → o próximo ciclo (2 min) re-tenta. Era EXATAMENTE isto que
      // não acontecia no incidente (o guard do SCRUM-53 ficava inerte porque a falha virava ambígua).
      expect(mocks.restoreStateIfUnchanged).toHaveBeenCalledTimes(1);
      const comp = mocks.restoreStateIfUnchanged.mock.calls[0][0];
      expect(comp.checkKey).toBe('waha:clone_cirilo');
      expect(comp.expect.state).toBe('down');
      // Falha definitiva → NÃO marca transição avisada → não avisa o dono por uma sessão que recusou.
      expect(mocks.notifyClientDisconnect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('(b) rede pendurada: sendText NUNCA responde → após deadline+grace segue AMBÍGUO → NÃO faz rollback (anti-duplicação intacto)', async () => {
    vi.useFakeTimers();
    try {
      wireDownClone();
      mocks.sendText.mockImplementation(() => new Promise(() => {})); // nunca assenta (rede caiu)

      const promise = runMonitor();
      await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + SEND_ERROR_GRACE_MS + 50);
      const r = await promise;

      expect(r.sent).toBe(0);
      // AMBÍGUO (pode ter saído): mantém o carimbo → NÃO re-tenta a cada ciclo (não duplica pra pagante).
      expect(mocks.restoreStateIfUnchanged).not.toHaveBeenCalled();
      // Segue como transição avisada (justWentDown=true) — o notify tem cooldown/taxonomia próprios.
      expect(mocks.notifyClientDisconnect).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
