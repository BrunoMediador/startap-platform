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
  getGcalsForSlot: vi.fn(),
  invalidateGcalCache: vi.fn(),
  invalidateGcalsForSlot: vi.fn(),
  loadScheduleConfig: vi.fn(),
  formatarAgendaComConfig: vi.fn(),
  buildContextBlock: vi.fn(),
  buildEstabelecimentoContext: vi.fn(),
  getProductType: vi.fn(),
  renderPrompt: vi.fn(),
  loadHistory: vi.fn(),
  logFlowEvent: vi.fn(),
}));

// O BotBase.loadHistory chama chatMemory.loadHistory (@startap/db) — mocka para não tocar DB.
vi.mock('@startap/db', () => ({
  chatMemory: { loadHistory: mocks.loadHistory },
  flowExecutionLog: { logFlowEvent: mocks.logFlowEvent },
  cloneColaboradores: { getProductType: mocks.getProductType },
  pausa: {},
}));

// Flag controlada por teste (mutável via objeto).
const cfg = {
  CANCELAMENTO_ESCALADO_ENABLED: false,
  IDEMPOTENCY_ACTION_LOCK: false,
  ESTABELECIMENTO_ENABLED: false,
};
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
  gcal: {
    getGcalForSlot: mocks.getGcalForSlot,
    getGcalsForSlot: mocks.getGcalsForSlot,
    invalidateGcalCache: mocks.invalidateGcalCache,
    invalidateGcalsForSlot: mocks.invalidateGcalsForSlot,
  },
}));
// resolveColaboradorByShortId roda DE VERDADE (não mockado): é a barreira server-side
// de validação/rejeição que queremos exercitar no inserir_agendamento do estabelecimento.
vi.mock('@startap/integrations/scheduling', async () => {
  const real = await vi.importActual<typeof import('@startap/integrations/scheduling')>(
    '@startap/integrations/scheduling',
  );
  return {
    loadScheduleConfig: mocks.loadScheduleConfig,
    formatarAgendaComConfig: mocks.formatarAgendaComConfig,
    buildContextBlock: mocks.buildContextBlock,
    buildEstabelecimentoContext: mocks.buildEstabelecimentoContext,
    resolveColaboradorByShortId: real.resolveColaboradorByShortId,
  };
});

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
  // Default: slot é individual (caminho atual). Testes de estabelecimento sobrescrevem.
  mocks.getProductType.mockResolvedValue('individual');
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
    cfg.ESTABELECIMENTO_ENABLED = false;
    cfg.IDEMPOTENCY_ACTION_LOCK = false;
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

// ════════════════════════════════════════════════════════════════════════════════
// Estabelecimento multi-colaborador (ADR 0023/0024, Fase A — BLOCO 1)
// ════════════════════════════════════════════════════════════════════════════════

/** Stub de client de colaborador: listEvents/createEvent espionáveis. */
function colabClientStub(calendarId: string, existing: unknown[] = []) {
  return {
    calendarId,
    listEvents: vi.fn().mockResolvedValue(existing),
    createEvent: vi.fn().mockResolvedValue({ id: `evt-${calendarId}`, summary: 'S' }),
  };
}

/** Configura os mocks para o caminho ESTABELECIMENTO completar até o runAgent. */
function setupEstabelecimento(
  colaboradores: Array<{ colaboradorId: number; nome: string; shortId: string; client: unknown }>,
) {
  cfg.ESTABELECIMENTO_ENABLED = true;
  mocks.getProductType.mockResolvedValue('estabelecimento');
  mocks.loadScheduleConfig.mockResolvedValue({ source: 'flow_clones', services: [] });
  mocks.renderPrompt.mockResolvedValue('PERSONA');
  mocks.buildContextBlock.mockResolvedValue('CONTEXT');
  mocks.runAgentConfigured.mockResolvedValue({ reply: 'ok' });
  mocks.loadHistory.mockResolvedValue([{ role: 'user', content: 'oi' }]);
  // O resolvedor por colaborador devolve a lista crua (sem shortId).
  mocks.getGcalsForSlot.mockResolvedValue(
    colaboradores.map((c) => ({
      colaboradorId: c.colaboradorId,
      nome: c.nome,
      calendarId: (c.client as { calendarId: string }).calendarId,
      client: c.client,
    })),
  );
  // buildEstabelecimentoContext devolve a lista JÁ decorada com shortId (o que o bot usa
  // pra resolver o colaborador_id depois) + blocos prontos.
  mocks.buildEstabelecimentoContext.mockResolvedValue({
    colaboradores: colaboradores.map((c) => ({
      colaboradorId: c.colaboradorId,
      nome: c.nome,
      calendarId: (c.client as { calendarId: string }).calendarId,
      client: c.client,
      shortId: c.shortId,
    })),
    profissionaisBlock: 'PROFISSIONAIS',
    horariosBlock: 'HORARIOS',
  });
}

/** Roda process() pro estabelecimento e devolve o array `tools` passado ao runAgent. */
async function estabToolsFor(
  texto: string,
  colaboradores: Array<{ colaboradorId: number; nome: string; shortId: string; client: unknown }>,
): Promise<Array<{ name: string; run: (a: unknown) => Promise<unknown> }>> {
  setupEstabelecimento(colaboradores);
  const bot = new TesteBarbeariaBot({ slotOverride: 'clone_estab_x' });
  await (bot as unknown as { process: (c: BotContext) => Promise<string | null> }).process(
    makeCtx(texto),
  );
  return mocks.runAgentConfigured.mock.calls[0][0].tools;
}

describe('TesteBarbeariaBot — estabelecimento (BLOCO 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cfg.CANCELAMENTO_ESCALADO_ENABLED = false;
    cfg.ESTABELECIMENTO_ENABLED = false;
    cfg.IDEMPOTENCY_ACTION_LOCK = false;
  });

  // (a) individual byte-a-byte inalterado mesmo com a flag LIGADA, se product_type=individual.
  it('flag ON + product_type=individual → caminho individual intacto (não chama getGcalsForSlot)', async () => {
    cfg.ESTABELECIMENTO_ENABLED = true;
    setupSchedule(); // getProductType -> 'individual'
    const bot = new TesteBarbeariaBot();
    await (bot as unknown as { process: (c: BotContext) => Promise<string | null> }).process(
      makeCtx('quero marcar um corte'),
    );
    // Usou o resolvedor INDIVIDUAL (1 agenda), nunca o de colaboradores.
    expect(mocks.getGcalForSlot).toHaveBeenCalledTimes(1);
    expect(mocks.getGcalsForSlot).not.toHaveBeenCalled();
    expect(mocks.buildEstabelecimentoContext).not.toHaveBeenCalled();
    // A tool individual NÃO tem colaborador_id (contrato inalterado).
    const tools = mocks.runAgentConfigured.mock.calls[0][0].tools as Array<{
      name: string;
      parameters: { properties: Record<string, unknown> };
    }>;
    const inserir = tools.find((t) => t.name === 'inserir_agendamento');
    expect(inserir?.parameters.properties).not.toHaveProperty('colaborador_id');
  });

  // (b) estabelecimento monta agenda por colaborador via resolvedor + contexto batched.
  it('flag ON + estabelecimento → usa getGcalsForSlot + buildEstabelecimentoContext (não o individual)', async () => {
    const c1 = colabClientStub('cal-joao');
    const tools = await estabToolsFor('quero um corte', [
      { colaboradorId: 10, nome: 'João S.', shortId: 'C1', client: c1 },
    ]);
    expect(mocks.getGcalsForSlot).toHaveBeenCalledWith('clone_estab_x');
    expect(mocks.buildEstabelecimentoContext).toHaveBeenCalledTimes(1);
    expect(mocks.getGcalForSlot).not.toHaveBeenCalled(); // nunca usa a agenda principal do clone
    // inserir_agendamento exige colaborador_id no estabelecimento.
    const inserir = tools.find((t) => t.name === 'inserir_agendamento') as unknown as {
      parameters: { required: string[]; properties: Record<string, unknown> };
    };
    expect(inserir.parameters.properties).toHaveProperty('colaborador_id');
    expect(inserir.parameters.required).toContain('colaborador_id');
  });

  it('estabelecimento sem colaborador agendável → silencia (NÃO cai pro individual)', async () => {
    cfg.ESTABELECIMENTO_ENABLED = true;
    mocks.getProductType.mockResolvedValue('estabelecimento');
    mocks.getGcalsForSlot.mockResolvedValue([]); // nenhum colaborador ativo
    const bot = new TesteBarbeariaBot({ slotOverride: 'clone_estab_x' });
    const reply = await (
      bot as unknown as { process: (c: BotContext) => Promise<string | null> }
    ).process(makeCtx('quero um corte'));
    expect(reply).toBeNull();
    expect(mocks.getGcalForSlot).not.toHaveBeenCalled(); // sem fallback p/ agenda do clone
    expect(mocks.runAgentConfigured).not.toHaveBeenCalled();
  });

  // (c) inserir_agendamento roteia pro calendarId CERTO e rejeita colaborador inválido.
  it('inserir_agendamento roteia pro calendarId do colaborador escolhido (C2)', async () => {
    const c1 = colabClientStub('cal-joao');
    const c2 = colabClientStub('cal-maria');
    const tools = await estabToolsFor('quero um corte', [
      { colaboradorId: 10, nome: 'João S.', shortId: 'C1', client: c1 },
      { colaboradorId: 11, nome: 'Maria', shortId: 'C2', client: c2 },
    ]);
    const inserir = tools.find((t) => t.name === 'inserir_agendamento') as {
      run: (a: unknown) => Promise<{ ok: boolean; eventId?: string; colaborador_nome?: string }>;
    };
    const res = await inserir.run({
      colaborador_id: 'C2',
      summary: 'Cliente - Corte',
      start: '2026-06-16T13:00:00-03:00',
      end: '2026-06-16T13:30:00-03:00',
    });
    expect(res.ok).toBe(true);
    expect(res.colaborador_nome).toBe('Maria');
    // Criou na agenda da Maria (cal-maria), NUNCA na do João.
    expect(c2.createEvent).toHaveBeenCalledTimes(1);
    expect(c1.createEvent).not.toHaveBeenCalled();
    // O overlap também foi checado SÓ na agenda do colaborador escolhido.
    expect(c2.listEvents).toHaveBeenCalled();
  });

  it('inserir_agendamento REJEITA colaborador_id inválido/de outro slot (sem criar evento)', async () => {
    const c1 = colabClientStub('cal-joao');
    const tools = await estabToolsFor('quero um corte', [
      { colaboradorId: 10, nome: 'João S.', shortId: 'C1', client: c1 },
    ]);
    const inserir = tools.find((t) => t.name === 'inserir_agendamento') as {
      run: (a: unknown) => Promise<{ ok: boolean; error?: string }>;
    };
    // C9 não existe na lista deste slot (id de outro estabelecimento / inativo).
    const res = await inserir.run({
      colaborador_id: 'C9',
      summary: 'Cliente - Corte',
      start: '2026-06-16T13:00:00-03:00',
      end: '2026-06-16T13:30:00-03:00',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('COLABORADOR_INVALIDO');
    // NENHUM evento criado, NENHUMA agenda consultada (rejeitado antes de tocar GCal).
    expect(c1.createEvent).not.toHaveBeenCalled();
    expect(c1.listEvents).not.toHaveBeenCalled();
  });

  it('inserir_agendamento REJEITA calendarId cru (LLM nunca passa agenda direto)', async () => {
    const c1 = colabClientStub('cal-joao');
    const tools = await estabToolsFor('quero um corte', [
      { colaboradorId: 10, nome: 'João S.', shortId: 'C1', client: c1 },
    ]);
    const inserir = tools.find((t) => t.name === 'inserir_agendamento') as {
      run: (a: unknown) => Promise<{ ok: boolean; error?: string }>;
    };
    const res = await inserir.run({
      colaborador_id: 'cal-joao', // tentativa de passar o calendarId cru
      summary: 'x',
      start: '2026-06-16T13:00:00-03:00',
      end: '2026-06-16T13:30:00-03:00',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('COLABORADOR_INVALIDO');
    expect(c1.createEvent).not.toHaveBeenCalled();
  });
});
