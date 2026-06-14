/**
 * Testes do sendInternalAlert (alerta interno de cliente novo via Lola).
 *
 * @startap/db (alerts/query) e o cliente WAHA (sendText) sao MOCKADOS — nao toca
 * banco nem WAHA real. Cobre o contrato fire-and-forget SEGURO:
 *   (a) alert_config.enabled=false -> no-op;
 *   (b) listEnabledRecipients vazio -> no-op;
 *   (c) happy path -> envia pra TODOS os destinatarios;
 *   (d) sendText lanca -> helper NAO lanca, loga, e segue pros demais;
 *   (e) anti-flood global suprime -> no-op;
 *   (f) sem waha_sessao do remetente -> no-op.
 * + helpers de mensagem (LGPD-safe) e formatBRLFromCents.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getConfig, listEnabledRecipients, getSenderSession, reserveGlobalSend, query, sendText } =
  vi.hoisted(() => ({
    getConfig: vi.fn(),
    listEnabledRecipients: vi.fn(),
    getSenderSession: vi.fn(),
    reserveGlobalSend: vi.fn(),
    query: vi.fn(),
    sendText: vi.fn(),
  }));

vi.mock('@startap/db', () => ({
  alerts: { getConfig, listEnabledRecipients, getSenderSession, reserveGlobalSend },
  query,
}));

vi.mock('../waha/client.js', () => ({ sendText }));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import {
  displayNameForSlot,
  formatBRLFromCents,
  msgClienteAtivou,
  msgClientePagou,
  msgNovoCadastro,
  sendInternalAlert,
} from './internal-alert.js';

function recipient(id: number, phone: string) {
  return { id, phone, label: null, enabled: true, created_at: new Date() };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults do happy path — cada teste sobrescreve o que precisa.
  getConfig.mockResolvedValue({ enabled: true, sender_slot: 'startap' });
  getSenderSession.mockResolvedValue('STARTAP_AI_PROD');
  reserveGlobalSend.mockResolvedValue({ allowed: true, sentInWindow: 1 });
  listEnabledRecipients.mockResolvedValue([recipient(1, '5531999990011')]);
  sendText.mockResolvedValue(undefined);
});

describe('sendInternalAlert', () => {
  it('(a) config.enabled=false -> no-op (nao le destinatarios nem envia)', async () => {
    getConfig.mockResolvedValue({ enabled: false, sender_slot: 'startap' });
    const r = await sendInternalAlert('oi');
    expect(r.sent).toBe(0);
    expect(listEnabledRecipients).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('(b) sem destinatarios habilitados -> no-op', async () => {
    listEnabledRecipients.mockResolvedValue([]);
    const r = await sendInternalAlert('oi');
    expect(r.sent).toBe(0);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('(c) happy path -> envia pra TODOS os destinatarios habilitados', async () => {
    listEnabledRecipients.mockResolvedValue([
      recipient(1, '5531999990011'),
      recipient(2, '5531999990022'),
    ]);
    const r = await sendInternalAlert('cliente novo!');
    expect(r.sent).toBe(2);
    expect(sendText).toHaveBeenCalledTimes(2);
    // Sempre via a sessao da Lola, sem typing/delay, chatId @c.us.
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        sessao: 'STARTAP_AI_PROD',
        chatId: '5531999990011@c.us',
        texto: 'cliente novo!',
        typing: false,
        delayMs: 0,
      }),
    );
  });

  it('(d) sendText lanca -> helper NAO lanca; falha de um nao derruba os outros', async () => {
    listEnabledRecipients.mockResolvedValue([
      recipient(1, '5531999990011'),
      recipient(2, '5531999990022'),
    ]);
    sendText.mockRejectedValueOnce(new Error('WAHA caiu')).mockResolvedValueOnce(undefined);
    // NAO deve lancar.
    const r = await sendInternalAlert('x');
    expect(r.sent).toBe(1); // so o 2o foi
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it('(d2) banco lanca em getConfig -> helper engole e retorna sent:0', async () => {
    getConfig.mockRejectedValue(new Error('pg down'));
    await expect(sendInternalAlert('x')).resolves.toEqual({ sent: 0 });
    expect(sendText).not.toHaveBeenCalled();
  });

  it('(e) anti-flood global suprime -> no-op', async () => {
    reserveGlobalSend.mockResolvedValue({ allowed: false, sentInWindow: 10 });
    const r = await sendInternalAlert('x');
    expect(r.sent).toBe(0);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('(f) remetente sem waha_sessao -> no-op', async () => {
    getSenderSession.mockResolvedValue(null);
    const r = await sendInternalAlert('x');
    expect(r.sent).toBe(0);
    expect(sendText).not.toHaveBeenCalled();
  });
});

describe('displayNameForSlot', () => {
  it('retorna display_name quando existe', async () => {
    query.mockResolvedValue({ rows: [{ display_name: 'Barbearia do Edu' }] });
    expect(await displayNameForSlot('clone-edu')).toBe('Barbearia do Edu');
  });

  it('cai pro slot quando display_name vazio/ausente', async () => {
    query.mockResolvedValue({ rows: [{ display_name: '' }] });
    expect(await displayNameForSlot('clone-x')).toBe('clone-x');
    query.mockResolvedValue({ rows: [] });
    expect(await displayNameForSlot('clone-y')).toBe('clone-y');
  });

  it('nunca lanca: erro de banco -> usa o slot', async () => {
    query.mockRejectedValue(new Error('pg down'));
    expect(await displayNameForSlot('clone-z')).toBe('clone-z');
  });
});

describe('mensagens LGPD-safe', () => {
  it('formatBRLFromCents formata pt-BR e trata nulo', () => {
    expect(formatBRLFromCents(3100)).toBe('R$31,00');
    expect(formatBRLFromCents(8500)).toBe('R$85,00');
    expect(formatBRLFromCents(null)).toBe('R$0,00');
  });

  it('A: novo cadastro nunca contem telefone em claro (so o hint)', () => {
    const m = msgNovoCadastro({
      nomeNegocio: 'Salão Tal',
      phoneHint: '42',
      slot: 'clone-salao',
      amountCents: 9999,
    });
    expect(m).toContain('Salão Tal');
    expect(m).toContain('…42');
    expect(m).toContain('clone-salao');
    expect(m).toContain('R$99,99');
    expect(m).not.toMatch(/\d{8,}/); // nenhum bloco de 8+ digitos (telefone)
  });

  it('B: cliente ativou', () => {
    const m = msgClienteAtivou({ displayName: 'Edu Barbeiro', slot: 'clone-edu' });
    expect(m).toContain('Edu Barbeiro');
    expect(m).toContain('clone-edu');
  });

  it('C: cliente novo pagou', () => {
    const m = msgClientePagou({
      displayName: 'Edu Barbeiro',
      slot: 'clone-edu',
      paidAmountCents: 3100,
    });
    expect(m).toContain('Edu Barbeiro');
    expect(m).toContain('R$31,00');
    expect(m).toContain('clone-edu');
  });
});
