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
  mocks.sendText.mockResolvedValue(undefined);
  mocks.registerBotReplyEcho.mockResolvedValue(undefined);
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
});
