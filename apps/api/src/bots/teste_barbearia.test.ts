/**
 * Testa o comportamento de cancelamento escalado do TesteBarbeariaBot (Missão 023 W5).
 *
 * Garantias do PM:
 *  - flag OFF -> bot IDÊNTICO ao de hoje: a tool escalar_cancelamento NÃO é exposta ao
 *    modelo, e o botão literal 'Cancelar' NÃO dispara envio de alerta.
 *  - flag ON  -> a tool escalar_cancelamento É exposta; rodá-la ESCALA (mock) e NÃO
 *    cancela; o botão literal 'Cancelar' dispara o alerta (fire-and-forget).
 *  - NENHUMA tool chama delete de GCal (não existe tool de delete no array).
 *  - falha do alerta não quebra o atendimento (sendClientCancellationAlert é mockado e,
 *    mesmo rejeitando, o caminho do botão é fire-and-forget / void).
 *
 * Estratégia: mocka run-agent.js (captura o array `tools` passado) + client-alert.js +
 * as dependências de agenda (gcal/scheduling/render-prompt). Não toca rede/DB.
 */
import type { BotContext } from '@startap/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runAgentConfigured: vi.fn(),
  sendClientCancellationAlert: vi.fn(),
  getGcalForSlot: vi.fn(),
  invalidateGcalCache: vi.fn(),
  loadScheduleConfig: vi.fn(),
  formatarAgendaComConfig: vi.fn(),
  buildContextBlock: vi.fn(),
  renderPrompt: vi.fn(),
  loadHistory: vi.fn(),
  logFlowEvent: vi.fn(),
}));

// O BotBase.loadHistory chama chatMemory.loadHistory (@startap/db) — mocka para não tocar DB.
vi.mock('@startap/db', () => ({
  chatMemory: { loadHistory: mocks.loadHistory },
  flowExecutionLog: { logFlowEvent: mocks.logFlowEvent },
  pausa: {},
}));

// Flag controlada por teste (mutável via objeto).
const cfg = { CANCELAMENTO_ESCALADO_ENABLED: false, IDEMPOTENCY_ACTION_LOCK: false };
vi.mock('../config.js', () => ({ config: cfg }));

vi.mock('../lib/run-agent.js', () => ({ runAgentConfigured: mocks.runAgentConfigured }));
vi.mock('../lib/client-alert.js', () => ({
  sendClientCancellationAlert: mocks.sendClientCancellationAlert,
}));
vi.mock('../lib/action-lock.js', () => ({
  gcalActionLockKey: () => 'k',
  withActionLock: vi.fn(),
}));
vi.mock('../lib/render-prompt.js', () => ({ renderPrompt: mocks.renderPrompt }));
vi.mock('@startap/integrations', () => ({
  gcal: { getGcalForSlot: mocks.getGcalForSlot, invalidateGcalCache: mocks.invalidateGcalCache },
}));
vi.mock('@startap/integrations/scheduling', () => ({
  loadScheduleConfig: mocks.loadScheduleConfig,
  formatarAgendaComConfig: mocks.formatarAgendaComConfig,
  buildContextBlock: mocks.buildContextBlock,
}));

const { TesteBarbeariaBot } = await import('./teste_barbearia.js');

function makeCtx(texto: string): BotContext {
  return {
    flowId: 'f1',
    message: { telefone: '5511988887777', texto, pushName: 'Fulano', chatId: 'c', sessao: 's' },
  } as unknown as BotContext;
}

/** Configura os mocks de agenda p/ um fluxo NÃO-cancelamento completar até o runAgent. */
function setupSchedule() {
  const calClient = { listEvents: vi.fn().mockResolvedValue([]) };
  mocks.getGcalForSlot.mockResolvedValue(calClient);
  mocks.loadScheduleConfig.mockResolvedValue({ source: 'flow_clones', services: [] });
  mocks.formatarAgendaComConfig.mockReturnValue('AGENDA');
  mocks.renderPrompt.mockResolvedValue('PERSONA');
  mocks.buildContextBlock.mockResolvedValue('CONTEXT');
  mocks.runAgentConfigured.mockResolvedValue({ reply: 'ok' });
  mocks.loadHistory.mockResolvedValue([{ role: 'user', content: 'oi' }]);
  return calClient;
}

/** Roda process() e devolve o array `tools` que o bot passou ao runAgent. */
async function toolsPassedFor(texto: string): Promise<Array<{ name: string }>> {
  setupSchedule();
  const bot = new TesteBarbeariaBot();
  // process é protected — acessa via cast (padrão dos testes de bot).
  await (bot as unknown as { process: (c: BotContext) => Promise<string | null> }).process(
    makeCtx(texto),
  );
  return mocks.runAgentConfigured.mock.calls[0][0].tools;
}

describe('TesteBarbeariaBot — cancelamento escalado (W5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cfg.CANCELAMENTO_ESCALADO_ENABLED = false;
  });

  it('flag OFF: tool escalar_cancelamento NÃO é exposta (bot inalterado)', async () => {
    const tools = await toolsPassedFor('quero marcar um corte');
    const names = tools.map((t) => t.name);
    expect(names).toContain('inserir_agendamento');
    expect(names).toContain('consultar_agendamento');
    expect(names).not.toContain('escalar_cancelamento');
  });

  it('flag OFF: botão "Cancelar" responde como hoje e NÃO escala', async () => {
    const bot = new TesteBarbeariaBot();
    const reply = await (
      bot as unknown as { process: (c: BotContext) => Promise<string | null> }
    ).process(makeCtx('Cancelar'));
    expect(reply).toBe('ok! vou avisar o time, e logo entraremos em contato!');
    expect(mocks.sendClientCancellationAlert).not.toHaveBeenCalled();
    // não toca agenda no caminho de cancelamento
    expect(mocks.getGcalForSlot).not.toHaveBeenCalled();
  });

  it('flag ON: tool escalar_cancelamento É exposta', async () => {
    cfg.CANCELAMENTO_ESCALADO_ENABLED = true;
    const tools = await toolsPassedFor('quero marcar um corte');
    expect(tools.map((t) => t.name)).toContain('escalar_cancelamento');
  });

  it('NENHUMA tool tem nome de delete/remover de GCal', async () => {
    cfg.CANCELAMENTO_ESCALADO_ENABLED = true;
    const tools = await toolsPassedFor('quero marcar um corte');
    for (const t of tools) {
      expect(t.name).not.toMatch(/delete|remover|cancelar_agendamento|excluir/i);
    }
  });

  it('flag ON: rodar a tool ESCALA (mock) e retorna {ok,escalado} sem cancelar', async () => {
    cfg.CANCELAMENTO_ESCALADO_ENABLED = true;
    mocks.sendClientCancellationAlert.mockResolvedValue({ ok: true, escalado: true });
    const tools = await toolsPassedFor('quero marcar um corte');
    const tool = tools.find((t) => t.name === 'escalar_cancelamento') as unknown as {
      run: (a: unknown) => Promise<{ ok: boolean; escalado: boolean }>;
    };
    const res = await tool.run({ motivo: 'viajei', referencia_horario: 'sexta 10h' });
    expect(res).toEqual({ ok: true, escalado: true });
    expect(mocks.sendClientCancellationAlert).toHaveBeenCalledTimes(1);
    const arg = mocks.sendClientCancellationAlert.mock.calls[0][0];
    expect(arg).toMatchObject({ motivo: 'viajei', referenciaHorario: 'sexta 10h' });
  });

  it('flag ON: falha do alerta NÃO quebra a tool (resultado ainda volta pro modelo)', async () => {
    cfg.CANCELAMENTO_ESCALADO_ENABLED = true;
    // sendClientCancellationAlert é fail-safe e devolve {ok:false}; a tool não relança.
    mocks.sendClientCancellationAlert.mockResolvedValue({
      ok: false,
      escalado: false,
      reason: 'error',
    });
    const tools = await toolsPassedFor('quero marcar um corte');
    const tool = tools.find((t) => t.name === 'escalar_cancelamento') as unknown as {
      run: (a: unknown) => Promise<{ ok: boolean; escalado: boolean }>;
    };
    const res = await tool.run({});
    expect(res).toEqual({ ok: true, escalado: false });
  });

  it('flag ON: botão "Cancelar" dispara o alerta (fire-and-forget) e NÃO cancela', async () => {
    cfg.CANCELAMENTO_ESCALADO_ENABLED = true;
    mocks.sendClientCancellationAlert.mockResolvedValue({ ok: true, escalado: true });
    const bot = new TesteBarbeariaBot();
    const reply = await (
      bot as unknown as { process: (c: BotContext) => Promise<string | null> }
    ).process(makeCtx('Cancelar'));
    expect(reply).toBe('ok! vou avisar o time, e logo entraremos em contato!');
    expect(mocks.sendClientCancellationAlert).toHaveBeenCalledTimes(1);
    expect(mocks.getGcalForSlot).not.toHaveBeenCalled(); // não toca agenda
  });
});
