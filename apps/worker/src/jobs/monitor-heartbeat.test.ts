/**
 * SCRUM-54 — heartbeat de liveness do job monitor.
 *
 * Antes o log "monitor cycle" só saía quando havia atividade (down>0) e nada persistia o tick;
 * com tudo saudável o worker ficava mudo e "quieto" era indistinguível de "travado" (causou um
 * restart desnecessário em 02/07). Este teste prova que TODO ciclo:
 *   (a) emite o log info 'monitor cycle' (mesmo down=0, sem atividade);
 *   (b) carimba last_cycle_at no estado __global__ (alerts.recordCycleHeartbeat) -> liveness
 *       verificável por SELECT.
 *
 * O logger é MOCKADO por um child ESTÁVEL (hoisted) pra capturar os info(). Demais deps
 * (alerts/waha/pool) mockadas como em monitor.test.ts + recordCycleHeartbeat.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  listEnabledRecipients: vi.fn(),
  getSenderSession: vi.fn(),
  listMonitoredSessions: vi.fn(),
  listStates: vi.fn(),
  reserveGlobalSend: vi.fn(),
  claimDownTransition: vi.fn(),
  suppressClaimedDownTransition: vi.fn(),
  upsertState: vi.fn(),
  recordCycleHeartbeat: vi.fn(),
  poolConnect: vi.fn(),
  sendText: vi.fn(),
  // child estável -> os spies sobrevivem entre chamadas de logger.child().
  logChild: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
    claimDownTransition: mocks.claimDownTransition,
    suppressClaimedDownTransition: mocks.suppressClaimedDownTransition,
    upsertState: mocks.upsertState,
    recordCycleHeartbeat: mocks.recordCycleHeartbeat,
  },
}));

vi.mock('@startap/integrations', () => ({
  waha: { sendText: mocks.sendText },
}));

vi.mock('../config.js', () => ({
  config: {
    WAHA_URL: 'http://waha:3000',
    WAHA_API_KEY: 'k',
    ALERTS_API_HEALTH_URL: 'http://startap-api:3040/health',
    ALERTS_MAX_PER_WINDOW: 50,
    ALERTS_WINDOW_MIN: 30,
    CLIENT_DISCONNECT_ALERT_ENABLED: false,
  },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => mocks.logChild },
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

function stubWahaSessions(list: Array<{ name: string; status: string }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => list }),
  );
}

/** Foi emitido um log info com a mensagem `msg`? */
function loggedCycle(msg: string): boolean {
  return mocks.logChild.info.mock.calls.some((c) => c[1] === msg);
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
  mocks.claimDownTransition.mockResolvedValue(true);
  mocks.suppressClaimedDownTransition.mockResolvedValue(true);
  mocks.listStates.mockResolvedValue([]);
  mocks.upsertState.mockResolvedValue(undefined);
  mocks.recordCycleHeartbeat.mockResolvedValue(undefined);
  mocks.sendText.mockResolvedValue(undefined);
  mocks.listEnabledRecipients.mockResolvedValue([recipient(1, '5535999990011')]);
  pgUp();
});

describe('runMonitor — heartbeat de liveness (SCRUM-54)', () => {
  it('ciclo SAUDÁVEL e quieto (down=0) AINDA loga "monitor cycle" + carimba last_cycle_at', async () => {
    // Sessão monitorada WORKING (up) + PG up -> nenhuma atividade (down=0, sent=0).
    stubWahaSessions([{ name: 'clone_seven_7', status: 'WORKING' }]);
    mocks.listMonitoredSessions.mockResolvedValue([
      { sessao: 'clone_seven_7', label: 'Seven 7 Barber', slot: 'clone_seven_7' },
    ]);

    const r = await runMonitor();

    expect(r.down).toBe(0);
    expect(r.sent).toBe(0);
    // (a) log de heartbeat sai mesmo sem atividade.
    expect(loggedCycle('monitor cycle')).toBe(true);
    // (b) last_cycle_at avança (liveness verificável por SELECT).
    expect(mocks.recordCycleHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('ciclo COM atividade (queda) também carimba o heartbeat (incondicional)', async () => {
    stubWahaSessions([{ name: 'clone_seven_7', status: 'FAILED' }]);
    mocks.listMonitoredSessions.mockResolvedValue([
      { sessao: 'clone_seven_7', label: 'Seven 7 Barber', slot: 'clone_seven_7' },
    ]);
    // pending=1 -> este 2º poll down confirma up->down (há atividade).
    mocks.listStates.mockResolvedValue([
      {
        check_key: 'waha:clone_seven_7',
        state: 'up',
        down_since: null,
        last_alert_at: null,
        alert_count: 0,
        pending_down_count: 1,
        updated_at: new Date(),
      },
    ]);

    const r = await runMonitor();

    expect(r.down).toBe(1);
    expect(loggedCycle('monitor cycle')).toBe(true);
    expect(mocks.recordCycleHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('toggle de banco OFF (skipped) loga o tick mas NÃO escreve estado (NO-OP barato)', async () => {
    mocks.getConfig.mockResolvedValue({
      enabled: false,
      sender_slot: 'alertas',
      check_waha: true,
      check_health: false,
      cooldown_min: 30,
    });

    const r = await runMonitor();

    expect(r.skipped).toBe(true);
    // Desligado NUNCA fica mudo: loga um tick distinto...
    expect(loggedCycle('monitor cycle (skipped: toggle off)')).toBe(true);
    // ...mas honra o NO-OP: não carimba estado nem lê WAHA/destinatários.
    expect(mocks.recordCycleHeartbeat).not.toHaveBeenCalled();
    expect(mocks.listMonitoredSessions).not.toHaveBeenCalled();
  });

  it('falha no heartbeat NÃO derruba o ciclo (fail-safe) — o log de vida ainda sai', async () => {
    stubWahaSessions([{ name: 'clone_seven_7', status: 'WORKING' }]);
    mocks.listMonitoredSessions.mockResolvedValue([
      { sessao: 'clone_seven_7', label: 'Seven 7 Barber', slot: 'clone_seven_7' },
    ]);
    mocks.recordCycleHeartbeat.mockRejectedValue(new Error('db blip'));

    const r = await runMonitor();

    // Retorna normal (não lança) e ainda emite a prova de vida por log.
    expect(r.skipped).toBe(false);
    expect(loggedCycle('monitor cycle')).toBe(true);
    expect(mocks.logChild.warn).toHaveBeenCalled();
  });
});
