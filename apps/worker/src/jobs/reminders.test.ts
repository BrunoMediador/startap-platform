/**
 * Testes do job runReminders (lembrete de agendamento — migration 060).
 *
 * `../config.js`, `@startap/db` e `@startap/integrations` são MOCKADOS — sem banco
 * nem rede. A lógica PURA (janela/render) vem do core REAL (não mockado), então o
 * teste cobre a orquestração + decisão de janela de ponta a ponta.
 *
 * Cobre:
 *  - kill switch OFF (REMINDERS_ENABLED=false) -> NO-OP total (não lê banco/WAHA).
 *  - caminho feliz: atendimento na janela -> claim + sendText pela sessão do clone.
 *  - skip sem cliente_contato (sem destino) -> não claima, não envia.
 *  - skip duplicado: claim devolve null (já reservado) -> não envia.
 *  - erro de envio: sendText lança -> markReminderFailed(claim.id), NÃO derruba o job.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks dos módulos externos ao job ───────────────────────────────────────────
const findDueAgendaAtendimentos = vi.fn();
const claimReminder = vi.fn();
const markReminderFailed = vi.fn();
const sendText = vi.fn();

vi.mock('@startap/db', () => ({
  reminders: { findDueAgendaAtendimentos, claimReminder, markReminderFailed },
}));

vi.mock('@startap/integrations', () => ({
  waha: { sendText },
}));

interface ConfigOverrides {
  enabled?: boolean;
}

async function loadJob(overrides: ConfigOverrides = {}) {
  vi.resetModules();
  vi.doMock('../config.js', () => ({
    config: {
      REMINDERS_ENABLED: overrides.enabled ?? true,
      REMINDERS_HORIZON_MIN: 1500,
      REMINDERS_TOLERANCE_MIN: 6,
      REMINDERS_MAX_PER_SESSION: 20,
      REMINDERS_TYPING_DELAY_MS: 0,
      REMINDERS_SEND_TIMEOUT_MS: 8000,
    },
  }));
  return import('./reminders.js');
}

// Atendimento DUE: inicio_at ~120 min à frente do "agora" do teste -> casa janela 120.
function dueRow(over: Record<string, unknown> = {}) {
  const inicio = new Date(Date.now() + 120 * 60_000).toISOString();
  return {
    atendimento_id: 1,
    slot: 'clone_barbearia_xyz',
    tenant_id: '11111111-1111-1111-1111-111111111111',
    waha_sessao: 'clone_barbearia_xyz',
    waha_shard_id: 0,
    display_name: 'Barbearia XYZ',
    reminder_windows_min: [120],
    reminder_template: null,
    cliente_contato: '5535999991234',
    cliente_nome: 'João',
    servico_nome: 'Corte',
    inicio_at: inicio,
    profissional_nome: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runReminders', () => {
  it('kill switch OFF -> NO-OP total (não lê banco nem WAHA)', async () => {
    const { runReminders } = await loadJob({ enabled: false });
    const r = await runReminders();
    expect(findDueAgendaAtendimentos).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(r).toMatchObject({ scanned: 0, sent: 0, failed: 0 });
  });

  it('caminho feliz: atendimento na janela -> claim + sendText pela sessão do clone', async () => {
    findDueAgendaAtendimentos.mockResolvedValue([dueRow()]);
    claimReminder.mockResolvedValue({ id: 99 });
    sendText.mockResolvedValue(undefined);

    const { runReminders } = await loadJob();
    const r = await runReminders();

    expect(claimReminder).toHaveBeenCalledTimes(1);
    expect(claimReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        atendimentoId: 1,
        slot: 'clone_barbearia_xyz',
        tenantId: '11111111-1111-1111-1111-111111111111',
        windowMin: 120,
      }),
    );
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({ sessao: 'clone_barbearia_xyz', chatId: '5535999991234@c.us' }),
    );
    expect(markReminderFailed).not.toHaveBeenCalled();
    expect(r).toMatchObject({ scanned: 1, sent: 1, failed: 0 });
  });

  it('sem cliente_contato -> pula sem claim nem envio', async () => {
    findDueAgendaAtendimentos.mockResolvedValue([dueRow({ cliente_contato: null })]);

    const { runReminders } = await loadJob();
    const r = await runReminders();

    expect(claimReminder).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(r).toMatchObject({ sent: 0, skippedNoContact: 1 });
  });

  it('claim duplicado (null) -> não envia (idempotência)', async () => {
    findDueAgendaAtendimentos.mockResolvedValue([dueRow()]);
    claimReminder.mockResolvedValue(null);

    const { runReminders } = await loadJob();
    const r = await runReminders();

    expect(sendText).not.toHaveBeenCalled();
    expect(r).toMatchObject({ sent: 0, skippedDuplicate: 1 });
  });

  it('envio falha -> markReminderFailed(claim.id) e o job NÃO derruba', async () => {
    findDueAgendaAtendimentos.mockResolvedValue([dueRow()]);
    claimReminder.mockResolvedValue({ id: 77 });
    markReminderFailed.mockResolvedValue(undefined);
    sendText.mockRejectedValue(new Error('WAHA 500'));

    const { runReminders } = await loadJob();
    const r = await runReminders();

    expect(markReminderFailed).toHaveBeenCalledWith(77);
    expect(r).toMatchObject({ sent: 0, failed: 1 });
  });
});
