import type { WahaWebhookBody } from '@startap/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logFlowEvent: vi.fn(),
  logMessage: vi.fn(),
  isPaused: vi.fn(),
  isFlowPaused: vi.fn(),
  addFlowPause: vi.fn(),
  removeFlowPause: vi.fn(),
  addPause: vi.fn(),
  removePause: vi.fn(),
  listFlowPauseKeywords: vi.fn(),
  findRouting: vi.fn(),
  isFlowActive: vi.fn(),
  sendSeen: vi.fn(),
  downloadMedia: vi.fn(),
  transcribe: vi.fn(),
}));

vi.mock('@startap/db', () => ({
  antibot: { logMessage: mocks.logMessage },
  flowControl: { isFlowActive: mocks.isFlowActive },
  flowExecutionLog: { logFlowEvent: mocks.logFlowEvent },
  pausa: {
    isPaused: mocks.isPaused,
    isFlowPaused: mocks.isFlowPaused,
    addFlowPause: mocks.addFlowPause,
    removeFlowPause: mocks.removeFlowPause,
    addPause: mocks.addPause,
    removePause: mocks.removePause,
    listFlowPauseKeywords: mocks.listFlowPauseKeywords,
  },
  routing: { findRouting: mocks.findRouting },
}));

vi.mock('@startap/integrations', () => ({
  waha: {
    sendSeen: mocks.sendSeen,
    downloadMedia: mocks.downloadMedia,
  },
  whisper: { transcribe: mocks.transcribe },
}));

const { handleWebhook } = await import('./router.js');

function makeBody(session: string): WahaWebhookBody {
  return {
    event: 'message',
    session,
    payload: {
      id: 'msg-1',
      from: '30777769214195@lid',
      fromMe: false,
      body: 'teste de router',
      hasMedia: false,
      _data: {
        key: {
          addressingMode: 'lid',
          remoteJidAlt: '553598877248@s.whatsapp.net',
        },
        pushName: 'Teste',
        messageTimestamp: 1777429228,
      },
    },
  };
}

describe('handleWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logFlowEvent.mockResolvedValue(null);
    mocks.logMessage.mockResolvedValue(undefined);
    mocks.isPaused.mockResolvedValue(false);
    mocks.isFlowPaused.mockResolvedValue(false);
    mocks.addFlowPause.mockResolvedValue(undefined);
    mocks.removeFlowPause.mockResolvedValue(undefined);
    mocks.addPause.mockResolvedValue(undefined);
    mocks.removePause.mockResolvedValue(undefined);
    mocks.listFlowPauseKeywords.mockResolvedValue([
      {
        flow_id: 'dlpKXM3gvX2joC1b',
        command: 'pause',
        keyword: 'startap aqui!!',
        keyword_norm: 'startapaqui!!',
        enabled: true,
        updated_at: new Date(),
      },
    ]);
    mocks.findRouting.mockResolvedValue(null);
    mocks.isFlowActive.mockResolvedValue(true);
    mocks.sendSeen.mockResolvedValue(undefined);
  });

  it('nao usa fallback da Lola para sessao de teste do router', async () => {
    const result = await handleWebhook(makeBody('TESTE_STARTAP'), {
      executionId: 'exec-router-test',
      startedAt: 0,
    });

    expect(result).toEqual({ status: 'ignored:no-routing' });
    expect(mocks.findRouting).toHaveBeenCalledWith('553598877248');
    expect(mocks.isFlowActive).not.toHaveBeenCalled();
    expect(mocks.sendSeen).not.toHaveBeenCalled();

    expect(mocks.logFlowEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: 'uUS3Ux1cU2DquKxo',
        flowName: 'STARTTAP_AI',
      }),
    );
  });

  it('usa fallback da Lola somente na sessao startap oficial', async () => {
    const result = await handleWebhook(makeBody('startap'), {
      executionId: 'exec-startap',
      startedAt: 0,
    });

    expect(result).toEqual({ status: 'error:bot-not-registered' });
    expect(mocks.findRouting).not.toHaveBeenCalled();
    expect(mocks.isFlowActive).toHaveBeenCalledWith('uUS3Ux1cU2DquKxo');
    expect(mocks.logFlowEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: 'uUS3Ux1cU2DquKxo',
        flowName: 'STARTTAP_AI',
        eventType: 'router.route-found',
      }),
    );
  });

  it('pausa separadamente o fluxo roteado em comando manual fromMe', async () => {
    const body = makeBody('TESTE_STARTAP');
    body.payload!.fromMe = true;
    body.payload!.body = 'startap aqui!!';
    mocks.findRouting.mockResolvedValue({
      id: 10,
      telefone: '553598877248',
      workflow_id: 'dlpKXM3gvX2joC1b',
      workflow_name: 'teste_vendas',
      webhook_url: 'http://api/webhooks/waha',
      nome_cliente: 'Teste',
      ativo: true,
      criado_em: new Date(),
      atualizado_em: new Date(),
    });

    const result = await handleWebhook(body, {
      executionId: 'exec-manual-pause',
      startedAt: 0,
    });

    expect(result).toEqual({ status: 'ok:manual-pause' });
    expect(mocks.addFlowPause).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: 'dlpKXM3gvX2joC1b',
        telefone: '553598877248',
      }),
    );
    expect(mocks.sendSeen).not.toHaveBeenCalled();
  });
});
