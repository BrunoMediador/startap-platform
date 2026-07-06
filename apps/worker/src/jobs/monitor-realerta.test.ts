/**
 * Testes do RE-alerta enquanto down (anti-spam — ordem do Bruno 05/07).
 *
 * Regra: enquanto um check segue `down`, o monitor só re-avisa "🔴 AINDA CAÍDO" 1× a cada
 * MONITOR_REALERT_HOURS (default 24h) — NÃO a cada ciclo/30 min (que floodava o número remetente
 * e arriscava BAN). A TRANSIÇÃO up→down ("🔴 CAIU") e a recuperação seguem intocadas (outros files).
 *
 * Config MOCKADA com MONITOR_REALERT_HOURS=24. Mesma fiação de mocks do monitor.test.ts.
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
    MONITOR_REALERT_HOURS: 24,
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

/** Estado já CONFIRMADO down (state='down') com last_alert_at/down_since a `agoMin` minutos. */
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
    cooldown_min: 30, // legado no banco — NÃO deve mais governar o re-alerta (superado por env 24h)
  });
  mocks.getSenderSession.mockResolvedValue('ALERTAS');
  mocks.reserveGlobalSend.mockResolvedValue({ allowed: true, sentInWindow: 1 });
  mocks.upsertState.mockResolvedValue(undefined);
  mocks.sendText.mockResolvedValue(undefined);
  mocks.listMonitoredSessions.mockResolvedValue([
    { sessao: 'clone_meduzza', label: 'Barbearia Meduzza', slot: 'clone_meduzza' },
  ]);
  mocks.listEnabledRecipients.mockResolvedValue([recipient(1, '5535999990011')]);
  stubWahaSessions([{ name: 'clone_meduzza', status: 'FAILED' }]); // segue down
  pgUp();
});

describe('monitor re-alerta 24h — anti-spam enquanto down', () => {
  it('down há pouco (último aviso 35 min atrás) → NÃO re-alerta (não é a cada ciclo/30min)', async () => {
    mocks.listStates.mockResolvedValue([confirmedDown('clone_meduzza', 40, 35)]);

    const r = await runMonitor();

    expect(r.sent).toBe(0);
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(r.down).toBe(1); // segue contabilizado como down (silêncio, não recuperação)
  });

  it('último aviso 23h atrás → ainda dentro da janela → NÃO re-alerta', async () => {
    mocks.listStates.mockResolvedValue([confirmedDown('clone_meduzza', 24 * 60, 23 * 60)]);

    const r = await runMonitor();

    expect(r.sent).toBe(0);
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it('último aviso 25h atrás (>24h) → re-alerta 🔴 AINDA CAÍDO com tempo caído + próximo lembrete', async () => {
    mocks.listStates.mockResolvedValue([confirmedDown('clone_meduzza', 26 * 60, 25 * 60)]);

    const r = await runMonitor();

    expect(r.sent).toBe(1);
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
    const texto = mocks.sendText.mock.calls[0][0].texto as string;
    expect(texto).toContain('🔴 AINDA CAÍDO');
    expect(texto).toContain('há 26h'); // usa down_since (não last_alert_at)
    expect(texto).toContain('Próximo lembrete em ~24h');
    // Carimba o novo last_alert_at + incrementa o contador (relógio das próximas 24h reinicia).
    expect(mocks.upsertState).toHaveBeenCalledWith(
      expect.objectContaining({
        checkKey: 'waha:clone_meduzza',
        state: 'down',
        alertCount: 2,
      }),
    );
  });
});
