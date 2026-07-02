/**
 * Testes do auto-aviso de DESCONEXÃO ao próprio cliente (notifyClientDisconnect).
 *
 * `../config.js`, `@startap/db` (alerts + flowClones) e `@startap/integrations` (waha) são
 * MOCKADOS — sem banco nem rede. A copy PURA vem do core REAL (não mockado).
 *
 * Cobre (caminho feliz + erros do brief):
 *  - DISPARA quando a sessão de um clone JÁ conectado cai (target enabled + telefone) -> sendText
 *    pela sessão ALERTAS com a copy (nome do negócio), reserva cooldown.
 *  - OPT-IN: alert_owner_enabled=false -> NÃO envia (opt_out).
 *  - SEM DESTINO: target.phone null -> NÃO envia (no_target).
 *  - ANTI-FLAP / COOLDOWN: dentro da janela (last_alert_at recente) -> suprime (cooldown).
 *  - SEM REMETENTE: ALERTAS não resolvida -> não envia (no_sender), fail-safe.
 *  - LGPD: nunca chama sendText com o telefone em log; cooldown key usa slot (sem PII).
 *
 * Obs.: o GATE MACRO CLIENT_DISCONNECT_ALERT_ENABLED e o ANTI-PRÉ-SETUP (só clone já pareado
 * gera up→down) vivem A MONTANTE (monitor + listMonitoredSessions) — cobertos em alerts.test.ts
 * e na fiação do monitor; aqui o foco é o transporte/opt-in/cooldown.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getState = vi.fn();
const upsertState = vi.fn();
const restoreStateIfUnchanged = vi.fn();
const getConfig = vi.fn();
const getSenderSession = vi.fn();
const getCloneDisconnectAlertTarget = vi.fn();
const sendText = vi.fn();

vi.mock('@startap/db', () => ({
  alerts: { getState, upsertState, restoreStateIfUnchanged, getConfig, getSenderSession },
  flowClones: { getCloneDisconnectAlertTarget },
}));

vi.mock('@startap/integrations', () => ({
  waha: { sendText },
}));

vi.mock('../config.js', () => ({
  config: {
    CLIENT_DISCONNECT_ALERT_COOLDOWN_MIN: 360,
    CLIENT_DISCONNECT_ALERT_TYPING_DELAY_MS: 0,
    CLIENT_DISCONNECT_ALERT_SEND_TIMEOUT_MS: 8000,
  },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { notifyClientDisconnect, disconnectCooldownKey, phoneHint } = await import(
  './client-disconnect-notify.js'
);

const SLOT = 'clone_barbearia_seven_7_barber_dqjzb4';

beforeEach(() => {
  vi.clearAllMocks();
  getState.mockResolvedValue(null); // sem cooldown anterior
  upsertState.mockResolvedValue(undefined);
  restoreStateIfUnchanged.mockResolvedValue(true);
  getConfig.mockResolvedValue({ sender_slot: 'alertas' });
  getSenderSession.mockResolvedValue('ALERTAS');
  sendText.mockResolvedValue(undefined);
});

describe('notifyClientDisconnect — caminho feliz (sessão de cliente caiu após conectado)', () => {
  it('avisa o dono pela sessão ALERTAS com a copy do negócio e reserva cooldown', async () => {
    getCloneDisconnectAlertTarget.mockResolvedValue({
      phone: '5535999991234',
      enabled: true,
      nomeNegocio: 'Seven 7 Barber',
    });

    const r = await notifyClientDisconnect(SLOT);

    expect(r).toEqual({ ok: true, sent: true });
    expect(sendText).toHaveBeenCalledTimes(1);
    const arg = sendText.mock.calls[0][0];
    // Envia pela sessão remetente ALERTAS — NUNCA pela sessão (caída) do clone.
    expect(arg.sessao).toBe('ALERTAS');
    expect(arg.chatId).toBe('5535999991234@c.us');
    // Copy com o nome do negócio + chamada pro portal de reconexão.
    expect(arg.texto).toContain('Seven 7 Barber');
    expect(arg.texto).toContain('app.startap.tech');
    expect(arg.typing).toBe(true);
    // Cooldown reservado pela chave por-slot (sem PII).
    expect(upsertState).toHaveBeenCalledTimes(1);
    const upsertArg = upsertState.mock.calls[0][0];
    expect(upsertArg.checkKey).toBe(disconnectCooldownKey(SLOT));
    expect(upsertArg.checkKey).toContain(SLOT);
  });

  it('usa o fallback genérico quando o clone não tem nome de negócio', async () => {
    getCloneDisconnectAlertTarget.mockResolvedValue({
      phone: '5535999991234',
      enabled: true,
      nomeNegocio: null,
    });

    const r = await notifyClientDisconnect(SLOT);

    expect(r).toEqual({ ok: true, sent: true });
    const arg = sendText.mock.calls[0][0];
    expect(arg.texto).toContain('seu atendimento');
  });
});

describe('notifyClientDisconnect — opt-in e destino', () => {
  it('NÃO avisa quando o opt-in por-clone está desligado (alert_owner_enabled=false)', async () => {
    getCloneDisconnectAlertTarget.mockResolvedValue({
      phone: '5535999991234',
      enabled: false,
      nomeNegocio: 'Seven 7 Barber',
    });

    const r = await notifyClientDisconnect(SLOT);

    expect(r).toEqual({ ok: true, sent: false, reason: 'opt_out' });
    expect(sendText).not.toHaveBeenCalled();
    expect(upsertState).not.toHaveBeenCalled();
  });

  it('NÃO avisa quando o clone não tem destino (alert_owner_phone vazio)', async () => {
    getCloneDisconnectAlertTarget.mockResolvedValue({
      phone: null,
      enabled: true,
      nomeNegocio: 'Seven 7 Barber',
    });

    const r = await notifyClientDisconnect(SLOT);

    expect(r).toEqual({ ok: true, sent: false, reason: 'no_target' });
    expect(sendText).not.toHaveBeenCalled();
  });
});

describe('notifyClientDisconnect — anti-flap (cooldown)', () => {
  it('suprime quando já avisou o mesmo clone dentro da janela (flap = 1 msg por episódio)', async () => {
    getCloneDisconnectAlertTarget.mockResolvedValue({
      phone: '5535999991234',
      enabled: true,
      nomeNegocio: 'Seven 7 Barber',
    });
    // Avisado há 10 min; cooldown é 360 min -> ainda na janela -> suprime.
    getState.mockResolvedValue({
      check_key: disconnectCooldownKey(SLOT),
      state: 'down',
      down_since: null,
      last_alert_at: new Date(Date.now() - 10 * 60_000),
      alert_count: 1,
      pending_down_count: 0,
      updated_at: new Date(),
    });

    const r = await notifyClientDisconnect(SLOT);

    expect(r).toEqual({ ok: true, sent: false, reason: 'cooldown' });
    expect(sendText).not.toHaveBeenCalled();
    // NÃO re-reserva (não estende a janela artificialmente).
    expect(upsertState).not.toHaveBeenCalled();
  });

  it('volta a avisar quando a janela de cooldown já passou (reconectou e caiu de novo)', async () => {
    getCloneDisconnectAlertTarget.mockResolvedValue({
      phone: '5535999991234',
      enabled: true,
      nomeNegocio: 'Seven 7 Barber',
    });
    // Último aviso há 7h; cooldown 6h -> janela expirou -> avisa de novo.
    getState.mockResolvedValue({
      check_key: disconnectCooldownKey(SLOT),
      state: 'down',
      down_since: null,
      last_alert_at: new Date(Date.now() - 7 * 60 * 60_000),
      alert_count: 1,
      pending_down_count: 0,
      updated_at: new Date(),
    });

    const r = await notifyClientDisconnect(SLOT);

    expect(r).toEqual({ ok: true, sent: true });
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('FAIL-CLOSED: erro de DB no cooldown -> NÃO avisa (não arrisca spam ao cliente)', async () => {
    getCloneDisconnectAlertTarget.mockResolvedValue({
      phone: '5535999991234',
      enabled: true,
      nomeNegocio: 'Seven 7 Barber',
    });
    // alerts.getState lança (DB indisponível) -> reserveCooldown devolve false (fail-closed).
    // DIFERENTE do client-alert de cancelamento (fail-OPEN): aqui o alerta interno pro Bruno já
    // dá visibilidade do incidente, então preferimos NÃO arriscar spam ao cliente que flapa.
    getState.mockRejectedValue(new Error('db down'));

    const r = await notifyClientDisconnect(SLOT);

    expect(r).toEqual({ ok: true, sent: false, reason: 'cooldown' });
    expect(sendText).not.toHaveBeenCalled();
    // Não conseguiu ler o estado -> também não tenta gravar (sem upsert).
    expect(upsertState).not.toHaveBeenCalled();
  });
});

describe('notifyClientDisconnect — fail-safe', () => {
  it('degrada gracioso (no_sender) quando a sessão ALERTAS não está mapeada', async () => {
    getCloneDisconnectAlertTarget.mockResolvedValue({
      phone: '5535999991234',
      enabled: true,
      nomeNegocio: 'Seven 7 Barber',
    });
    getSenderSession.mockResolvedValue(null);

    const r = await notifyClientDisconnect(SLOT);

    expect(r).toEqual({ ok: false, sent: false, reason: 'no_sender' });
    expect(sendText).not.toHaveBeenCalled();
  });

  it('captura erro do sendText e NUNCA lança (fail-safe pro job monitor)', async () => {
    getCloneDisconnectAlertTarget.mockResolvedValue({
      phone: '5535999991234',
      enabled: true,
      nomeNegocio: 'Seven 7 Barber',
    });
    sendText.mockRejectedValue(new Error('waha down'));

    const r = await notifyClientDisconnect(SLOT);

    expect(r.ok).toBe(false);
    expect(r.sent).toBe(false);
  });
});

describe('notifyClientDisconnect — SCRUM-53: reserva otimista NÃO fica consumida quando o envio falha', () => {
  const target = { phone: '5535999991234', enabled: true, nomeNegocio: 'Seven 7 Barber' };

  it('send falha -> DESFAZ a reserva (restore condicional ao carimbo) -> ciclo seguinte re-tenta', async () => {
    getCloneDisconnectAlertTarget.mockResolvedValue(target);
    getState.mockResolvedValue(null); // primeiro episódio: sem carimbo anterior
    sendText.mockRejectedValue(new Error('ALERTAS morta (send timeout)'));

    const r = await notifyClientDisconnect(SLOT);

    expect(r).toEqual({ ok: false, sent: false, reason: 'error' });
    // 1) reservou (carimbou 'avisado') ANTES do envio (lock otimista).
    expect(upsertState).toHaveBeenCalledTimes(1);
    const reserved = upsertState.mock.calls[0][0];
    expect(reserved.checkKey).toBe(disconnectCooldownKey(SLOT));
    expect(reserved.state).toBe('down');
    // 2) send falhou -> compensou: restaurou o estado anterior (neutro 'up', janela livre).
    expect(restoreStateIfUnchanged).toHaveBeenCalledTimes(1);
    const comp = restoreStateIfUnchanged.mock.calls[0][0];
    // O predicado (expect) usa EXATAMENTE o que este ciclo gravou -> só o dono desfaz a reserva.
    expect(comp.expect.state).toBe('down');
    expect(comp.expect.lastAlertAt).toBe(reserved.lastAlertAt);
    expect(comp.expect.alertCount).toBe(reserved.alertCount);
    // Restaura pro neutro: last_alert_at null = próximo ciclo NÃO está mais em cooldown -> re-tenta.
    expect(comp.restore.state).toBe('up');
    expect(comp.restore.lastAlertAt).toBeNull();
    expect(comp.restore.alertCount).toBe(0);
  });

  it('send falha após episódio anterior -> restaura o last_alert_at ANTERIOR (não o novo carimbo)', async () => {
    getCloneDisconnectAlertTarget.mockResolvedValue(target);
    const prevAt = new Date(Date.now() - 7 * 60 * 60_000); // 7h atrás (fora do cooldown 6h -> reserva)
    getState.mockResolvedValue({
      check_key: disconnectCooldownKey(SLOT),
      state: 'down',
      down_since: null,
      last_alert_at: prevAt,
      alert_count: 2,
      pending_down_count: 0,
      updated_at: new Date(),
    });
    sendText.mockRejectedValue(new Error('waha down'));

    const r = await notifyClientDisconnect(SLOT);

    expect(r.ok).toBe(false);
    expect(restoreStateIfUnchanged).toHaveBeenCalledTimes(1);
    const comp = restoreStateIfUnchanged.mock.calls[0][0];
    // Volta ao carimbo do episódio anterior (não deixa o relógio do cooldown adiantado por um
    // envio que nunca saiu). alert_count também retorna ao valor anterior.
    expect(comp.restore.lastAlertAt).toBe(prevAt);
    expect(comp.restore.alertCount).toBe(2);
  });

  it('send OK -> NÃO desfaz nada: cooldown legítimo permanece (anti-duplicata preservado)', async () => {
    getCloneDisconnectAlertTarget.mockResolvedValue(target);
    getState.mockResolvedValue(null);
    sendText.mockResolvedValue(undefined);

    const r = await notifyClientDisconnect(SLOT);

    expect(r).toEqual({ ok: true, sent: true });
    expect(upsertState).toHaveBeenCalledTimes(1); // reserva permanece
    expect(restoreStateIfUnchanged).not.toHaveBeenCalled(); // nada a compensar
  });

  it('ciclo concorrente já reservou (carimbo recente) -> este suprime SEM enviar (1 envio só)', async () => {
    getCloneDisconnectAlertTarget.mockResolvedValue(target);
    // Outro ciclo carimbou há 2 min; cooldown 360 min -> este ciclo vê a reserva e NÃO reenvia.
    getState.mockResolvedValue({
      check_key: disconnectCooldownKey(SLOT),
      state: 'down',
      down_since: null,
      last_alert_at: new Date(Date.now() - 2 * 60_000),
      alert_count: 1,
      pending_down_count: 0,
      updated_at: new Date(),
    });

    const r = await notifyClientDisconnect(SLOT);

    expect(r).toEqual({ ok: true, sent: false, reason: 'cooldown' });
    expect(sendText).not.toHaveBeenCalled();
    expect(upsertState).not.toHaveBeenCalled(); // não re-reserva
    expect(restoreStateIfUnchanged).not.toHaveBeenCalled();
  });

  it('sem remetente NÃO reserva (resolve ALERTAS antes do cooldown) -> nada a desfazer', async () => {
    getCloneDisconnectAlertTarget.mockResolvedValue(target);
    getSenderSession.mockResolvedValue(null);

    const r = await notifyClientDisconnect(SLOT);

    expect(r).toEqual({ ok: false, sent: false, reason: 'no_sender' });
    // Reordenado (SCRUM-53): o cooldown só é reservado DEPOIS de garantir o remetente.
    expect(upsertState).not.toHaveBeenCalled();
    expect(restoreStateIfUnchanged).not.toHaveBeenCalled();
  });
});

describe('phoneHint — LGPD (mascara telefone no log)', () => {
  it('mascara o miolo do número', () => {
    expect(phoneHint('5535999991234')).toBe('5535****1234');
    expect(phoneHint('123')).toBe('***');
  });
});
