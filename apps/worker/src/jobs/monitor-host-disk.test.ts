/**
 * SCRUM-134 — check host:disk (fast-follow da spec 021, "disco fica pra fase 2").
 *
 * O worker NÃO mede disco — LÊ o fato bruto que `/opt/automacoes/disco-alerta.sh` (cron 6/6h
 * no HOST) grava em alert_states.host_reported_pct/host_reported_at (migration 078). Estes
 * testes cobrem observeHostDisk() via runMonitor(), com `@startap/db` (alerts/pool) e
 * `@startap/integrations` (waha) MOCKADOS — sem banco nem rede:
 *  - Gate alert_config.check_host=false (default): NÃO chama getHostDiskReport, NÐO observa
 *    host:disk (comportamento IDÊNTICO ao de hoje — zero mudança quando desligado).
 *  - check_host=true + sem coleta ainda (pct/reportedAt null): trata como 'up' silencioso,
 *    loga warning, NÃO dispara alerta.
 *  - check_host=true + coleta FRIA (mais velha que HOST_DISK_STALE_HOURS): trata como 'up'
 *    silencioso (silêncio de coleta != disco cheio), loga warning.
 *  - check_host=true + pct abaixo do limiar: 'up', silêncio.
 *  - check_host=true + pct no limiar ou acima: 'down' -> dispara 🔴 CAIU via Lola (mesma
 *    máquina de estado dos demais checks — debounceThreshold=1, sem flap a absorver).
 *  - falha ao ler o estado (getHostDiskReport rejeita): tratado como sem coleta, NUNCA como
 *    disco cheio (fail-safe simétrico aos demais coletores do monitor).
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
  recordCycleHeartbeat: vi.fn(),
  getHostDiskReport: vi.fn(),
  poolConnect: vi.fn(),
  sendText: vi.fn(),
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
    upsertState: mocks.upsertState,
    recordCycleHeartbeat: mocks.recordCycleHeartbeat,
    getHostDiskReport: mocks.getHostDiskReport,
    HOST_DISK_STATE_KEY: 'host:disk',
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
    HOST_DISK_ALERT_PCT: 90,
    HOST_DISK_STALE_HOURS: 13,
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

/** PG sempre UP (não queremos PG broadcast nestes testes). */
function pgUp() {
  mocks.poolConnect.mockResolvedValue({
    query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    release: vi.fn(),
  });
}

/** Não há sessão WAHA monitorada nestes testes (isola o check host:disk). */
function noWahaSessions() {
  mocks.listMonitoredSessions.mockResolvedValue([]);
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    sender_slot: 'alertas',
    check_waha: false,
    check_health: false,
    check_host: false,
    cooldown_min: 30,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSenderSession.mockResolvedValue('ALERTAS');
  mocks.reserveGlobalSend.mockResolvedValue({ allowed: true, sentInWindow: 1 });
  mocks.listStates.mockResolvedValue([]);
  mocks.upsertState.mockResolvedValue(undefined);
  mocks.recordCycleHeartbeat.mockResolvedValue(undefined);
  mocks.sendText.mockResolvedValue(undefined);
  mocks.listEnabledRecipients.mockResolvedValue([recipient(1, '5535999990011')]);
  noWahaSessions();
  pgUp();
});

describe('runMonitor — check host:disk (SCRUM-134)', () => {
  it('gate check_host=false (default): NÃO observa host:disk (zero mudança quando desligado)', async () => {
    mocks.getConfig.mockResolvedValue(baseConfig({ check_host: false }));

    const r = await runMonitor();

    expect(mocks.getHostDiskReport).not.toHaveBeenCalled();
    expect(r.checked).toBe(1); // só pg:main
    expect(r.down).toBe(0);
  });

  it('check_host=true + SEM coleta ainda (script nunca rodou): trata como up, sem alerta', async () => {
    mocks.getConfig.mockResolvedValue(baseConfig({ check_host: true }));
    mocks.getHostDiskReport.mockResolvedValue({ pct: null, reportedAt: null });

    const r = await runMonitor();

    expect(mocks.getHostDiskReport).toHaveBeenCalledTimes(1);
    expect(r.down).toBe(0);
    expect(r.sent).toBe(0);
    expect(mocks.logChild.warn).toHaveBeenCalled();
  });

  it('check_host=true + coleta FRIA (>13h): trata como up (silêncio de coleta != disco cheio)', async () => {
    mocks.getConfig.mockResolvedValue(baseConfig({ check_host: true }));
    const stale = new Date(Date.now() - 20 * 3_600_000); // 20h atrás
    mocks.getHostDiskReport.mockResolvedValue({ pct: 95, reportedAt: stale });

    const r = await runMonitor();

    // Mesmo com pct=95 (acima do limiar), a coleta FRIA não vira alerta.
    expect(r.down).toBe(0);
    expect(r.sent).toBe(0);
    expect(mocks.logChild.warn).toHaveBeenCalled();
  });

  it('check_host=true + pct ABAIXO do limiar: up, silêncio', async () => {
    mocks.getConfig.mockResolvedValue(baseConfig({ check_host: true }));
    mocks.getHostDiskReport.mockResolvedValue({ pct: 22, reportedAt: new Date() });

    const r = await runMonitor();

    expect(r.down).toBe(0);
    expect(r.sent).toBe(0);
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it('check_host=true + pct NO limiar (90%): down, dispara 🔴 CAIU via Lola', async () => {
    mocks.getConfig.mockResolvedValue(baseConfig({ check_host: true }));
    mocks.getHostDiskReport.mockResolvedValue({ pct: 90, reportedAt: new Date() });

    const r = await runMonitor();

    expect(r.down).toBe(1);
    expect(r.sent).toBe(1);
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
    const call = mocks.sendText.mock.calls[0][0];
    expect(call.texto).toContain('🔴 CAIU');
    expect(call.texto).toContain('Disco do host');
  });

  it('check_host=true + pct ACIMA do limiar: down, sem debounce (1ª observação já transiciona)', async () => {
    mocks.getConfig.mockResolvedValue(baseConfig({ check_host: true }));
    mocks.getHostDiskReport.mockResolvedValue({ pct: 97, reportedAt: new Date() });

    const r = await runMonitor();

    expect(r.down).toBe(1);
    expect(mocks.upsertState).toHaveBeenCalledWith(
      expect.objectContaining({ checkKey: 'host:disk', state: 'down' }),
    );
  });

  it('falha ao ler getHostDiskReport: tratado como sem coleta, NÃO como disco cheio', async () => {
    mocks.getConfig.mockResolvedValue(baseConfig({ check_host: true }));
    mocks.getHostDiskReport.mockRejectedValue(new Error('pg blip'));

    const r = await runMonitor();

    expect(r.down).toBe(0);
    expect(r.sendErrors).toBe(0); // falha de LEITURA não conta como falha de ENVIO
    expect(mocks.logChild.warn).toHaveBeenCalled();
  });

  it('recuperação: disco volta abaixo do limiar após estar down -> 🟢 RECUPERADO', async () => {
    mocks.getConfig.mockResolvedValue(baseConfig({ check_host: true }));
    mocks.getHostDiskReport.mockResolvedValue({ pct: 50, reportedAt: new Date() });
    mocks.listStates.mockResolvedValue([
      {
        check_key: 'host:disk',
        state: 'down',
        down_since: new Date(Date.now() - 3_600_000),
        last_alert_at: new Date(Date.now() - 3_600_000),
        alert_count: 1,
        pending_down_count: 0,
        updated_at: new Date(),
      },
    ]);

    const r = await runMonitor();

    expect(r.down).toBe(0);
    expect(r.sent).toBe(1);
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
    const call = mocks.sendText.mock.calls[0][0];
    expect(call.texto).toContain('🟢 RECUPERADO');
  });
});
