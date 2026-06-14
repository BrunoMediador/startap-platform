/**
 * Testes do job monitor (Sistema de Alertas Interno) — foco no PACING de envio.
 *
 * `../config.js`, `@startap/db` (alerts/pool) e `@startap/integrations` (waha) são
 * MOCKADOS — sem banco nem rede. Cobre o que esta missão mudou:
 *  - broadcast usa typing:true + delayMs>0 (humaniza, reduz risco de derrubar a
 *    sessão ALERTAS);
 *  - envio SEQUENCIAL e espaçado: 2º destinatário só sai depois do 1º + pausa;
 *  - múltiplos broadcasts no MESMO ciclo (2 sessões caem juntas) saem espaçados,
 *    não colados.
 *  + NUNCA Promise.all (sequencial), NUNCA loga telefone (LGPD).
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
  },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
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
  mocks.listStates.mockResolvedValue([]); // tudo "up" antes -> primeira queda alerta
  mocks.upsertState.mockResolvedValue(undefined);
  mocks.sendText.mockResolvedValue(undefined);
  pgUp();
  // WAHA inacessível -> cada sessão monitorada observada como down (alerta CAIU).
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('waha unreachable')));
});

describe('monitor broadcast — humanização e pacing', () => {
  it('envia com typing:true e delayMs>0 (humaniza p/ não derrubar a sessão)', async () => {
    mocks.listMonitoredSessions.mockResolvedValue([
      { sessao: 'cirilobarbearia', label: 'Barbearia do Cirilo' },
    ]);
    mocks.listEnabledRecipients.mockResolvedValue([recipient(1, '5535999990011')]);

    const r = await runMonitor();
    expect(r.sent).toBe(1);
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
    const arg = mocks.sendText.mock.calls[0][0];
    expect(arg.sessao).toBe('ALERTAS');
    expect(arg.typing).toBe(true);
    expect(arg.delayMs).toBeGreaterThan(0);
  });

  it('SEQUENCIAL + pausa entre destinatários: 2º só depois do 1º', async () => {
    vi.useFakeTimers();
    try {
      mocks.listMonitoredSessions.mockResolvedValue([
        { sessao: 'cirilobarbearia', label: 'Barbearia do Cirilo' },
      ]);
      mocks.listEnabledRecipients.mockResolvedValue([
        recipient(1, '5535999990011'),
        recipient(2, '5535999990022'),
      ]);

      const promise = runMonitor();
      // Roda até o 1º sendText resolver; o 2º deve estar segurado pela pausa.
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.sendText).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(mocks.sendText).toHaveBeenCalledTimes(2);

      const r = await promise;
      expect(r.sent).toBe(1); // 1 evento (1 sessão caiu) = 1 broadcast bem-sucedido
    } finally {
      vi.useRealTimers();
    }
  });

  it('2 sessões caem no mesmo ciclo -> 2 broadcasts espaçados (não colados)', async () => {
    vi.useFakeTimers();
    try {
      mocks.listMonitoredSessions.mockResolvedValue([
        { sessao: 'cirilobarbearia', label: 'Barbearia do Cirilo' },
        { sessao: 'edubarbeiro', label: 'Edu Barbeiro' },
      ]);
      mocks.listEnabledRecipients.mockResolvedValue([recipient(1, '5535999990011')]);

      const promise = runMonitor();
      // 1ª sessão: 1 envio sai (sem pausa inicial, é o 1º broadcast do ciclo).
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.sendText).toHaveBeenCalledTimes(1);

      // 2º broadcast (2ª sessão) está segurado pela pausa entre broadcasts.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mocks.sendText).toHaveBeenCalledTimes(2);

      const r = await promise;
      expect(r.sent).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
