/**
 * Prova que o intervalo de re-alerta SEGUE a env MONITOR_REALERT_HOURS (não um 24 hardcoded).
 *
 * Config MOCKADA com MONITOR_REALERT_HOURS=2 (2h): o re-alerta deve disparar APÓS 2h e ficar em
 * silêncio antes disso. Se o limiar estivesse chumbado em 24h, o caso de 3h NÃO re-alertaria —
 * este teste falharia. Mesma fiação de mocks do monitor.test.ts.
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
    upsertState: mocks.upsertState,
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
    MONITOR_REALERT_HOURS: 2, // override: 2h (não o default 24)
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

function stubWahaSessions(list: Array<{ name: string; status: string }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => list }),
  );
}

function confirmedDown(sessao: string, downAgoMin: number, lastAlertAgoMin: number) {
  return {
    check_key: `waha:${sessao}`,
    state: 'down' as const,
    down_since: new Date(Date.now() - downAgoMin * 60_000),
    last_alert_at: new Date(Date.now() - lastAlertAgoMin * 60_000),
    alert_count: 1,
    pending_down_count: 0,
    updated_at: new Date(),
  };
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
  mocks.sendText.mockResolvedValue(undefined);
  mocks.listMonitoredSessions.mockResolvedValue([
    { sessao: 'clone_meduzza', label: 'Barbearia Meduzza', slot: 'clone_meduzza' },
  ]);
  mocks.listEnabledRecipients.mockResolvedValue([recipient(1, '5535999990011')]);
  stubWahaSessions([{ name: 'clone_meduzza', status: 'FAILED' }]);
  pgUp();
});

describe('monitor re-alerta — env MONITOR_REALERT_HOURS respeitado (override 2h)', () => {
  it('último aviso 90 min atrás (< 2h) → NÃO re-alerta', async () => {
    mocks.listStates.mockResolvedValue([confirmedDown('clone_meduzza', 120, 90)]);

    const r = await runMonitor();

    expect(r.sent).toBe(0);
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it('último aviso 3h atrás (> 2h) → re-alerta (seguiria mudo se o limiar fosse 24h hardcoded)', async () => {
    mocks.listStates.mockResolvedValue([confirmedDown('clone_meduzza', 3 * 60 + 10, 3 * 60)]);

    const r = await runMonitor();

    expect(r.sent).toBe(1);
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
    const texto = mocks.sendText.mock.calls[0][0].texto as string;
    expect(texto).toContain('🔴 AINDA CAÍDO');
    expect(texto).toContain('Próximo lembrete em ~2h'); // hora derivada do env, não 24
  });
});
