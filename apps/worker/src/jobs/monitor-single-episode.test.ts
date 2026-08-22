/**
 * Regressão: cada episódio contínuo DOWN gera só um alerta, independente do tempo.
 * O monitor segue registrando DOWN e ainda envia RECUPERADO; somente o lembrete
 * recorrente foi removido.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  poolConnect: vi.fn(),
  sendText: vi.fn(),
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
  },
}));

vi.mock('@startap/integrations', () => ({ waha: { sendText: mocks.sendText } }));
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
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { runMonitor } from './monitor.js';

const SESSION = 'clone_meduzza';

function stateFor(session: string, overrides: Record<string, unknown> = {}) {
  return {
    check_key: `waha:${session}`,
    state: 'up' as const,
    down_since: null,
    last_alert_at: null,
    alert_count: 0,
    pending_down_count: 0,
    updated_at: new Date(),
    ...overrides,
  };
}

function state(overrides: Record<string, unknown> = {}) {
  return stateFor(SESSION, overrides);
}

function setWahaStatuses(statuses: Array<{ name: string; status: 'FAILED' | 'WORKING' }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => statuses }),
  );
}

function setWahaStatus(status: 'FAILED' | 'WORKING') {
  setWahaStatuses([{ name: SESSION, status }]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-21T12:00:00.000Z'));
  vi.clearAllMocks();
  mocks.getConfig.mockResolvedValue({
    enabled: true,
    sender_slot: 'alertas',
    check_waha: true,
    check_health: false,
    cooldown_min: 30,
  });
  mocks.getSenderSession.mockResolvedValue('ALERTAS');
  mocks.listEnabledRecipients.mockResolvedValue([
    { id: 1, phone: '5535999990011', label: null, enabled: true, created_at: new Date() },
  ]);
  mocks.reserveGlobalSend.mockResolvedValue({ allowed: true, sentInWindow: 1 });
  mocks.claimDownTransition.mockResolvedValue(true);
  mocks.suppressClaimedDownTransition.mockResolvedValue(true);
  mocks.upsertState.mockResolvedValue(undefined);
  mocks.sendText.mockResolvedValue(undefined);
  mocks.listMonitoredSessions.mockResolvedValue([
    { sessao: SESSION, label: 'Barbearia Meduzza', slot: SESSION },
  ]);
  mocks.poolConnect.mockResolvedValue({
    query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    release: vi.fn(),
  });
});

afterEach(() => vi.useRealTimers());

describe('monitor — alerta único por episódio de queda', () => {
  it('continua DOWN por dias: não reenvia nem carimba outro alerta', async () => {
    setWahaStatus('FAILED');
    mocks.listStates.mockResolvedValue([
      state({
        state: 'down',
        down_since: new Date('2026-08-11T12:00:00.000Z'),
        last_alert_at: new Date('2026-08-11T12:00:00.000Z'),
        alert_count: 1,
      }),
    ]);

    const result = await runMonitor();

    expect(result.down).toBe(1);
    expect(result.sent).toBe(0);
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(mocks.upsertState).not.toHaveBeenCalledWith(
      expect.objectContaining({ checkKey: `waha:${SESSION}` }),
    );
  });

  it('down, up, down: envia CAIU uma vez em cada novo episódio e mantém RECUPERADO', async () => {
    setWahaStatus('FAILED');
    mocks.listStates.mockResolvedValueOnce([state({ pending_down_count: 1 })]);
    await runMonitor();

    vi.advanceTimersByTime(2 * 60_000);
    setWahaStatus('WORKING');
    mocks.listStates.mockResolvedValueOnce([
      state({
        state: 'down',
        down_since: new Date('2026-08-21T12:00:00.000Z'),
        last_alert_at: new Date('2026-08-21T12:00:00.000Z'),
        alert_count: 1,
      }),
    ]);
    await runMonitor();

    vi.advanceTimersByTime(2 * 60_000);
    setWahaStatus('FAILED');
    mocks.listStates.mockResolvedValueOnce([state({ pending_down_count: 1 })]);
    await runMonitor();

    const texts = mocks.sendText.mock.calls.map(([input]) => (input as { texto: string }).texto);
    expect(texts.filter((text) => text.startsWith('🔴 CAIU:'))).toHaveLength(2);
    expect(texts.filter((text) => text.startsWith('🟢 RECUPERADO:'))).toHaveLength(1);
    expect(texts.some((text) => text.includes('AINDA CAÍDO'))).toBe(false);
  });

  it('remetente indisponível suprime a queda e a reconexão não drena o episódio histórico', async () => {
    mocks.listMonitoredSessions.mockResolvedValue([
      { sessao: SESSION, label: 'Barbearia Meduzza', slot: SESSION },
      { sessao: 'ALERTAS', label: 'Sessão de alertas', slot: null },
    ]);

    setWahaStatuses([
      { name: SESSION, status: 'FAILED' },
      { name: 'ALERTAS', status: 'FAILED' },
    ]);
    mocks.listStates.mockResolvedValueOnce([
      state({ pending_down_count: 1 }),
      stateFor('ALERTAS', { pending_down_count: 1 }),
    ]);
    await runMonitor();
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(mocks.suppressClaimedDownTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        checkKey: `waha:${SESSION}`,
      }),
    );

    vi.advanceTimersByTime(2 * 60_000);
    setWahaStatuses([
      { name: SESSION, status: 'FAILED' },
      { name: 'ALERTAS', status: 'WORKING' },
    ]);
    mocks.listStates.mockResolvedValueOnce([
      state({
        state: 'down',
        down_since: new Date('2026-08-21T12:00:00.000Z'),
        last_alert_at: null,
        alert_count: 0,
      }),
      stateFor('ALERTAS', {
        state: 'down',
        down_since: new Date('2026-08-21T12:00:00.000Z'),
        last_alert_at: null,
        alert_count: 0,
      }),
    ]);
    await runMonitor();
    expect(mocks.sendText).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2 * 60_000);
    setWahaStatuses([
      { name: SESSION, status: 'WORKING' },
      { name: 'ALERTAS', status: 'WORKING' },
    ]);
    mocks.listStates.mockResolvedValueOnce([
      state({
        state: 'down',
        down_since: new Date('2026-08-21T12:00:00.000Z'),
        last_alert_at: null,
        alert_count: 0,
      }),
      stateFor('ALERTAS'),
    ]);
    await runMonitor();

    vi.advanceTimersByTime(2 * 60_000);
    setWahaStatuses([
      { name: SESSION, status: 'FAILED' },
      { name: 'ALERTAS', status: 'WORKING' },
    ]);
    mocks.listStates.mockResolvedValueOnce([state({ pending_down_count: 1 }), stateFor('ALERTAS')]);
    await runMonitor();

    const texts = mocks.sendText.mock.calls.map(([input]) => (input as { texto: string }).texto);
    expect(texts.filter((text) => text.startsWith('🔴 CAIU:'))).toHaveLength(1);
  });

  it('WAHA observado WORKING mas 422 do remetente suprime o episódio e não o drena ao reconectar', async () => {
    mocks.listMonitoredSessions.mockResolvedValue([
      { sessao: SESSION, label: 'Barbearia Meduzza', slot: SESSION },
      { sessao: 'ALERTAS', label: 'Sessão de alertas', slot: null },
    ]);
    setWahaStatuses([
      { name: SESSION, status: 'FAILED' },
      { name: 'ALERTAS', status: 'WORKING' },
    ]);
    mocks.listStates.mockResolvedValueOnce([state({ pending_down_count: 1 }), stateFor('ALERTAS')]);
    mocks.sendText.mockRejectedValueOnce(
      new Error('WAHA /api/sendText -> HTTP 422: Session status is not WORKING'),
    );
    await runMonitor();
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
    expect(mocks.suppressClaimedDownTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        checkKey: `waha:${SESSION}`,
      }),
    );

    mocks.listStates.mockResolvedValueOnce([
      state({ state: 'down', down_since: new Date(), last_alert_at: null, alert_count: 0 }),
      stateFor('ALERTAS'),
    ]);
    await runMonitor();
    expect(mocks.sendText).toHaveBeenCalledTimes(1);

    setWahaStatuses([
      { name: SESSION, status: 'WORKING' },
      { name: 'ALERTAS', status: 'WORKING' },
    ]);
    mocks.listStates.mockResolvedValueOnce([
      state({ state: 'down', down_since: new Date(), last_alert_at: null, alert_count: 0 }),
      stateFor('ALERTAS'),
    ]);
    await runMonitor();

    setWahaStatuses([
      { name: SESSION, status: 'FAILED' },
      { name: 'ALERTAS', status: 'WORKING' },
    ]);
    mocks.listStates.mockResolvedValueOnce([state({ pending_down_count: 1 }), stateFor('ALERTAS')]);
    await runMonitor();
    expect(mocks.sendText).toHaveBeenCalledTimes(2);
  });

  it('dois ciclos concorrentes recebem um único claim e fazem um único envio', async () => {
    setWahaStatus('FAILED');
    mocks.listStates.mockResolvedValue([state({ pending_down_count: 1 })]);
    mocks.claimDownTransition.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await Promise.all([runMonitor(), runMonitor()]);

    expect(mocks.claimDownTransition).toHaveBeenCalledTimes(2);
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
  });
});
