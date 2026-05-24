import type { WahaWebhookBody } from '@startap/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBotEntry } from './registry.js';

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
  getCloneBySession: vi.fn().mockResolvedValue(null),
  getCloneBySlot: vi.fn().mockResolvedValue(null),
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
  flowClones: {
    getCloneBySession: mocks.getCloneBySession,
    getCloneBySlot: mocks.getCloneBySlot,
  },
}));

vi.mock('@startap/integrations', () => ({
  waha: {
    sendSeen: mocks.sendSeen,
    downloadMedia: mocks.downloadMedia,
  },
  whisper: { transcribe: mocks.transcribe },
}));

const { handleWebhook } = await import('./router.js');

// Bot stub para sessão 'startap' — simula o que startap.ts faz ao ser importado.
const STARTAP_WORKFLOW_ID = 'uUS3Ux1cU2DquKxo';
const STARTAP_WORKFLOW_NAME = 'STARTAP_AI';
const stubBot = { name: 'startap', handle: vi.fn() };
registerBotEntry({
  workflowId: STARTAP_WORKFLOW_ID,
  workflowName: STARTAP_WORKFLOW_NAME,
  ownedSessions: ['startap', 'startap_ai', 'startap_ai_prod'],
  legacyPauseTable: 'pause_startap',
  getManualCommand: () => null,
  applyManualCommand: async () => {},
  bot: stubBot,
});

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
        flow_id: 'flow-generica-001',
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
        flowName: 'STARTAP_AI',
      }),
    );
  });

  it('usa fallback da Lola somente na sessao startap oficial', async () => {
    stubBot.handle.mockResolvedValue(undefined);
    const result = await handleWebhook(makeBody('startap'), {
      executionId: 'exec-startap',
      startedAt: 0,
    });

    // Sessão 'startap' tem BotEntry no registry → buildFallbackRoute → isFlowActive.
    // findRouting não é chamado para sessões com entry próprio.
    expect(result).toEqual({ status: 'ok' });
    expect(mocks.findRouting).not.toHaveBeenCalled();
    expect(mocks.isFlowActive).toHaveBeenCalledWith('uUS3Ux1cU2DquKxo');
    expect(mocks.logFlowEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: 'uUS3Ux1cU2DquKxo',
        flowName: 'STARTAP_AI',
        eventType: 'router.route-found',
      }),
    );
  });

  it('pausa fluxo roteado via routing_clientes em comando manual fromMe', async () => {
    const body = makeBody('TESTE_STARTAP');
    body.payload!.fromMe = true;
    body.payload!.body = 'startap aqui!!';
    mocks.findRouting.mockResolvedValue({
      id: 10,
      telefone: '553598877248',
      workflow_id: 'flow-generica-001',
      workflow_name: 'fluxo_generico',
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
        flowId: 'flow-generica-001',
        telefone: '553598877248',
      }),
    );
    expect(mocks.sendSeen).not.toHaveBeenCalled();
  });

  it('ignora mensagem de grupo com @g.us no from', async () => {
    const body: WahaWebhookBody = {
      event: 'message',
      session: 'STARTAP_AI_PROD',
      payload: {
        id: 'group-msg-1',
        from: '120363141126402430@g.us',
        fromMe: false,
        body: 'oi pessoal',
        hasMedia: false,
        _data: {
          key: { addressingMode: 'pn' },
          pushName: 'Fulano',
          messageTimestamp: 1777429228,
        },
      },
    };

    const result = await handleWebhook(body, { executionId: 'exec-group-1', startedAt: 0 });

    expect(result).toEqual({ status: 'ignored:group-chat' });
    // Nao deve chamar bot, antibot nem routing
    expect(mocks.logMessage).not.toHaveBeenCalled();
    expect(mocks.findRouting).not.toHaveBeenCalled();
    expect(mocks.sendSeen).not.toHaveBeenCalled();
  });

  it('ignora mensagem de grupo com JID 120363 (NOWEB sem @g.us)', async () => {
    const body: WahaWebhookBody = {
      event: 'message',
      session: 'ricardo_curso_barbearia',
      payload: {
        id: 'group-msg-2',
        from: '120363049484570625',
        fromMe: false,
        body: 'texto do grupo',
        hasMedia: false,
        _data: {
          key: { addressingMode: 'pn', remoteJidAlt: '120363049484570625' },
          pushName: 'Beltrano',
          messageTimestamp: 1777429228,
        },
      },
    };

    const result = await handleWebhook(body, { executionId: 'exec-group-2', startedAt: 0 });

    expect(result).toEqual({ status: 'ignored:group-chat' });
    expect(mocks.logMessage).not.toHaveBeenCalled();
    expect(mocks.sendSeen).not.toHaveBeenCalled();
  });

  it('ignora mensagem de grupo com campo participant preenchido (LID de 22 digitos)', async () => {
    const body = {
      event: 'message',
      session: 'ricardo_curso_barbearia',
      payload: {
        id: 'group-msg-3',
        from: '5592813522781591200729',
        fromMe: false,
        body: 'foto do grupo',
        hasMedia: true,
        participant: '5592813522781@s.whatsapp.net',
        _data: {
          key: { addressingMode: 'pn' },
          pushName: 'Ciclano',
          messageTimestamp: 1777429228,
        },
      },
    } as WahaWebhookBody;

    const result = await handleWebhook(body, { executionId: 'exec-group-3', startedAt: 0 });

    expect(result).toEqual({ status: 'ignored:group-chat' });
    expect(mocks.logMessage).not.toHaveBeenCalled();
    expect(mocks.sendSeen).not.toHaveBeenCalled();
  });

  it('nao ignora conversa 1:1 valida (regressao)', async () => {
    // Garante que o filtro de grupo nao quebra atendimento individual
    mocks.findRouting.mockResolvedValue({
      id: 99,
      telefone: '553598877248',
      workflow_id: 'flow-generica-001',
      workflow_name: 'teste_barbearia',
      webhook_url: null,
      nome_cliente: 'Cliente Individual',
      ativo: true,
      criado_em: new Date(),
      atualizado_em: new Date(),
    });
    const botHandle = vi.fn().mockResolvedValue(undefined);
    const { registerBot } = await import('./router.js');
    registerBot('flow-generica-001', { name: 'fluxo_generico', handle: botHandle });

    const body: WahaWebhookBody = {
      event: 'message',
      session: 'TESTE_STARTAP',
      payload: {
        id: 'direct-msg-1',
        from: '553598877248@c.us',
        fromMe: false,
        body: 'quero agendar',
        hasMedia: false,
        _data: {
          key: { addressingMode: 'pn' },
          pushName: 'Cliente Real',
          messageTimestamp: 1777429228,
        },
      },
    };

    const result = await handleWebhook(body, { executionId: 'exec-direct-1', startedAt: 0 });

    expect(result).toEqual({ status: 'ok' });
    expect(botHandle).toHaveBeenCalledTimes(1);
    expect(mocks.logMessage).toHaveBeenCalled();
  });

});
