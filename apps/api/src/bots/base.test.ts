/**
 * Testa a ORDEM eco-antes-do-envio no BotBase (SCRUM-62).
 *
 * Sob WEBHOOK_ASYNC o eco fromMe da própria resposta do bot pode voltar no webhook ANTES do
 * waha.sendText retornar. Se a marca de eco (registerBotReplyEcho) só fosse gravada DEPOIS do
 * envio, o router veria o eco como 'resposta humana' e auto-pausaria o cliente por 60min. Por
 * isso a marca é registrada ANTES do envio — este teste trava essa invariante. Fora do modo
 * atendente: byte-idêntico (nunca marca, nem toca no Redis).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendText: vi.fn(),
  registerBotReplyEcho: vi.fn(),
  appendMessage: vi.fn(),
  pruneHistory: vi.fn(),
  logFlowEvent: vi.fn(),
  recordOutbound: vi.fn(),
  order: [] as string[],
  // Resolver env→coluna (ADR 0030 D1) mockado como env-only (o teste exercita o gate por env;
  // sem coluna por-clone aqui) — mesma verdade que o isModoAtendenteEnabled de antes.
  csvGate: (slot: string, csv?: string | null): boolean => {
    if (!csv) return false;
    const e = csv
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return e.includes('*') || e.includes(slot);
  },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

vi.mock('@startap/db', () => ({
  chatMemory: {
    loadHistory: vi.fn().mockResolvedValue([]),
    appendMessage: (...a: unknown[]) => mocks.appendMessage(...a),
    pruneHistory: (...a: unknown[]) => mocks.pruneHistory(...a),
  },
  flowExecutionLog: { logFlowEvent: (...a: unknown[]) => mocks.logFlowEvent(...a) },
  pausa: {
    isFlowPaused: vi.fn().mockResolvedValue(false),
    isPaused: vi.fn().mockResolvedValue(false),
  },
  flowClones: {
    resolveModoAtendenteEnabledForSlot: (slot: string, csv?: string | null) =>
      mocks.csvGate(slot, csv),
  },
  outboundMessages: { recordOutbound: (...a: unknown[]) => mocks.recordOutbound(...a) },
}));

vi.mock('@startap/integrations', () => ({
  waha: {
    sendText: (...a: unknown[]) => {
      mocks.order.push('send');
      return mocks.sendText(...a);
    },
  },
}));

vi.mock('../lib/human-reply-pause.js', () => ({
  registerBotReplyEcho: (...a: unknown[]) => {
    mocks.order.push('echo');
    return mocks.registerBotReplyEcho(...a);
  },
}));

import type { BotContext } from '@startap/core/types';
import { BotBase } from './base.js';

const SLOT = 'clone_test_slot';

class OrderTestBot extends BotBase {
  constructor() {
    super({ name: SLOT, projectId: SLOT, pauseTable: null, memoryTable: 'chat_histories' });
  }
  protected async process(): Promise<string | null> {
    return 'olá, tudo certo por aqui!';
  }
}

function ctx(): BotContext {
  return {
    message: {
      sessao: 'MEDUZZA_SESS',
      telefone: '5531999998842',
      chatId: '5531999998842@c.us',
      pushName: 'Cliente',
      texto: 'oi',
      fromMe: false,
      messageId: 'm1',
      timestamp: 0,
      wasAudio: false,
      raw: {},
    },
    executionId: undefined,
    flowId: null,
    flowName: null,
  } as unknown as BotContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.sendText.mockResolvedValue({ messageId: null });
  mocks.registerBotReplyEcho.mockResolvedValue(undefined);
  mocks.recordOutbound.mockResolvedValue(true);
  mocks.appendMessage.mockResolvedValue(undefined);
  mocks.pruneHistory.mockResolvedValue(undefined);
  mocks.logFlowEvent.mockResolvedValue(null);
});

describe('BotBase — ordem eco-antes-do-envio (SCRUM-62, modo atendente)', () => {
  it('marca o eco ANTES de waha.sendText quando o clone está no modo atendente', async () => {
    vi.stubEnv('MODO_ATENDENTE_SLOTS', SLOT);
    await new OrderTestBot().handle(ctx());

    expect(mocks.registerBotReplyEcho).toHaveBeenCalledTimes(1);
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
    // Invariante: 'echo' registrado ANTES de 'send'.
    expect(mocks.order).toEqual(['echo', 'send']);
    // Marca com (sessão, telefone do cliente, texto da resposta).
    expect(mocks.registerBotReplyEcho).toHaveBeenCalledWith(
      'MEDUZZA_SESS',
      '5531999998842',
      'olá, tudo certo por aqui!',
    );
    vi.unstubAllEnvs();
  });

  it('fora do modo atendente: NÃO marca eco (byte-idêntico), só envia', async () => {
    vi.stubEnv('MODO_ATENDENTE_SLOTS', '');
    await new OrderTestBot().handle(ctx());

    expect(mocks.registerBotReplyEcho).not.toHaveBeenCalled();
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
    expect(mocks.order).toEqual(['send']);
    vi.unstubAllEnvs();
  });

  // SCRUM-68 Onda 4: o eco também precisa ser marcado quando o clone está no gate de
  // human-reply da AGENDA (mesmo com o modo atendente OFF) — senão o eco fromMe do próprio
  // bot seria lido como "resposta humana" e o bot se auto-pausaria por 60min.
  it('marca o eco quando o clone está no gate HUMAN_REPLY_AGENDA (modo atendente OFF)', async () => {
    vi.stubEnv('MODO_ATENDENTE_SLOTS', '');
    vi.stubEnv('HUMAN_REPLY_AGENDA_SLOTS', SLOT);
    await new OrderTestBot().handle(ctx());

    expect(mocks.registerBotReplyEcho).toHaveBeenCalledTimes(1);
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
    expect(mocks.order).toEqual(['echo', 'send']);
    expect(mocks.registerBotReplyEcho).toHaveBeenCalledWith(
      'MEDUZZA_SESS',
      '5531999998842',
      'olá, tudo certo por aqui!',
    );
    vi.unstubAllEnvs();
  });

  it('fora de AMBOS os gates (modo E human-reply agenda vazios): NÃO marca eco', async () => {
    vi.stubEnv('MODO_ATENDENTE_SLOTS', '');
    vi.stubEnv('HUMAN_REPLY_AGENDA_SLOTS', '');
    await new OrderTestBot().handle(ctx());

    expect(mocks.registerBotReplyEcho).not.toHaveBeenCalled();
    expect(mocks.order).toEqual(['send']);
    vi.unstubAllEnvs();
  });
});

describe('BotBase — rastreio de entrega (SCRUM-58, MESSAGE_ACK_TRACKING_ENABLED)', () => {
  it('flag ON + id extraído: registra o outbound com slot + telefone-hint MASCARADO', async () => {
    vi.stubEnv('MESSAGE_ACK_TRACKING_ENABLED', 'true');
    mocks.sendText.mockResolvedValue({ messageId: 'true_55@c.us_WAMID1' });

    await new OrderTestBot().handle(ctx());

    expect(mocks.recordOutbound).toHaveBeenCalledTimes(1);
    const arg = mocks.recordOutbound.mock.calls[0][0] as {
      messageId: string;
      session: string;
      slot: string;
      phoneHint: string;
    };
    expect(arg.messageId).toBe('true_55@c.us_WAMID1');
    expect(arg.session).toBe('MEDUZZA_SESS');
    expect(arg.slot).toBe(SLOT);
    // LGPD: nunca o número em claro — hint mascarado (não contém a sequência crua).
    expect(arg.phoneHint).not.toContain('5531999998842');
    expect(arg.phoneHint).toMatch(/•/);
    vi.unstubAllEnvs();
  });

  it('flag OFF: NÃO registra nada (byte-idêntico), só envia', async () => {
    mocks.sendText.mockResolvedValue({ messageId: 'true_55@c.us_WAMID1' });
    await new OrderTestBot().handle(ctx());
    expect(mocks.recordOutbound).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('flag ON mas sem id extraído (messageId null): não registra (nada a correlacionar)', async () => {
    vi.stubEnv('MESSAGE_ACK_TRACKING_ENABLED', 'true');
    mocks.sendText.mockResolvedValue({ messageId: null });
    await new OrderTestBot().handle(ctx());
    expect(mocks.recordOutbound).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('falha ao registrar NUNCA quebra o fluxo (resposta já saiu)', async () => {
    vi.stubEnv('MESSAGE_ACK_TRACKING_ENABLED', 'true');
    mocks.sendText.mockResolvedValue({ messageId: 'true_55@c.us_WAMID1' });
    mocks.recordOutbound.mockRejectedValue(new Error('db down'));
    await expect(new OrderTestBot().handle(ctx())).resolves.toBeUndefined();
    vi.unstubAllEnvs();
  });
});
