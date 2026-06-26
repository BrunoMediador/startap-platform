/**
 * Testes da FIAÇÃO do auto-aviso de desconexão DENTRO do runMonitor (gate da feature nova).
 *
 * Foco: o branch `justWentDown && obsItem.slot && config.CLIENT_DISCONNECT_ALERT_ENABLED ->
 * notifyClientDisconnect(slot)`. O `notifyClientDisconnect` é MOCKADO aqui (testado isolado em
 * client-disconnect-notify.test.ts) — aqui só validamos QUANDO o monitor o chama:
 *   (a) flag ON + sessão de CLONE (slot != null) indo up->down -> chamado 1x, clientNotified=1;
 *   (b) flag OFF -> nunca chamado, clientNotified=0;
 *   (c) check de INFRA / sessão remetente ALERTAS (slot=null) -> nunca chama (não avisa "dono");
 *   (d) só na transição (up->down): re-alerta down->down NÃO chama de novo.
 *
 * `config` é MOCKADO via objeto MUTÁVEL (flag toggla por teste). Demais deps (alerts/waha/pool)
 * mockadas como em monitor.test.ts. A flag OFF é o estado padrão (default do projeto).
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
  notifyClientDisconnect: vi.fn(),
  // config mutável — cada teste seta a flag antes de chamar runMonitor.
  config: {
    WAHA_URL: 'http://waha:3000',
    WAHA_API_KEY: 'k',
    ALERTS_API_HEALTH_URL: 'http://startap-api:3040/health',
    ALERTS_MAX_PER_WINDOW: 50,
    ALERTS_WINDOW_MIN: 30,
    CLIENT_DISCONNECT_ALERT_ENABLED: false as boolean,
  },
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

vi.mock('./client-disconnect-notify.js', () => ({
  notifyClientDisconnect: mocks.notifyClientDisconnect,
}));

vi.mock('../config.js', () => ({ config: mocks.config }));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { runMonitor } from './monitor.js';

function recipient(id: number, phone: string) {
  return { id, phone, label: null, enabled: true, created_at: new Date() };
}

/** PG sempre UP (não queremos PG nestes testes). */
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

/** Sessão WAHA já em observação (1 poll down acumulado) -> o 2º poll down confirma up->down. */
function wahaPending(sessao: string) {
  return stateRow(`waha:${sessao}`, { pending_down_count: 1 });
}

/** Sessão já DOWN (estado down) -> próximo down é re-alerta (down->down), NÃO transição. */
function wahaDown(sessao: string) {
  return stateRow(`waha:${sessao}`, {
    state: 'down',
    down_since: new Date(Date.now() - 60 * 60_000),
    last_alert_at: new Date(Date.now() - 60 * 60_000),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.CLIENT_DISCONNECT_ALERT_ENABLED = false;
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
  mocks.listEnabledRecipients.mockResolvedValue([recipient(1, '5535999990011')]);
  mocks.notifyClientDisconnect.mockResolvedValue({ ok: true, sent: true });
  pgUp();
  // WAHA inacessível -> sessões monitoradas observadas como down.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('waha unreachable')));
});

describe('runMonitor — fiação do auto-aviso de desconexão (gate da feature nova)', () => {
  it('(a) flag ON + clone (slot) indo up->down -> avisa o dono (clientNotified=1)', async () => {
    mocks.config.CLIENT_DISCONNECT_ALERT_ENABLED = true;
    mocks.listMonitoredSessions.mockResolvedValue([
      { sessao: 'clone_seven_7', label: 'Seven 7 Barber', slot: 'clone_seven_7' },
    ]);
    // pending=1 -> este 2º poll down CONFIRMA a transição up->down.
    mocks.listStates.mockResolvedValue([wahaPending('clone_seven_7')]);

    const r = await runMonitor();

    expect(mocks.notifyClientDisconnect).toHaveBeenCalledTimes(1);
    expect(mocks.notifyClientDisconnect).toHaveBeenCalledWith('clone_seven_7');
    expect(r.clientNotified).toBe(1);
  });

  it('(b) flag OFF -> NÃO avisa o dono (clientNotified=0), mesmo na transição up->down', async () => {
    mocks.config.CLIENT_DISCONNECT_ALERT_ENABLED = false;
    mocks.listMonitoredSessions.mockResolvedValue([
      { sessao: 'clone_seven_7', label: 'Seven 7 Barber', slot: 'clone_seven_7' },
    ]);
    mocks.listStates.mockResolvedValue([wahaPending('clone_seven_7')]);

    const r = await runMonitor();

    expect(mocks.notifyClientDisconnect).not.toHaveBeenCalled();
    expect(r.clientNotified).toBe(0);
    // O alerta INTERNO (broadcast pela ALERTAS) segue saindo — feature do cliente é adicional.
    expect(r.sent).toBe(1);
  });

  it('(c) slot=null (sessão remetente ALERTAS / infra) -> NUNCA avisa "dono", mesmo flag ON', async () => {
    mocks.config.CLIENT_DISCONNECT_ALERT_ENABLED = true;
    // Só a sessão remetente sintética (slot=null) na lista — não é clone de cliente.
    mocks.listMonitoredSessions.mockResolvedValue([
      { sessao: 'ALERTAS', label: 'Sessão de alertas (remetente)', slot: null },
    ]);
    mocks.listStates.mockResolvedValue([wahaPending('ALERTAS')]);

    const r = await runMonitor();

    expect(mocks.notifyClientDisconnect).not.toHaveBeenCalled();
    expect(r.clientNotified).toBe(0);
  });

  it('(d) re-alerta down->down (já estava down) NÃO chama de novo (só na transição)', async () => {
    mocks.config.CLIENT_DISCONNECT_ALERT_ENABLED = true;
    mocks.listMonitoredSessions.mockResolvedValue([
      { sessao: 'clone_seven_7', label: 'Seven 7 Barber', slot: 'clone_seven_7' },
    ]);
    // Já estava DOWN há 60 min (cooldown 30 min já passou -> re-alerta interno), mas NÃO é
    // transição up->down -> o aviso ao cliente NÃO dispara (justWentDown=false).
    mocks.listStates.mockResolvedValue([wahaDown('clone_seven_7')]);

    const r = await runMonitor();

    expect(mocks.notifyClientDisconnect).not.toHaveBeenCalled();
    expect(r.clientNotified).toBe(0);
  });

  it('só conta clientNotified quando o aviso REALMENTE saiu (sent=true)', async () => {
    mocks.config.CLIENT_DISCONNECT_ALERT_ENABLED = true;
    // Aviso suprimido pelo cooldown interno do notify (sent:false) -> não conta.
    mocks.notifyClientDisconnect.mockResolvedValue({ ok: true, sent: false, reason: 'cooldown' });
    mocks.listMonitoredSessions.mockResolvedValue([
      { sessao: 'clone_seven_7', label: 'Seven 7 Barber', slot: 'clone_seven_7' },
    ]);
    mocks.listStates.mockResolvedValue([wahaPending('clone_seven_7')]);

    const r = await runMonitor();

    expect(mocks.notifyClientDisconnect).toHaveBeenCalledTimes(1);
    expect(r.clientNotified).toBe(0);
  });
});
