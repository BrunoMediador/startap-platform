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
  sendOwnerAlert: vi.fn(),
  addFlowPause: vi.fn(),
  getGcalForSlot: vi.fn(),
  getGcalsForSlot: vi.fn(),
  invalidateGcalCache: vi.fn(),
  invalidateGcalsForSlot: vi.fn(),
  loadScheduleConfig: vi.fn(),
  formatarAgendaComConfig: vi.fn(),
  buildContextBlock: vi.fn(),
  buildEstabelecimentoContext: vi.fn(),
  getProductType: vi.fn(),
  listColaboradores: vi.fn(),
  getArea: vi.fn(),
  renderPrompt: vi.fn(),
  loadHistory: vi.fn(),
  logFlowEvent: vi.fn(),
  resolveClientPackages: vi.fn(),
  buildSeuPacoteBlock: vi.fn(),
  deduzirPacoteNoAgendamento: vi.fn(),
  servicoFromSummary: vi.fn(),
  clienteFromSummary: vi.fn(),
  getCloneBySlot: vi.fn(),
  getScopeBySlot: vi.fn(),
  upsertAtendimentoFromEvent: vi.fn(),
  syncAtendimentoFromEvent: vi.fn(),
  withActionLock: vi.fn(),
  // Resolver env→coluna (ADR 0030 D1) mockado como env-only — os testes exercitam o gate por env
  // (cfg.MODO_ATENDENTE_SLOTS / ATEND_FROM_AGENDA_SLOTS); NÃO lê getCloneBySlot (mantém as
  // asserções de "getCloneBySlot não chamado" intactas). Byte-idêntico ao gate de antes.
  csvGate: (slot: string, csv?: string | null): boolean => {
    if (!csv) return false;
    const e = csv
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return e.includes('*') || e.includes(slot);
  },
}));

// O BotBase.loadHistory chama chatMemory.loadHistory (@startap/db) — mocka para não tocar DB.
vi.mock('@startap/db', () => ({
  chatMemory: { loadHistory: mocks.loadHistory },
  flowExecutionLog: { logFlowEvent: mocks.logFlowEvent },
  cloneColaboradores: {
    getProductType: mocks.getProductType,
    listBySlot: mocks.listColaboradores,
    getArea: mocks.getArea,
    getScopeBySlot: mocks.getScopeBySlot,
  },
  flowClones: {
    getCloneBySlot: mocks.getCloneBySlot,
    resolveModoAtendenteEnabledForSlot: (slot: string, csv?: string | null) =>
      mocks.csvGate(slot, csv),
    resolveAtendFromAgendaEnabledForSlot: (slot: string, csv?: string | null) =>
      mocks.csvGate(slot, csv),
  },
  atendimentos: {
    upsertAtendimentoFromEvent: mocks.upsertAtendimentoFromEvent,
    syncAtendimentoFromEvent: mocks.syncAtendimentoFromEvent,
  },
  pausa: { addFlowPause: mocks.addFlowPause },
}));

// Flag controlada por teste (mutável via objeto).
const cfg = {
  CANCELAMENTO_ESCALADO_ENABLED: false,
  IDEMPOTENCY_ACTION_LOCK: false,
  ESTABELECIMENTO_ENABLED: false,
  PACOTES_ENABLED: false,
  // Gate POR-CLONE (ADR 0027): lista de slots; vazio = OFF pra todos (default seguro).
  ATEND_FROM_AGENDA_SLOTS: '',
  // Gate POR-CLONE do MODO ATENDENTE (SCRUM-59): CSV de slots; vazio = OFF pra todos.
  MODO_ATENDENTE_SLOTS: '',
};
vi.mock('../config.js', () => ({ config: cfg }));

vi.mock('../lib/run-agent.js', () => ({ runAgentConfigured: mocks.runAgentConfigured }));
vi.mock('../lib/client-alert.js', () => ({
  sendClientCancellationAlert: mocks.sendClientCancellationAlert,
  sendOwnerAlert: mocks.sendOwnerAlert,
}));
vi.mock('../lib/package-context.js', () => ({
  resolveClientPackages: mocks.resolveClientPackages,
  buildSeuPacoteBlock: mocks.buildSeuPacoteBlock,
  deduzirPacoteNoAgendamento: mocks.deduzirPacoteNoAgendamento,
  servicoFromSummary: mocks.servicoFromSummary,
  clienteFromSummary: mocks.clienteFromSummary,
}));
vi.mock('../lib/action-lock.js', () => ({
  gcalActionLockKey: () => 'k',
  withActionLock: mocks.withActionLock,
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
    // validação serviço×profissional (Bug 2) usa a lógica REAL — queremos exercitá-la.
    colaboradorFazServico: real.colaboradorFazServico,
    servicosDoColaborador: real.servicosDoColaborador,
    // reancoragem de fuso (migration 068) usa a lógica REAL — clone SP = no-op (byte-idêntico).
    reanchorWallTimeToTz: real.reanchorWallTimeToTz,
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
  mocks.loadScheduleConfig.mockResolvedValue({
    source: 'flow_clones',
    services: [],
    timezone: 'America/Sao_Paulo',
  });
  mocks.formatarAgendaComConfig.mockReturnValue('AGENDA');
  mocks.renderPrompt.mockResolvedValue('PERSONA');
  mocks.buildContextBlock.mockResolvedValue('CONTEXT');
  mocks.runAgentConfigured.mockResolvedValue({ reply: 'ok' });
  mocks.loadHistory.mockResolvedValue([{ role: 'user', content: 'oi' }]);
  // Default: slot é individual (caminho atual). Testes de estabelecimento sobrescrevem.
  mocks.getProductType.mockResolvedValue('individual');
  // Default: área barbearia (Cirilo/Samuel) → buildCartaoEmojiOverrideBlock devolve
  // '' → systemPrompt byte-a-byte o de hoje. Testes de outras áreas sobrescrevem.
  mocks.getArea.mockResolvedValue('barbearia');
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
    cfg.PACOTES_ENABLED = false;
    cfg.ATEND_FROM_AGENDA_SLOTS = '';
    cfg.MODO_ATENDENTE_SLOTS = '';
    // Defaults inertes: sem pacote / bloco vazio (cliente sem pacote).
    mocks.resolveClientPackages.mockResolvedValue([]);
    mocks.buildSeuPacoteBlock.mockReturnValue('');
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

/** Stub de client de colaborador: listEvents/createEvent/patchEvent espionáveis. */
function colabClientStub(calendarId: string, existing: unknown[] = []) {
  return {
    calendarId,
    listEvents: vi.fn().mockResolvedValue(existing),
    createEvent: vi.fn().mockResolvedValue({ id: `evt-${calendarId}`, summary: 'S' }),
    // patchEvent ecoa o eventId recebido (preserva o id) + a nova janela — é o coração da
    // remarcação (NUNCA delete+create). Testes de reschedule sobrescrevem o retorno se preciso.
    patchEvent: vi
      .fn()
      .mockImplementation((eventId: string, fields: { startISO?: string; endISO?: string }) =>
        Promise.resolve({
          id: eventId,
          summary: 'S',
          start: { dateTime: fields.startISO },
          end: { dateTime: fields.endISO },
        }),
      ),
  };
}

/** Colaborador de teste: id curto + nome + client; servicos opcional (Bug 2). */
type EstabColab = {
  colaboradorId: number;
  nome: string;
  shortId: string;
  client: unknown;
  servicos?: string[];
};

/** Configura os mocks para o caminho ESTABELECIMENTO completar até o runAgent. */
function setupEstabelecimento(
  colaboradores: EstabColab[],
  opts?: { services?: Array<{ name: string; min: number }> },
) {
  cfg.ESTABELECIMENTO_ENABLED = true;
  mocks.getProductType.mockResolvedValue('estabelecimento');
  // Default barbearia → cartão de estabelecimento byte-a-byte o do #325.
  mocks.getArea.mockResolvedValue('barbearia');
  mocks.loadScheduleConfig.mockResolvedValue({
    source: 'flow_clones',
    services: opts?.services ?? [],
    timezone: 'America/Sao_Paulo',
  });
  mocks.renderPrompt.mockResolvedValue('PERSONA');
  mocks.buildContextBlock.mockResolvedValue('CONTEXT');
  mocks.runAgentConfigured.mockResolvedValue({ reply: 'ok' });
  mocks.loadHistory.mockResolvedValue([{ role: 'user', content: 'oi' }]);
  // O resolvedor por colaborador devolve a lista crua (sem shortId), JÁ com servicos
  // (migration 057 — projetada em getGcalsForSlot). [] = faz todos os globais.
  mocks.getGcalsForSlot.mockResolvedValue(
    colaboradores.map((c) => ({
      colaboradorId: c.colaboradorId,
      nome: c.nome,
      calendarId: (c.client as { calendarId: string }).calendarId,
      client: c.client,
      servicos: c.servicos ?? [],
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
      servicos: c.servicos ?? [],
    })),
    profissionaisBlock: 'PROFISSIONAIS',
    horariosBlock: 'HORARIOS',
  });
}

/** Roda process() pro estabelecimento e devolve o array `tools` passado ao runAgent. */
async function estabToolsFor(
  texto: string,
  colaboradores: EstabColab[],
  opts?: { services?: Array<{ name: string; min: number }> },
): Promise<Array<{ name: string; run: (a: unknown) => Promise<unknown> }>> {
  setupEstabelecimento(colaboradores, opts);
  const bot = new TesteBarbeariaBot({ slotOverride: 'clone_estab_x' });
  await (bot as unknown as { process: (c: BotContext) => Promise<string | null> }).process(
    makeCtx(texto),
  );
  return mocks.runAgentConfigured.mock.calls[0][0].tools;
}

/** Roda process() pro estabelecimento e devolve o systemPrompt passado ao runAgent. */
async function estabSystemPromptFor(texto: string, colaboradores: EstabColab[]): Promise<string> {
  setupEstabelecimento(colaboradores);
  const bot = new TesteBarbeariaBot({ slotOverride: 'clone_estab_x' });
  await (bot as unknown as { process: (c: BotContext) => Promise<string | null> }).process(
    makeCtx(texto),
  );
  return mocks.runAgentConfigured.mock.calls[0][0].systemPrompt;
}

describe('TesteBarbeariaBot — estabelecimento (BLOCO 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cfg.CANCELAMENTO_ESCALADO_ENABLED = false;
    cfg.ESTABELECIMENTO_ENABLED = false;
    cfg.IDEMPOTENCY_ACTION_LOCK = false;
    cfg.PACOTES_ENABLED = false;
    cfg.ATEND_FROM_AGENDA_SLOTS = '';
    cfg.MODO_ATENDENTE_SLOTS = '';
    // Defaults inertes: sem pacote / bloco vazio (cliente sem pacote).
    mocks.resolveClientPackages.mockResolvedValue([]);
    mocks.buildSeuPacoteBlock.mockReturnValue('');
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

  // (d) Bug 2: serviço×profissional — Maria não faz "Corte" → rejeita SEM criar evento.
  it('inserir_agendamento REJEITA serviço que o profissional não faz (Maria × Corte)', async () => {
    const cBruno = colabClientStub('cal-bruno');
    const cMaria = colabClientStub('cal-maria');
    const tools = await estabToolsFor(
      'quero cortar com a maria',
      [
        { colaboradorId: 10, nome: 'Bruno', shortId: 'C1', client: cBruno, servicos: ['Corte'] },
        {
          colaboradorId: 11,
          nome: 'Maria',
          shortId: 'C2',
          client: cMaria,
          servicos: ['Manicure'],
        },
      ],
      {
        services: [
          { name: 'Corte', min: 30 },
          { name: 'Manicure', min: 40 },
        ],
      },
    );
    const inserir = tools.find((t) => t.name === 'inserir_agendamento') as {
      run: (a: unknown) => Promise<{ ok: boolean; error?: string; message?: string }>;
    };
    const res = await inserir.run({
      colaborador_id: 'C2', // Maria
      summary: 'Cliente - Corte',
      servico: 'Corte',
      start: '2026-06-16T13:00:00-03:00',
      end: '2026-06-16T13:30:00-03:00',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('SERVICO_NAO_OFERECIDO');
    expect(res.message).toMatch(/Maria/);
    expect(res.message).toMatch(/Manicure/); // sugere o que ela faz
    // NENHUM evento criado e NENHUMA agenda consultada (rejeitado antes de tocar GCal).
    expect(cMaria.createEvent).not.toHaveBeenCalled();
    expect(cMaria.listEvents).not.toHaveBeenCalled();
  });

  // (e) Bug 2: serviço que o profissional FAZ → segue normal e cria o evento.
  it('inserir_agendamento ACEITA serviço que o profissional faz (Bruno × Corte)', async () => {
    const cBruno = colabClientStub('cal-bruno');
    const tools = await estabToolsFor(
      'quero cortar com o bruno',
      [{ colaboradorId: 10, nome: 'Bruno', shortId: 'C1', client: cBruno, servicos: ['Corte'] }],
      { services: [{ name: 'Corte', min: 30 }] },
    );
    const inserir = tools.find((t) => t.name === 'inserir_agendamento') as {
      run: (a: unknown) => Promise<{ ok: boolean; colaborador_nome?: string }>;
    };
    const res = await inserir.run({
      colaborador_id: 'C1',
      summary: 'Cliente - Corte',
      servico: 'Corte',
      start: '2026-06-16T13:00:00-03:00',
      end: '2026-06-16T13:30:00-03:00',
    });
    expect(res.ok).toBe(true);
    expect(res.colaborador_nome).toBe('Bruno');
    expect(cBruno.createEvent).toHaveBeenCalledTimes(1);
  });

  // (f) Bug 2: colaborador sem servicos (fallback global) faz qualquer serviço global.
  it('inserir_agendamento ACEITA serviço quando o profissional não tem servicos cadastrados (fallback global)', async () => {
    const cCuringa = colabClientStub('cal-curinga');
    const tools = await estabToolsFor(
      'quero um corte',
      [{ colaboradorId: 10, nome: 'Curinga', shortId: 'C1', client: cCuringa, servicos: [] }],
      { services: [{ name: 'Corte', min: 30 }] },
    );
    const inserir = tools.find((t) => t.name === 'inserir_agendamento') as {
      run: (a: unknown) => Promise<{ ok: boolean }>;
    };
    const res = await inserir.run({
      colaborador_id: 'C1',
      summary: 'Cliente - Corte',
      servico: 'Corte',
      start: '2026-06-16T13:00:00-03:00',
      end: '2026-06-16T13:30:00-03:00',
    });
    expect(res.ok).toBe(true);
    expect(cCuringa.createEvent).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Cartão de confirmação com PROFISSIONAL (estabelecimento) — injetado em RUNTIME
// ════════════════════════════════════════════════════════════════════════════════
//
// Garantias do PM:
//  - estabelecimento → o systemPrompt injeta, EM RUNTIME, a instrução de incluir o nome
//    do profissional escolhido no cartão de confirmação ("👤 PROFISSIONAL"). Como vem do
//    código (não do bot_prompt estático), vale pro clone JÁ existente da Bruna SEM
//    re-renderizar o prompt dela (renderPrompt devolve 'PERSONA' fixa nos testes — a regra
//    NÃO está nela; ainda assim aparece no systemPrompt).
//  - individual → o systemPrompt NÃO contém a instrução de profissional (cartão dos
//    pagantes Cirilo/Samuel fica byte-a-byte: 'PERSONA\n\nCONTEXT').

describe('TesteBarbeariaBot — cartão com profissional (estabelecimento, runtime)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cfg.CANCELAMENTO_ESCALADO_ENABLED = false;
    cfg.ESTABELECIMENTO_ENABLED = false;
    cfg.IDEMPOTENCY_ACTION_LOCK = false;
    cfg.PACOTES_ENABLED = false;
    cfg.ATEND_FROM_AGENDA_SLOTS = '';
    mocks.resolveClientPackages.mockResolvedValue([]);
    mocks.buildSeuPacoteBlock.mockReturnValue('');
  });

  it('estabelecimento: systemPrompt injeta a instrução do PROFISSIONAL no cartão (runtime, sem depender do bot_prompt)', async () => {
    const c1 = colabClientStub('cal-joao');
    // renderPrompt devolve 'PERSONA' fixa (persona da Bruna sem a regra) — prova que a
    // instrução vem do CÓDIGO em runtime, não de um prompt re-renderizado.
    const systemPrompt = await estabSystemPromptFor('quero um corte', [
      { colaboradorId: 10, nome: 'João S.', shortId: 'C1', client: c1 },
    ]);
    expect(systemPrompt).toContain('[CARTAO DE CONFIRMACAO - ESTABELECIMENTO');
    expect(systemPrompt).toContain('👤 PROFISSIONAL');
    // Bug 1: a regra de confirmação SEMPRE (inclusive back-to-back) entra em runtime.
    expect(systemPrompt).toMatch(/CADA agendamento/i);
    expect(systemPrompt).toMatch(/back-to-back|mesma conversa/i);
    // A persona base ('PERSONA') NÃO carregava a regra — ela é adicionada em runtime.
    expect(systemPrompt).toContain('PERSONA');
    expect('PERSONA').not.toContain('PROFISSIONAL');
  });

  it('estabelecimento: a instrução manda usar o NOME do profissional, não o id curto C1/C2', async () => {
    const c1 = colabClientStub('cal-joao');
    const systemPrompt = await estabSystemPromptFor('quero um corte', [
      { colaboradorId: 10, nome: 'João S.', shortId: 'C1', client: c1 },
    ]);
    // Garante que a regra referencia o bloco [PROFISSIONAIS] e o nome (não o id curto).
    expect(systemPrompt).toMatch(/nome do profissional escolhido/i);
    expect(systemPrompt).toMatch(/n[aã]o o id curto/i);
  });

  it('individual: systemPrompt NÃO contém a instrução de profissional (Cirilo/Samuel byte-a-byte)', async () => {
    // Mesmo com a flag de estabelecimento LIGADA, product_type=individual → caminho atual.
    cfg.ESTABELECIMENTO_ENABLED = true;
    setupSchedule(); // getProductType -> 'individual'
    const bot = new TesteBarbeariaBot();
    await (bot as unknown as { process: (c: BotContext) => Promise<string | null> }).process(
      makeCtx('quero marcar um corte'),
    );
    const systemPrompt = mocks.runAgentConfigured.mock.calls[0][0].systemPrompt as string;
    // Cartão individual intocado: persona + contexto, SEM bloco de profissional.
    expect(systemPrompt).toBe('PERSONA\n\nCONTEXT');
    expect(systemPrompt).not.toContain('PROFISSIONAL');
    expect(systemPrompt).not.toContain('[CARTAO DE CONFIRMACAO - ESTABELECIMENTO]');
  });

  // ── Cancelamento por texto livre escala TAMBÉM no estabelecimento (paridade c/ individual) ──
  // Antes a tool escalar_cancelamento só existia no caminho individual → no estabelecimento o
  // cliente que digitava "quero cancelar" fazia o LLM improvisar (podia mentir que cancelou) e
  // o dono NÃO era avisado. Agora o gating é o MESMO nos dois caminhos.
  it('flag OFF: escalar_cancelamento NÃO é exposta no estabelecimento (byte-a-byte)', async () => {
    cfg.CANCELAMENTO_ESCALADO_ENABLED = false;
    const tools = await estabToolsFor('quero cancelar', [
      { colaboradorId: 10, nome: 'João S.', shortId: 'C1', client: colabClientStub('cal-joao') },
    ]);
    expect(tools.map((t) => t.name)).not.toContain('escalar_cancelamento');
  });

  it('flag ON: escalar_cancelamento É exposta no estabelecimento (paridade c/ individual)', async () => {
    cfg.CANCELAMENTO_ESCALADO_ENABLED = true;
    const tools = await estabToolsFor('quero cancelar', [
      { colaboradorId: 10, nome: 'João S.', shortId: 'C1', client: colabClientStub('cal-joao') },
    ]);
    expect(tools.map((t) => t.name)).toContain('escalar_cancelamento');
  });

  it('flag ON: rodar a tool no estabelecimento ESCALA (mock) sem cancelar de fato', async () => {
    cfg.CANCELAMENTO_ESCALADO_ENABLED = true;
    mocks.sendClientCancellationAlert.mockResolvedValue({ ok: true, escalado: true });
    const c1 = colabClientStub('cal-joao');
    const tools = await estabToolsFor('quero cancelar meu horario', [
      { colaboradorId: 10, nome: 'João S.', shortId: 'C1', client: c1 },
    ]);
    const tool = tools.find((t) => t.name === 'escalar_cancelamento') as unknown as {
      run: (a: unknown) => Promise<{ ok: boolean; escalado: boolean }>;
    };
    const res = await tool.run({ motivo: 'imprevisto', referencia_horario: 'amanhã 10h' });
    expect(res).toEqual({ ok: true, escalado: true });
    // Só ESCALA pro dono — NUNCA cria/remove evento na agenda do colaborador.
    expect(mocks.sendClientCancellationAlert).toHaveBeenCalledTimes(1);
    expect(c1.createEvent).not.toHaveBeenCalled();
  });

  it('NENHUMA tool do estabelecimento tem nome de delete/remover de GCal', async () => {
    cfg.CANCELAMENTO_ESCALADO_ENABLED = true;
    const tools = await estabToolsFor('quero cancelar', [
      { colaboradorId: 10, nome: 'João S.', shortId: 'C1', client: colabClientStub('cal-joao') },
    ]);
    for (const t of tools) {
      expect(t.name).not.toMatch(/delet|remov|cancel.*agenda|apagar/i);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Pacotes de serviço (ADR 0025, BLOCO 2a — read-only, gated por PACOTES_ENABLED)
// ════════════════════════════════════════════════════════════════════════════════

/** Roda process() (individual) e devolve { tools, systemPrompt } passados ao runAgent. */
async function runIndividual(texto: string): Promise<{
  tools: Array<{ name: string; run: (a: unknown) => Promise<unknown> }>;
  systemPrompt: string;
}> {
  setupSchedule();
  const bot = new TesteBarbeariaBot();
  await (bot as unknown as { process: (c: BotContext) => Promise<string | null> }).process(
    makeCtx(texto),
  );
  const call = mocks.runAgentConfigured.mock.calls[0][0];
  return { tools: call.tools, systemPrompt: call.systemPrompt };
}

describe('TesteBarbeariaBot — pacotes (BLOCO 2a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cfg.CANCELAMENTO_ESCALADO_ENABLED = false;
    cfg.ESTABELECIMENTO_ENABLED = false;
    cfg.IDEMPOTENCY_ACTION_LOCK = false;
    cfg.PACOTES_ENABLED = false;
    cfg.ATEND_FROM_AGENDA_SLOTS = '';
    mocks.resolveClientPackages.mockResolvedValue([]);
    mocks.buildSeuPacoteBlock.mockReturnValue('');
    mocks.getCloneBySlot.mockResolvedValue({ slot: 'teste_barbearia', tenant_id: 't-uuid' });
    mocks.servicoFromSummary.mockReturnValue('Corte');
    mocks.deduzirPacoteNoAgendamento.mockResolvedValue({
      descontou_do_pacote: false,
      avulso: true,
      motivo: 'sem_pacote',
      sessoes_restantes: null,
    });
  });

  it('flag OFF: tool consultar_pacote NÃO é exposta e nada de pacote é consultado (byte-a-byte)', async () => {
    const { tools, systemPrompt } = await runIndividual('quero marcar um corte');
    expect(tools.map((t) => t.name)).not.toContain('consultar_pacote');
    // Nunca toca a camada de pacotes com a flag OFF — Cirilo/Samuel intactos.
    expect(mocks.resolveClientPackages).not.toHaveBeenCalled();
    expect(mocks.buildSeuPacoteBlock).not.toHaveBeenCalled();
    // systemPrompt = persona + contexto, SEM bloco de pacote.
    expect(systemPrompt).toBe('PERSONA\n\nCONTEXT');
  });

  it('flag ON, cliente SEM pacote: tool exposta, mas systemPrompt sem bloco (block vazio)', async () => {
    cfg.PACOTES_ENABLED = true;
    mocks.resolveClientPackages.mockResolvedValue([]);
    mocks.buildSeuPacoteBlock.mockReturnValue('');
    const { tools, systemPrompt } = await runIndividual('quero marcar um corte');
    expect(tools.map((t) => t.name)).toContain('consultar_pacote');
    expect(mocks.resolveClientPackages).toHaveBeenCalled();
    expect(systemPrompt).toBe('PERSONA\n\nCONTEXT'); // bloco vazio não é concatenado
  });

  it('flag ON, cliente COM pacote: injeta o bloco [SEU PACOTE] no systemPrompt', async () => {
    cfg.PACOTES_ENABLED = true;
    mocks.resolveClientPackages.mockResolvedValue([{ estado: 'ATIVO' }]);
    mocks.buildSeuPacoteBlock.mockReturnValue('[SEU PACOTE]\n- Pacote 5 Cortes: 3 de 5...');
    const { systemPrompt } = await runIndividual('quero marcar um corte');
    expect(systemPrompt).toContain('PERSONA');
    expect(systemPrompt).toContain('CONTEXT');
    expect(systemPrompt).toContain('[SEU PACOTE]');
  });

  it('consultar_pacote é READ-ONLY: nenhum nome de tool sugere escrita/dedução', async () => {
    cfg.PACOTES_ENABLED = true;
    const { tools } = await runIndividual('quanto saldo eu tenho?');
    const consultar = tools.find((t) => t.name === 'consultar_pacote');
    expect(consultar).toBeDefined();
    for (const t of tools) {
      // NENHUMA tool de pacote que descontMatemática/baixa/dedução (isso é o bloco 2b).
      expect(t.name).not.toMatch(/deduz|descontar|baixar_pacote|consumir_pacote|usar_pacote/i);
    }
  });

  it('consultar_pacote.run devolve os pacotes já calculados (sem número cru, sem HMAC)', async () => {
    cfg.PACOTES_ENABLED = true;
    mocks.resolveClientPackages.mockResolvedValue([
      {
        nome: 'Pacote 5 Cortes',
        estado: 'ATIVO',
        sessoes_restantes: 3,
        sessoes_total: 5,
        data_expiracao: '2026-12-31',
        servicos_cobertos: ['Corte'],
        colaborador_id: null,
      },
    ]);
    const { tools } = await runIndividual('quanto saldo?');
    const consultar = tools.find((t) => t.name === 'consultar_pacote') as {
      run: (a: unknown) => Promise<{ pacotes: Array<Record<string, unknown>> }>;
    };
    const res = await consultar.run({});
    expect(res.pacotes).toEqual([
      {
        nome: 'Pacote 5 Cortes',
        estado: 'ATIVO',
        sessoes_restantes: 3,
        sessoes_total: 5,
        valido_ate: '2026-12-31',
        cobre: ['Corte'],
        escopo: 'casa',
      },
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Pacotes no ESTABELECIMENTO (SCRUM-68 — fecha "pacote cego ao saldo")
// O estab JÁ deduz pacote (BLOCO 2b, intocado). Aqui plugamos a CONSULTA read-only:
// a tool consultar_pacote + o bloco [SEU PACOTE], MESMA lógica/identidade do individual.
// ════════════════════════════════════════════════════════════════════════════════

describe('TesteBarbeariaBot — pacotes no estabelecimento (BLOCO 2a, SCRUM-68)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cfg.CANCELAMENTO_ESCALADO_ENABLED = false;
    cfg.ESTABELECIMENTO_ENABLED = false;
    cfg.IDEMPOTENCY_ACTION_LOCK = false;
    cfg.PACOTES_ENABLED = false;
    cfg.ATEND_FROM_AGENDA_SLOTS = '';
    cfg.MODO_ATENDENTE_SLOTS = '';
    mocks.resolveClientPackages.mockResolvedValue([]);
    mocks.buildSeuPacoteBlock.mockReturnValue('');
  });

  const oneColab = () => [
    { colaboradorId: 10, nome: 'João S.', shortId: 'C1', client: colabClientStub('cal-joao') },
  ];

  it('flag OFF: consultar_pacote NÃO é exposta e a camada de pacote não é tocada (byte-a-byte)', async () => {
    cfg.PACOTES_ENABLED = false;
    const tools = await estabToolsFor('meu pacote?', oneColab());
    expect(tools.map((t) => t.name)).not.toContain('consultar_pacote');
    // Estab sem a flag NÃO consulta pacote em ponto algum (nem bloco, nem tool).
    expect(mocks.resolveClientPackages).not.toHaveBeenCalled();
    expect(mocks.buildSeuPacoteBlock).not.toHaveBeenCalled();
  });

  it('flag ON, cliente SEM pacote: systemPrompt do estab IDÊNTICO ao da flag OFF (bloco vazio não adiciona nada)', async () => {
    const colab = oneColab();

    // Baseline: flag OFF.
    cfg.PACOTES_ENABLED = false;
    const promptOff = await estabSystemPromptFor('quero um corte', colab);
    expect(promptOff).not.toContain('[SEU PACOTE]');

    // Flag ON mas cliente sem pacote (buildSeuPacoteBlock -> '') => byte-a-byte o de OFF.
    vi.clearAllMocks();
    cfg.PACOTES_ENABLED = true;
    mocks.resolveClientPackages.mockResolvedValue([]);
    mocks.buildSeuPacoteBlock.mockReturnValue('');
    const promptOnSemPacote = await estabSystemPromptFor('quero um corte', colab);

    expect(promptOnSemPacote).toBe(promptOff); // append condicional não injeta linha vazia
    expect(promptOnSemPacote).not.toContain('[SEU PACOTE]');
  });

  it('flag ON, cliente COM pacote: injeta [SEU PACOTE] SEM perder os blocos do estabelecimento', async () => {
    cfg.PACOTES_ENABLED = true;
    mocks.resolveClientPackages.mockResolvedValue([{ estado: 'ATIVO' }]);
    mocks.buildSeuPacoteBlock.mockReturnValue(
      '[SEU PACOTE]\n- Pacote 5 Cortes: 2 de 5 (vence 31/12)',
    );
    const systemPrompt = await estabSystemPromptFor('meu pacote?', oneColab());
    expect(systemPrompt).toContain('[SEU PACOTE]');
    expect(systemPrompt).toContain('Pacote 5 Cortes');
    // Não regride os blocos do estab (agenda por profissional + cartão).
    expect(systemPrompt).toContain('[PROFISSIONAIS]');
    expect(systemPrompt).toContain('[CARTAO DE CONFIRMACAO - ESTABELECIMENTO');
  });

  it('flag ON: consultar_pacote exposta, READ-ONLY (nenhum nome de tool sugere dedução/baixa)', async () => {
    cfg.PACOTES_ENABLED = true;
    const tools = await estabToolsFor('quanto saldo eu tenho?', oneColab());
    expect(tools.map((t) => t.name)).toContain('consultar_pacote');
    for (const t of tools) {
      expect(t.name).not.toMatch(/deduz|descontar|baixar_pacote|consumir_pacote|usar_pacote/i);
    }
  });

  it('consultar_pacote (estab) IGNORA telefone do LLM e consulta o saldo do número da CONVERSA (anti-IDOR)', async () => {
    cfg.PACOTES_ENABLED = true;
    mocks.resolveClientPackages.mockResolvedValue([
      {
        nome: 'Pacote 5 Cortes',
        estado: 'ATIVO',
        sessoes_restantes: 2,
        sessoes_total: 5,
        data_expiracao: '2026-12-31',
        servicos_cobertos: ['Corte'],
        colaborador_id: null,
      },
    ]);
    const tools = await estabToolsFor('quantas sessões me restam?', oneColab());
    const consultar = tools.find((t) => t.name === 'consultar_pacote') as {
      run: (a: unknown) => Promise<{ pacotes: Array<Record<string, unknown>> }>;
    };
    expect(consultar).toBeDefined();
    // Telefone FORJADO pelo LLM tem que ser IGNORADO — usa sempre o da conversa (makeCtx).
    const res = await consultar.run({ telefone: '5511000000000' });
    expect(mocks.resolveClientPackages).toHaveBeenCalledWith({
      slot: 'clone_estab_x',
      telefone: '5511988887777',
      apenasAtivos: false,
    });
    expect(res.pacotes[0]).toMatchObject({
      nome: 'Pacote 5 Cortes',
      sessoes_restantes: 2,
      escopo: 'casa',
    });
  });

  it('dedução intocada: com pacote+consulta ligados, inserir_agendamento segue chamando a dedução (BLOCO 2b)', async () => {
    cfg.PACOTES_ENABLED = true;
    mocks.getCloneBySlot.mockResolvedValue({ slot: 'clone_estab_x', tenant_id: 't-uuid' });
    mocks.servicoFromSummary.mockReturnValue('Corte');
    mocks.deduzirPacoteNoAgendamento.mockResolvedValue({
      descontou_do_pacote: true,
      avulso: false,
      motivo: 'ok',
      sessoes_restantes: 1,
      colaborador_id: null,
    });
    const c1 = colabClientStub('cal-joao');
    // Colaborador faz 'Corte' + serviço existe nos globais -> passa o gate serviço×profissional
    // (senão inserir_agendamento retorna SERVICO_NAO_OFERECIDO antes de criar/deduzir).
    const tools = await estabToolsFor(
      'quero um corte com C1',
      [{ colaboradorId: 10, nome: 'João S.', shortId: 'C1', client: c1, servicos: ['Corte'] }],
      { services: [{ name: 'Corte', min: 30 }] },
    );
    const inserir = tools.find((t) => t.name === 'inserir_agendamento') as {
      run: (a: unknown) => Promise<{ ok: boolean; pacote?: { sessoes_restantes: number } }>;
    };
    const res = await inserir.run({
      colaborador_id: 'C1',
      summary: 'Fulano - Corte | WhatsApp: 5511988887777',
      start: '2026-07-10T10:00:00-03:00',
      end: '2026-07-10T10:30:00-03:00',
      servico: 'Corte',
      usa_pacote: true,
    });
    // A CONSULTA (2a) não removeu/alterou a DEDUÇÃO (2b): ela roda e desconta.
    expect(mocks.deduzirPacoteNoAgendamento).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    expect(res.pacote?.sessoes_restantes).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Dedução de pacote no agendamento (ADR 0025, BLOCO 2b — gated por PACOTES_ENABLED)
// ════════════════════════════════════════════════════════════════════════════════

/** setupSchedule, mas com um calClient que também cria evento (pra exercitar inserir). */
function setupScheduleComCreate(eventId = 'evt-novo') {
  const calClient = {
    listEvents: vi.fn().mockResolvedValue([]),
    createEvent: vi.fn().mockResolvedValue({ id: eventId, summary: 'Fulano - Corte' }),
  };
  mocks.getGcalForSlot.mockResolvedValue(calClient);
  mocks.loadScheduleConfig.mockResolvedValue({
    source: 'flow_clones',
    services: [],
    timezone: 'America/Sao_Paulo',
  });
  mocks.formatarAgendaComConfig.mockReturnValue('AGENDA');
  mocks.renderPrompt.mockResolvedValue('PERSONA');
  mocks.buildContextBlock.mockResolvedValue('CONTEXT');
  mocks.runAgentConfigured.mockResolvedValue({ reply: 'ok' });
  mocks.loadHistory.mockResolvedValue([{ role: 'user', content: 'oi' }]);
  mocks.getProductType.mockResolvedValue('individual');
  return calClient;
}

async function inserirToolFor(): Promise<{
  run: (a: unknown) => Promise<Record<string, unknown>>;
}> {
  const bot = new TesteBarbeariaBot();
  await (bot as unknown as { process: (c: BotContext) => Promise<string | null> }).process(
    makeCtx('quero marcar um corte'),
  );
  const tools = mocks.runAgentConfigured.mock.calls[0][0].tools as Array<{
    name: string;
    run: (a: unknown) => Promise<Record<string, unknown>>;
  }>;
  return tools.find((t) => t.name === 'inserir_agendamento') as {
    run: (a: unknown) => Promise<Record<string, unknown>>;
  };
}

describe('TesteBarbeariaBot — dedução de pacote no agendamento (BLOCO 2b)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cfg.CANCELAMENTO_ESCALADO_ENABLED = false;
    cfg.ESTABELECIMENTO_ENABLED = false;
    cfg.IDEMPOTENCY_ACTION_LOCK = false;
    cfg.PACOTES_ENABLED = false;
    cfg.ATEND_FROM_AGENDA_SLOTS = '';
    mocks.resolveClientPackages.mockResolvedValue([]);
    mocks.buildSeuPacoteBlock.mockReturnValue('');
    mocks.getCloneBySlot.mockResolvedValue({ slot: 'teste_barbearia', tenant_id: 't-uuid' });
    mocks.servicoFromSummary.mockReturnValue('Corte');
  });

  it('flag OFF: inserir_agendamento NÃO consulta nem deduz pacote (byte-a-byte) — Cirilo/Samuel intactos', async () => {
    const calClient = setupScheduleComCreate('evt-1');
    const inserir = await inserirToolFor();
    const res = await inserir.run({
      summary: 'Fulano - Corte | WhatsApp: 5511988887777',
      start: '2026-06-16T13:00:00-03:00',
      end: '2026-06-16T13:30:00-03:00',
    });
    expect(res).toEqual({ ok: true, eventId: 'evt-1', summary: 'Fulano - Corte' });
    expect(res).not.toHaveProperty('pacote'); // sem campo de pacote
    expect(mocks.deduzirPacoteNoAgendamento).not.toHaveBeenCalled();
    expect(mocks.getCloneBySlot).not.toHaveBeenCalled();
    expect(calClient.createEvent).toHaveBeenCalledTimes(1);
  });

  it('flag ON, serviço coberto: deduz e enriquece a resposta (descontou + saldo)', async () => {
    cfg.PACOTES_ENABLED = true;
    setupScheduleComCreate('evt-9');
    mocks.deduzirPacoteNoAgendamento.mockResolvedValue({
      descontou_do_pacote: true,
      avulso: false,
      sessoes_restantes: 2,
      motivo: 'descontado',
      pacote_nome: 'Pacote 5 Cortes',
      pacote_colaborador_id: null,
    });
    const inserir = await inserirToolFor();
    const res = await inserir.run({
      summary: 'Fulano - Corte | WhatsApp: 5511988887777',
      start: '2026-06-16T13:00:00-03:00',
      end: '2026-06-16T13:30:00-03:00',
      servico: 'Corte',
      usa_pacote: true,
    });
    expect(res.ok).toBe(true);
    expect(res.eventId).toBe('evt-9');
    expect(res.pacote).toMatchObject({
      descontou_do_pacote: true,
      avulso: false,
      sessoes_restantes: 2,
    });
    // O servidor recebeu o eventId (âncora idempotente) + serviço explícito + sugestão usa_pacote.
    expect(mocks.deduzirPacoteNoAgendamento).toHaveBeenCalledWith(
      expect.objectContaining({
        slot: 'teste_barbearia',
        tenantId: 't-uuid',
        gcalEventId: 'evt-9',
        servicoNome: 'Corte',
        usaPacote: true,
      }),
    );
  });

  it('flag ON, "por fora" (não coberto): agenda avulso, resposta marca avulso', async () => {
    cfg.PACOTES_ENABLED = true;
    setupScheduleComCreate('evt-10');
    mocks.deduzirPacoteNoAgendamento.mockResolvedValue({
      descontou_do_pacote: false,
      avulso: true,
      sessoes_restantes: null,
      motivo: 'sem_pacote',
    });
    const inserir = await inserirToolFor();
    const res = await inserir.run({
      summary: 'Fulano - Hidratação | WhatsApp: 5511988887777',
      start: '2026-06-16T13:00:00-03:00',
      end: '2026-06-16T13:30:00-03:00',
    });
    expect(res.ok).toBe(true);
    expect(res.pacote).toMatchObject({ descontou_do_pacote: false, avulso: true });
  });

  it('flag ON: usa_pacote=false é repassado como SUGESTÃO ao servidor (não força nada)', async () => {
    cfg.PACOTES_ENABLED = true;
    setupScheduleComCreate('evt-11');
    const inserir = await inserirToolFor();
    await inserir.run({
      summary: 'Fulano - Corte | WhatsApp: 5511988887777',
      start: '2026-06-16T13:00:00-03:00',
      end: '2026-06-16T13:30:00-03:00',
      usa_pacote: false,
    });
    expect(mocks.deduzirPacoteNoAgendamento).toHaveBeenCalledWith(
      expect.objectContaining({ usaPacote: false }),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Billing DERIVADO DA AGENDA — gancho do BOT (ADR 0027, Fase D — gated POR-CLONE via ATEND_FROM_AGENDA_SLOTS)
// ════════════════════════════════════════════════════════════════════════════════
//
// Garantias NÃO-NEGOCIÁVEIS do Bruno:
//  1) flag OFF (default) -> NENHUMA linha em `atendimentos`; o bot é BYTE-A-BYTE o de hoje
//     (mesma resposta, evento criado, pacote deduzido). Cirilo/Samuel intactos.
//  2) flag ON -> após criar o evento, grava a linha de PREVISÃO (tenant_id do clone,
//     colaborador certo no estabelecimento / null no individual, origem='agenda').
//  3) o gancho NUNCA quebra o fluxo: helper lançando exceção -> o agendamento completa
//     normal (evento criado + pacote deduzido + resposta intacta). Best-effort.
//  4) isolamento P0: tenant_id NUNCA vem de input; sem tenant resolvido -> NÃO grava (e o
//     bot ainda responde).

/** Roda inserir_agendamento do ESTABELECIMENTO e devolve o resultado da tool. */
async function estabInserirRun(
  colaboradores: EstabColab[],
  args: Record<string, unknown>,
  opts?: { services?: Array<{ name: string; min: number }> },
): Promise<Record<string, unknown>> {
  const tools = await estabToolsFor('quero cortar', colaboradores, opts);
  const inserir = tools.find((t) => t.name === 'inserir_agendamento') as {
    run: (a: unknown) => Promise<Record<string, unknown>>;
  };
  return inserir.run(args);
}

describe('TesteBarbeariaBot — atendimento derivado da agenda (Fase D, gancho do bot)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cfg.CANCELAMENTO_ESCALADO_ENABLED = false;
    cfg.ESTABELECIMENTO_ENABLED = false;
    cfg.IDEMPOTENCY_ACTION_LOCK = false;
    cfg.PACOTES_ENABLED = false;
    cfg.ATEND_FROM_AGENDA_SLOTS = '';
    mocks.resolveClientPackages.mockResolvedValue([]);
    mocks.buildSeuPacoteBlock.mockReturnValue('');
    mocks.getCloneBySlot.mockResolvedValue({ slot: 'teste_barbearia', tenant_id: 't-uuid' });
    // servico/cliente do summary usam a lógica real (snapshot meaningful no atendimento).
    mocks.servicoFromSummary.mockImplementation((s: string) => {
      const sem = s.split('|')[0] ?? s;
      const i = sem.indexOf(' - ');
      return i < 0 ? '' : sem.slice(i + 3).trim();
    });
    mocks.clienteFromSummary.mockImplementation((s: string) => {
      const sem = s.split('|')[0] ?? s;
      const i = sem.indexOf(' - ');
      return i < 0 ? '' : sem.slice(0, i).trim();
    });
    // Default: scope resolve tenant_id (clone do estab tem tenant próprio).
    mocks.getScopeBySlot.mockResolvedValue({
      product_type: 'individual',
      seat_cap: null,
      tenant_id: 't-uuid',
    });
    mocks.upsertAtendimentoFromEvent.mockResolvedValue({ id: 777 });
  });

  // ── INDIVIDUAL ────────────────────────────────────────────────────────────────

  it('flag OFF (individual): NÃO grava atendimento e a resposta é byte-a-byte a de hoje', async () => {
    const calClient = setupScheduleComCreate('evt-off');
    const inserir = await inserirToolFor();
    const res = await inserir.run({
      summary: 'Fulano - Corte | WhatsApp: 5511988887777',
      start: '2026-06-16T13:00:00-03:00',
      end: '2026-06-16T13:30:00-03:00',
    });
    expect(res).toEqual({ ok: true, eventId: 'evt-off', summary: 'Fulano - Corte' });
    expect(mocks.upsertAtendimentoFromEvent).not.toHaveBeenCalled();
    expect(mocks.getScopeBySlot).not.toHaveBeenCalled();
    expect(calClient.createEvent).toHaveBeenCalledTimes(1);
  });

  it('gate POR-CLONE: slot FORA da lista (Cirilo/Samuel) = OFF byte-a-byte mesmo com SLOTS setado', async () => {
    // SLOTS liga SÓ o dragon; o bot deste teste é teste_barbearia -> deve ficar OFF.
    cfg.ATEND_FROM_AGENDA_SLOTS = 'clone_barber_dragon_caly8b';
    const calClient = setupScheduleComCreate('evt-other');
    const inserir = await inserirToolFor();
    const res = await inserir.run({
      summary: 'Fulano - Corte | WhatsApp: 5511988887777',
      start: '2026-06-16T13:00:00-03:00',
      end: '2026-06-16T13:30:00-03:00',
    });
    expect(res).toEqual({ ok: true, eventId: 'evt-other', summary: 'Fulano - Corte' });
    expect(mocks.upsertAtendimentoFromEvent).not.toHaveBeenCalled();
    expect(mocks.getScopeBySlot).not.toHaveBeenCalled();
    expect(calClient.createEvent).toHaveBeenCalledTimes(1);
  });

  it('flag ON (individual): cria linha de previsão com tenant_id e colaborador null', async () => {
    cfg.ATEND_FROM_AGENDA_SLOTS = 'teste_barbearia';
    const calClient = setupScheduleComCreate('evt-ind');
    const inserir = await inserirToolFor();
    const res = await inserir.run({
      summary: 'Fulano - Corte | WhatsApp: 5511988887777',
      start: '2026-06-16T13:00:00-03:00',
      end: '2026-06-16T13:30:00-03:00',
    });
    // resposta ao cliente inalterada
    expect(res).toMatchObject({ ok: true, eventId: 'evt-ind' });
    expect(calClient.createEvent).toHaveBeenCalledTimes(1);
    expect(mocks.upsertAtendimentoFromEvent).toHaveBeenCalledTimes(1);
    expect(mocks.upsertAtendimentoFromEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        slot: 'teste_barbearia',
        tenantId: 't-uuid',
        gcalEventId: 'evt-ind',
        servicoNome: 'Corte',
        clienteNome: 'Fulano',
        colaboradorId: null,
        // Reancorado no fuso do clone (SP): 13:00−03:00 == 16:00Z — MESMO instante, forma ISO
        // normalizada (prova de igualdade do clone SP; migration 068).
        inicioAt: '2026-06-16T16:00:00.000Z',
        fimAt: '2026-06-16T16:30:00.000Z',
      }),
    );
    // BUG 2: sem dedução de pacote -> forma null (previsão conta a receita 1×).
    expect(mocks.upsertAtendimentoFromEvent).toHaveBeenCalledWith(
      expect.objectContaining({ formaPagamento: null }),
    );
  });

  // ── BUG 2 (pacote DOBRA): a dedução do pacote tem que chegar ao upsert como forma='pacote'
  it('BUG2 (individual): pacote DEDUZIDO -> upsert recebe formaPagamento="pacote" (não dobra a receita)', async () => {
    cfg.ATEND_FROM_AGENDA_SLOTS = 'teste_barbearia';
    cfg.PACOTES_ENABLED = true;
    mocks.deduzirPacoteNoAgendamento.mockResolvedValue({
      descontou_do_pacote: true, // <- pacote debitado: a receita já entrou na venda do pacote
      avulso: false,
      sessoes_restantes: 2,
      motivo: 'descontado',
      pacote_nome: 'Pacote 5 Cortes',
      pacote_colaborador_id: null,
    });
    const calClient = setupScheduleComCreate('evt-pac');
    const inserir = await inserirToolFor();
    const res = await inserir.run({
      summary: 'Fulano - Corte | WhatsApp: 5511988887777',
      start: '2026-06-16T13:00:00-03:00',
      end: '2026-06-16T13:30:00-03:00',
      servico: 'Corte',
      usa_pacote: true,
    });
    expect(res).toMatchObject({ ok: true, eventId: 'evt-pac' });
    expect(calClient.createEvent).toHaveBeenCalledTimes(1);
    expect(mocks.upsertAtendimentoFromEvent).toHaveBeenCalledTimes(1);
    // O resultado da dedução chega ao gancho: forma='pacote' -> o helper zera valor (testado na db layer).
    expect(mocks.upsertAtendimentoFromEvent).toHaveBeenCalledWith(
      expect.objectContaining({ gcalEventId: 'evt-pac', formaPagamento: 'pacote' }),
    );
  });

  it('BUG2 (individual): pacote NÃO deduzido (avulso) -> forma NÃO é "pacote" (conta a receita)', async () => {
    cfg.ATEND_FROM_AGENDA_SLOTS = 'teste_barbearia';
    cfg.PACOTES_ENABLED = true;
    mocks.deduzirPacoteNoAgendamento.mockResolvedValue({
      descontou_do_pacote: false, // <- não tinha pacote: é avulso, conta a receita normal
      avulso: true,
      sessoes_restantes: null,
      motivo: 'sem_pacote',
    });
    const calClient = setupScheduleComCreate('evt-avu');
    const inserir = await inserirToolFor();
    await inserir.run({
      summary: 'Fulano - Corte | WhatsApp: 5511988887777',
      start: '2026-06-16T13:00:00-03:00',
      end: '2026-06-16T13:30:00-03:00',
      servico: 'Corte',
    });
    expect(calClient.createEvent).toHaveBeenCalledTimes(1);
    expect(mocks.upsertAtendimentoFromEvent).toHaveBeenCalledWith(
      expect.objectContaining({ gcalEventId: 'evt-avu', formaPagamento: null }),
    );
  });

  it('flag ON (individual): tenant_id NÃO resolvido -> NÃO grava, mas o bot responde normal', async () => {
    cfg.ATEND_FROM_AGENDA_SLOTS = 'teste_barbearia';
    mocks.getScopeBySlot.mockResolvedValue({
      product_type: 'individual',
      seat_cap: null,
      tenant_id: null, // dado inconsistente -> isolamento P0: não cria linha
    });
    const calClient = setupScheduleComCreate('evt-notenant');
    const inserir = await inserirToolFor();
    const res = await inserir.run({
      summary: 'Fulano - Corte | WhatsApp: 5511988887777',
      start: '2026-06-16T13:00:00-03:00',
      end: '2026-06-16T13:30:00-03:00',
    });
    expect(res).toMatchObject({ ok: true, eventId: 'evt-notenant' });
    expect(calClient.createEvent).toHaveBeenCalledTimes(1);
    expect(mocks.upsertAtendimentoFromEvent).not.toHaveBeenCalled();
  });

  it('flag ON (individual): helper LANÇANDO exceção NÃO quebra o agendamento (evento criado + pacote deduzido + resposta intacta)', async () => {
    cfg.ATEND_FROM_AGENDA_SLOTS = 'teste_barbearia';
    cfg.PACOTES_ENABLED = true;
    mocks.deduzirPacoteNoAgendamento.mockResolvedValue({
      descontou_do_pacote: true,
      avulso: false,
      sessoes_restantes: 1,
      motivo: 'descontado',
      pacote_nome: 'Pacote 5 Cortes',
      pacote_colaborador_id: null,
    });
    mocks.upsertAtendimentoFromEvent.mockRejectedValue(new Error('DB down'));
    const calClient = setupScheduleComCreate('evt-boom');
    const inserir = await inserirToolFor();
    const res = await inserir.run({
      summary: 'Fulano - Corte | WhatsApp: 5511988887777',
      start: '2026-06-16T13:00:00-03:00',
      end: '2026-06-16T13:30:00-03:00',
      servico: 'Corte',
      usa_pacote: true,
    });
    // O bot completa NORMAL: evento criado, pacote deduzido, resposta enriquecida — a falha
    // do atendimento (best-effort) foi engolida.
    expect(res.ok).toBe(true);
    expect(res.eventId).toBe('evt-boom');
    expect(res.pacote).toMatchObject({ descontou_do_pacote: true });
    expect(calClient.createEvent).toHaveBeenCalledTimes(1);
    expect(mocks.deduzirPacoteNoAgendamento).toHaveBeenCalledTimes(1);
    expect(mocks.upsertAtendimentoFromEvent).toHaveBeenCalledTimes(1); // tentou e falhou
  });

  // ── ESTABELECIMENTO ─────────────────────────────────────────────────────────────

  it('flag OFF (estabelecimento): NÃO grava atendimento; resposta byte-a-byte', async () => {
    const cBruno = colabClientStub('cal-bruno');
    const res = await estabInserirRun(
      [{ colaboradorId: 10, nome: 'Bruno', shortId: 'C1', client: cBruno, servicos: ['Corte'] }],
      {
        colaborador_id: 'C1',
        summary: 'Fulano - Corte | WhatsApp: 5511988887777',
        servico: 'Corte',
        start: '2026-06-16T13:00:00-03:00',
        end: '2026-06-16T13:30:00-03:00',
      },
      { services: [{ name: 'Corte', min: 30 }] },
    );
    expect(res.ok).toBe(true);
    expect(res.colaborador_nome).toBe('Bruno');
    expect((cBruno as { createEvent: ReturnType<typeof vi.fn> }).createEvent).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.upsertAtendimentoFromEvent).not.toHaveBeenCalled();
  });

  it('flag ON (estabelecimento): cria linha com o colaborador que recebeu o evento', async () => {
    cfg.ATEND_FROM_AGENDA_SLOTS = 'clone_estab_x';
    // o clone do estab resolve tenant próprio
    mocks.getScopeBySlot.mockResolvedValue({
      product_type: 'estabelecimento',
      seat_cap: 5,
      tenant_id: 't-estab',
    });
    const cBruno = colabClientStub('cal-bruno');
    const res = await estabInserirRun(
      [{ colaboradorId: 10, nome: 'Bruno', shortId: 'C1', client: cBruno, servicos: ['Corte'] }],
      {
        colaborador_id: 'C1',
        summary: 'Fulano - Corte | WhatsApp: 5511988887777',
        servico: 'Corte',
        start: '2026-06-16T13:00:00-03:00',
        end: '2026-06-16T13:30:00-03:00',
      },
      { services: [{ name: 'Corte', min: 30 }] },
    );
    expect(res.ok).toBe(true);
    expect(mocks.upsertAtendimentoFromEvent).toHaveBeenCalledTimes(1);
    expect(mocks.upsertAtendimentoFromEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        slot: 'clone_estab_x',
        tenantId: 't-estab',
        gcalEventId: 'evt-cal-bruno',
        servicoNome: 'Corte',
        colaboradorId: 10, // o colaborador que recebeu o evento (não null)
      }),
    );
  });

  it('flag ON (estabelecimento): helper LANÇANDO NÃO quebra o agendamento', async () => {
    cfg.ATEND_FROM_AGENDA_SLOTS = 'clone_estab_x';
    mocks.getScopeBySlot.mockResolvedValue({
      product_type: 'estabelecimento',
      seat_cap: 5,
      tenant_id: 't-estab',
    });
    mocks.upsertAtendimentoFromEvent.mockRejectedValue(new Error('boom'));
    const cBruno = colabClientStub('cal-bruno');
    const res = await estabInserirRun(
      [{ colaboradorId: 10, nome: 'Bruno', shortId: 'C1', client: cBruno, servicos: ['Corte'] }],
      {
        colaborador_id: 'C1',
        summary: 'Fulano - Corte | WhatsApp: 5511988887777',
        servico: 'Corte',
        start: '2026-06-16T13:00:00-03:00',
        end: '2026-06-16T13:30:00-03:00',
      },
      { services: [{ name: 'Corte', min: 30 }] },
    );
    expect(res.ok).toBe(true);
    expect(res.colaborador_nome).toBe('Bruno');
    expect((cBruno as { createEvent: ReturnType<typeof vi.fn> }).createEvent).toHaveBeenCalledTimes(
      1,
    );
  });

  it('BUG2 (estabelecimento): pacote DEDUZIDO -> upsert recebe formaPagamento="pacote"', async () => {
    cfg.ATEND_FROM_AGENDA_SLOTS = 'clone_estab_x';
    cfg.PACOTES_ENABLED = true;
    mocks.getScopeBySlot.mockResolvedValue({
      product_type: 'estabelecimento',
      seat_cap: 5,
      tenant_id: 't-estab',
    });
    mocks.deduzirPacoteNoAgendamento.mockResolvedValue({
      descontou_do_pacote: true,
      avulso: false,
      sessoes_restantes: 1,
      motivo: 'descontado',
      pacote_nome: 'Pacote 5 Cortes',
      pacote_colaborador_id: 10,
    });
    const cBruno = colabClientStub('cal-bruno');
    const res = await estabInserirRun(
      [{ colaboradorId: 10, nome: 'Bruno', shortId: 'C1', client: cBruno, servicos: ['Corte'] }],
      {
        colaborador_id: 'C1',
        summary: 'Fulano - Corte | WhatsApp: 5511988887777',
        servico: 'Corte',
        usa_pacote: true,
        start: '2026-06-16T13:00:00-03:00',
        end: '2026-06-16T13:30:00-03:00',
      },
      { services: [{ name: 'Corte', min: 30 }] },
    );
    expect(res.ok).toBe(true);
    expect(mocks.upsertAtendimentoFromEvent).toHaveBeenCalledTimes(1);
    expect(mocks.upsertAtendimentoFromEvent).toHaveBeenCalledWith(
      expect.objectContaining({ colaboradorId: 10, formaPagamento: 'pacote' }),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Billing-da-agenda sob ACTION-LOCK + fuso por clone (regressão do fix #407/#408)
// ════════════════════════════════════════════════════════════════════════════════
//
// BUG (verificação adversarial 30/06): com IDEMPOTENCY_ACTION_LOCK=true (caminho VIVO em
// prod), o ramo action-lock do inserir_agendamento passava o start/end CRU (hora-de-parede
// do LLM com offset −03 chumbado) pro gancho de atendimento, em vez do startISO/endISO
// REANCORADO no fuso do clone (que o createEvent e o ramo sem-lock já usavam). Resultado:
// o EVENTO no GCal caía na hora certa, mas o /billing gravava 1h ADIANTADO em clones
// não-SP (Seven 7 / America/Cuiaba −04). Clone SP (−03) = byte-idêntico (no-op).
//
// Garantias verificadas aqui (com a flag LIGADA, como em prod):
//  - não-SP (Cuiabá): upsert recebe o INSTANTE REANCORADO (22:00 local = 02:00Z), não o cru;
//  - SP: regressão — reancorar é no-op, mesmo instante do ramo sem-lock (nada muda p/ pagantes);
//  - vale pro individual E pro estabelecimento (os 2 ramos action-lock foram corrigidos).

describe('TesteBarbeariaBot — atendimento sob action-lock + fuso por clone (fix #407/#408)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cfg.CANCELAMENTO_ESCALADO_ENABLED = false;
    cfg.ESTABELECIMENTO_ENABLED = false;
    cfg.IDEMPOTENCY_ACTION_LOCK = false;
    cfg.PACOTES_ENABLED = false;
    cfg.ATEND_FROM_AGENDA_SLOTS = '';
    mocks.resolveClientPackages.mockResolvedValue([]);
    mocks.buildSeuPacoteBlock.mockReturnValue('');
    mocks.getCloneBySlot.mockResolvedValue({ slot: 'teste_barbearia', tenant_id: 't-uuid' });
    mocks.servicoFromSummary.mockImplementation((s: string) => {
      const sem = s.split('|')[0] ?? s;
      const i = sem.indexOf(' - ');
      return i < 0 ? '' : sem.slice(i + 3).trim();
    });
    mocks.clienteFromSummary.mockImplementation((s: string) => {
      const sem = s.split('|')[0] ?? s;
      const i = sem.indexOf(' - ');
      return i < 0 ? '' : sem.slice(0, i).trim();
    });
    mocks.getScopeBySlot.mockResolvedValue({
      product_type: 'individual',
      seat_cap: null,
      tenant_id: 't-uuid',
    });
    mocks.upsertAtendimentoFromEvent.mockResolvedValue({ id: 777 });
    // action-lock VIVO (flag ON em prod): adquire o lock, EXECUTA o createEvent e devolve o
    // evento — espelha o caminho real de quem ganha o lock (executed=true).
    mocks.withActionLock.mockImplementation(async (_key: string, fn: () => Promise<unknown>) => ({
      executed: true,
      value: await fn(),
      degraded: false,
    }));
  });

  it('action-lock ON (individual, Cuiabá −04): grava inicio_at REANCORADO (22:00 local = 02:00Z), não o cru (01:00Z)', async () => {
    cfg.IDEMPOTENCY_ACTION_LOCK = true;
    cfg.ATEND_FROM_AGENDA_SLOTS = 'teste_barbearia';
    const calClient = setupScheduleComCreate('evt-cba');
    // fuso do clone = America/Cuiaba (−04). O reanchorWallTimeToTz REAL reinterpreta a
    // hora-de-parede 22:00 nesse fuso → 02:00Z (em vez do 01:00Z que o offset −03 do LLM dá).
    mocks.loadScheduleConfig.mockResolvedValue({
      source: 'flow_clones',
      services: [],
      timezone: 'America/Cuiaba',
    });
    const inserir = await inserirToolFor();
    const res = await inserir.run({
      summary: 'Fulano - Corte | WhatsApp: 5511988887777',
      start: '2026-06-30T22:00:00-03:00',
      end: '2026-06-30T23:00:00-03:00',
    });
    expect(res).toMatchObject({ ok: true, eventId: 'evt-cba' });
    // o evento foi criado SOB o action-lock (caminho VIVO em prod)
    expect(mocks.withActionLock).toHaveBeenCalledTimes(1);
    expect(calClient.createEvent).toHaveBeenCalledTimes(1);
    expect(mocks.upsertAtendimentoFromEvent).toHaveBeenCalledTimes(1);
    // PROVA DO FIX: instante REANCORADO no fuso do clone. O cru (offset −03 do LLM) seria
    // '2026-07-01T01:00:00.000Z' = 1h adiantado (o bug). Reancorado em −04 = 02:00Z.
    expect(mocks.upsertAtendimentoFromEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        gcalEventId: 'evt-cba',
        inicioAt: '2026-07-01T02:00:00.000Z',
        fimAt: '2026-07-01T03:00:00.000Z',
      }),
    );
  });

  it('action-lock ON (individual, São Paulo −03): regressão — inicio_at inalterado (reancorar é no-op, 16:00Z)', async () => {
    cfg.IDEMPOTENCY_ACTION_LOCK = true;
    cfg.ATEND_FROM_AGENDA_SLOTS = 'teste_barbearia';
    // timezone default = America/Sao_Paulo (do setupScheduleComCreate)
    const calClient = setupScheduleComCreate('evt-sp');
    const inserir = await inserirToolFor();
    const res = await inserir.run({
      summary: 'Fulano - Corte | WhatsApp: 5511988887777',
      start: '2026-06-16T13:00:00-03:00',
      end: '2026-06-16T13:30:00-03:00',
    });
    expect(res).toMatchObject({ ok: true, eventId: 'evt-sp' });
    expect(mocks.withActionLock).toHaveBeenCalledTimes(1);
    expect(calClient.createEvent).toHaveBeenCalledTimes(1);
    expect(mocks.upsertAtendimentoFromEvent).toHaveBeenCalledTimes(1);
    // SP: −03 == −03 → reancorar é no-op. MESMO instante do ramo sem-lock (16:00Z): Cirilo/
    // Samuel byte-a-byte (o fix NÃO muda nada pra clones de São Paulo).
    expect(mocks.upsertAtendimentoFromEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        gcalEventId: 'evt-sp',
        inicioAt: '2026-06-16T16:00:00.000Z',
        fimAt: '2026-06-16T16:30:00.000Z',
      }),
    );
  });

  it('action-lock ON (estabelecimento, Cuiabá −04): grava inicio_at REANCORADO no colaborador certo', async () => {
    cfg.IDEMPOTENCY_ACTION_LOCK = true;
    cfg.ATEND_FROM_AGENDA_SLOTS = 'clone_estab_x';
    mocks.getScopeBySlot.mockResolvedValue({
      product_type: 'estabelecimento',
      seat_cap: 5,
      tenant_id: 't-estab',
    });
    const cBruno = colabClientStub('cal-bruno');
    setupEstabelecimento(
      [{ colaboradorId: 10, nome: 'Bruno', shortId: 'C1', client: cBruno, servicos: ['Corte'] }],
      { services: [{ name: 'Corte', min: 30 }] },
    );
    // override do fuso do clone do estabelecimento: Cuiabá (−04)
    mocks.loadScheduleConfig.mockResolvedValue({
      source: 'flow_clones',
      services: [{ name: 'Corte', min: 30 }],
      timezone: 'America/Cuiaba',
    });
    const bot = new TesteBarbeariaBot({ slotOverride: 'clone_estab_x' });
    await (bot as unknown as { process: (c: BotContext) => Promise<string | null> }).process(
      makeCtx('quero cortar'),
    );
    const tools = mocks.runAgentConfigured.mock.calls[0][0].tools as Array<{
      name: string;
      run: (a: unknown) => Promise<Record<string, unknown>>;
    }>;
    const inserir = tools.find((t) => t.name === 'inserir_agendamento') as {
      run: (a: unknown) => Promise<Record<string, unknown>>;
    };
    const res = await inserir.run({
      colaborador_id: 'C1',
      summary: 'Fulano - Corte | WhatsApp: 5511988887777',
      servico: 'Corte',
      start: '2026-06-30T22:00:00-03:00',
      end: '2026-06-30T23:00:00-03:00',
    });
    expect(res.ok).toBe(true);
    expect((cBruno as { createEvent: ReturnType<typeof vi.fn> }).createEvent).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.withActionLock).toHaveBeenCalledTimes(1);
    expect(mocks.upsertAtendimentoFromEvent).toHaveBeenCalledTimes(1);
    // mesmo fix do individual, agora no ramo action-lock do estabelecimento: instante reancorado.
    expect(mocks.upsertAtendimentoFromEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        colaboradorId: 10,
        inicioAt: '2026-07-01T02:00:00.000Z',
        fimAt: '2026-07-01T03:00:00.000Z',
      }),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Remarcação via patchEvent (fix do double-redeem) — individual + estabelecimento
// ════════════════════════════════════════════════════════════════════════════════
//
// BUG: o bot só tinha inserir_agendamento (createEvent -> eventId NOVO). Remarcar criava
// um evento NOVO -> 2ª linha de atendimentos (fatura 2x), 2ª baixa de pacote (UNIQUE
// (gcal_event_id,reason) não pega id novo) e lembrete pros 2 horários. A tool
// remarcar_agendamento usa patchEvent (preserva o eventId), espelhando o PATCH do portal
// (#331). Garantias verificadas aqui:
//  - patchEvent é chamado com o MESMO eventId; createEvent NUNCA é chamado;
//  - NÃO há 2º atendimento (upsert da CRIAÇÃO não roda) nem 2ª dedução de pacote;
//  - a linha é SINCRONIZADA (mesma linha, nova janela) SEM formaPagamento -> preserva a
//    marca 'pacote' e reaponta o lembrete (mesmo atendimento_id, novo inicio_at);
//  - resolve só o agendamento DO PRÓPRIO cliente (telefone da conversa); not_found/conflito
//    não tocam o GCal; estabelecimento patcha na agenda do colaborador DONO (não move).

/** Evento existente do cliente da conversa (telefone 5511988887777) às 14h. */
const EVT_EXISTENTE = {
  id: 'evt-existente',
  summary: 'Fulano - Corte | WhatsApp: 5511988887777',
  start: { dateTime: '2026-06-20T14:00:00-03:00' },
  end: { dateTime: '2026-06-20T14:30:00-03:00' },
};

/** setupSchedule individual com listEvents (existentes) + patchEvent espionáveis. */
function setupScheduleComPatch(existingEvents: unknown[]) {
  const calClient = {
    listEvents: vi.fn().mockResolvedValue(existingEvents),
    createEvent: vi.fn().mockResolvedValue({ id: 'evt-novo', summary: 'X' }),
    patchEvent: vi
      .fn()
      .mockImplementation((id: string, f: { startISO?: string; endISO?: string }) =>
        Promise.resolve({
          id, // preserva o eventId
          summary: 'Fulano - Corte | WhatsApp: 5511988887777',
          start: { dateTime: f.startISO },
          end: { dateTime: f.endISO },
        }),
      ),
  };
  mocks.getGcalForSlot.mockResolvedValue(calClient);
  mocks.loadScheduleConfig.mockResolvedValue({
    source: 'flow_clones',
    services: [],
    timezone: 'America/Sao_Paulo',
  });
  mocks.formatarAgendaComConfig.mockReturnValue('AGENDA');
  mocks.renderPrompt.mockResolvedValue('PERSONA');
  mocks.buildContextBlock.mockResolvedValue('CONTEXT');
  mocks.runAgentConfigured.mockResolvedValue({ reply: 'ok' });
  mocks.loadHistory.mockResolvedValue([{ role: 'user', content: 'oi' }]);
  mocks.getProductType.mockResolvedValue('individual');
  mocks.getArea.mockResolvedValue('barbearia');
  return calClient;
}

/** Roda process() (individual) e devolve a tool remarcar_agendamento. */
async function remarcarToolIndividual(): Promise<{
  run: (a: unknown) => Promise<Record<string, unknown>>;
}> {
  const bot = new TesteBarbeariaBot();
  await (bot as unknown as { process: (c: BotContext) => Promise<string | null> }).process(
    makeCtx('quero remarcar meu horario'),
  );
  const tools = mocks.runAgentConfigured.mock.calls[0][0].tools as Array<{
    name: string;
    run: (a: unknown) => Promise<Record<string, unknown>>;
  }>;
  return tools.find((t) => t.name === 'remarcar_agendamento') as {
    run: (a: unknown) => Promise<Record<string, unknown>>;
  };
}

describe('TesteBarbeariaBot — remarcação via patchEvent (individual)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cfg.CANCELAMENTO_ESCALADO_ENABLED = false;
    cfg.ESTABELECIMENTO_ENABLED = false;
    cfg.IDEMPOTENCY_ACTION_LOCK = false;
    cfg.PACOTES_ENABLED = false;
    cfg.ATEND_FROM_AGENDA_SLOTS = '';
    mocks.resolveClientPackages.mockResolvedValue([]);
    mocks.buildSeuPacoteBlock.mockReturnValue('');
    mocks.getScopeBySlot.mockResolvedValue({
      product_type: 'individual',
      seat_cap: null,
      tenant_id: 't-uuid',
    });
    mocks.servicoFromSummary.mockReturnValue('Corte');
    mocks.clienteFromSummary.mockReturnValue('Fulano');
    mocks.syncAtendimentoFromEvent.mockResolvedValue({ id: 555 });
  });

  it('expõe remarcar_agendamento e NENHUMA tool de create disfarçada', async () => {
    setupScheduleComPatch([EVT_EXISTENTE]);
    const bot = new TesteBarbeariaBot();
    await (bot as unknown as { process: (c: BotContext) => Promise<string | null> }).process(
      makeCtx('quero remarcar'),
    );
    const tools = mocks.runAgentConfigured.mock.calls[0][0].tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toContain('remarcar_agendamento');
  });

  it('caminho feliz: PATCH preserva o MESMO eventId e NÃO cria evento novo', async () => {
    const calClient = setupScheduleComPatch([EVT_EXISTENTE]);
    const remarcar = await remarcarToolIndividual();
    const res = await remarcar.run({
      start_atual: '2026-06-20T14:00:00-03:00',
      novo_start: '2026-06-20T16:00:00-03:00',
      novo_end: '2026-06-20T16:30:00-03:00',
    });
    expect(res).toMatchObject({ ok: true, eventId: 'evt-existente' });
    // patchEvent no MESMO eventId, com a nova janela; createEvent NUNCA chamado.
    expect(calClient.patchEvent).toHaveBeenCalledTimes(1);
    expect(calClient.patchEvent).toHaveBeenCalledWith(
      'evt-existente',
      expect.objectContaining({
        // Nova janela reancorada no fuso do clone (SP): 16:00−03:00 == 19:00Z (MESMO instante).
        startISO: '2026-06-20T19:00:00.000Z',
        endISO: '2026-06-20T19:30:00.000Z',
      }),
    );
    expect(calClient.createEvent).not.toHaveBeenCalled();
  });

  it('gate ON: sincroniza a MESMA linha (não cria 2º atendimento) e SEM forma de pagamento', async () => {
    cfg.ATEND_FROM_AGENDA_SLOTS = 'teste_barbearia';
    cfg.PACOTES_ENABLED = true; // mesmo com pacotes ON, remarcar NÃO deduz de novo
    setupScheduleComPatch([EVT_EXISTENTE]);
    const remarcar = await remarcarToolIndividual();
    await remarcar.run({
      start_atual: '2026-06-20T14:00:00-03:00',
      novo_start: '2026-06-20T16:00:00-03:00',
      novo_end: '2026-06-20T16:30:00-03:00',
    });
    // SYNC (mesma linha) — não a CRIAÇÃO. E SEM 2ª baixa de pacote.
    expect(mocks.syncAtendimentoFromEvent).toHaveBeenCalledTimes(1);
    expect(mocks.upsertAtendimentoFromEvent).not.toHaveBeenCalled();
    expect(mocks.deduzirPacoteNoAgendamento).not.toHaveBeenCalled();
    const arg = mocks.syncAtendimentoFromEvent.mock.calls[0][0];
    // MESMO eventId (idempotente) + janela NOVA (reaponta o lembrete: mesmo atendimento_id, novo inicio_at).
    expect(arg).toMatchObject({
      slot: 'teste_barbearia',
      tenantId: 't-uuid',
      gcalEventId: 'evt-existente',
      colaboradorId: null,
      // Janela reancorada no fuso do clone (SP): 16:00−03:00 == 19:00Z (MESMO instante).
      inicioAt: '2026-06-20T19:00:00.000Z',
      fimAt: '2026-06-20T19:30:00.000Z',
    });
    // formaPagamento NÃO é passado -> o UPDATE preserva a marca 'pacote' (não dobra a receita).
    expect(arg).not.toHaveProperty('formaPagamento');
  });

  it('gate OFF (default): NÃO sincroniza atendimento (byte-a-byte), mas remarca normal', async () => {
    const calClient = setupScheduleComPatch([EVT_EXISTENTE]);
    const remarcar = await remarcarToolIndividual();
    const res = await remarcar.run({
      start_atual: '2026-06-20T14:00:00-03:00',
      novo_start: '2026-06-20T16:00:00-03:00',
      novo_end: '2026-06-20T16:30:00-03:00',
    });
    expect(res).toMatchObject({ ok: true });
    expect(calClient.patchEvent).toHaveBeenCalledTimes(1);
    expect(mocks.syncAtendimentoFromEvent).not.toHaveBeenCalled();
    expect(mocks.getScopeBySlot).not.toHaveBeenCalled();
  });

  it('start_atual não encontrado: AGENDAMENTO_NAO_ENCONTRADO e NÃO toca o GCal', async () => {
    const calClient = setupScheduleComPatch([EVT_EXISTENTE]);
    const remarcar = await remarcarToolIndividual();
    const res = await remarcar.run({
      start_atual: '2026-06-21T10:00:00-03:00', // nenhum evento do cliente nesse horário
      novo_start: '2026-06-21T11:00:00-03:00',
      novo_end: '2026-06-21T11:30:00-03:00',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('AGENDAMENTO_NAO_ENCONTRADO');
    expect(calClient.patchEvent).not.toHaveBeenCalled();
    expect(mocks.syncAtendimentoFromEvent).not.toHaveBeenCalled();
  });

  it('conflito na nova janela: CONFLITO e NÃO patcha (anti-corrida, ignora o próprio evento)', async () => {
    const outro = {
      id: 'evt-outro',
      summary: 'Outro - Barba',
      start: { dateTime: '2026-06-20T16:00:00-03:00' },
      end: { dateTime: '2026-06-20T16:30:00-03:00' },
    };
    const calClient = setupScheduleComPatch([EVT_EXISTENTE, outro]);
    const remarcar = await remarcarToolIndividual();
    const res = await remarcar.run({
      start_atual: '2026-06-20T14:00:00-03:00',
      novo_start: '2026-06-20T16:00:00-03:00',
      novo_end: '2026-06-20T16:30:00-03:00',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('CONFLITO');
    expect(calClient.patchEvent).not.toHaveBeenCalled();
  });

  it('parâmetros inválidos (fim <= início): PARAMETROS_INVALIDOS sem tocar o GCal', async () => {
    const calClient = setupScheduleComPatch([EVT_EXISTENTE]);
    const remarcar = await remarcarToolIndividual();
    const res = await remarcar.run({
      start_atual: '2026-06-20T14:00:00-03:00',
      novo_start: '2026-06-20T16:30:00-03:00',
      novo_end: '2026-06-20T16:00:00-03:00', // fim antes do início
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('PARAMETROS_INVALIDOS');
    expect(calClient.patchEvent).not.toHaveBeenCalled();
  });
});

describe('TesteBarbeariaBot — remarcação via patchEvent (estabelecimento)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cfg.CANCELAMENTO_ESCALADO_ENABLED = false;
    cfg.ESTABELECIMENTO_ENABLED = false;
    cfg.IDEMPOTENCY_ACTION_LOCK = false;
    cfg.PACOTES_ENABLED = false;
    cfg.ATEND_FROM_AGENDA_SLOTS = '';
    mocks.resolveClientPackages.mockResolvedValue([]);
    mocks.buildSeuPacoteBlock.mockReturnValue('');
    mocks.servicoFromSummary.mockReturnValue('Corte');
    mocks.clienteFromSummary.mockReturnValue('Fulano');
    mocks.syncAtendimentoFromEvent.mockResolvedValue({ id: 999 });
    mocks.getScopeBySlot.mockResolvedValue({
      product_type: 'estabelecimento',
      seat_cap: 5,
      tenant_id: 't-estab',
    });
  });

  it('expõe remarcar_agendamento no estabelecimento', async () => {
    const tools = await estabToolsFor('quero remarcar', [
      { colaboradorId: 10, nome: 'João S.', shortId: 'C1', client: colabClientStub('cal-joao') },
    ]);
    expect(tools.map((t) => t.name)).toContain('remarcar_agendamento');
  });

  it('acha o evento na agenda do colaborador DONO, patcha LÁ (mesmo eventId) e não toca o outro', async () => {
    cfg.ATEND_FROM_AGENDA_SLOTS = 'clone_estab_x';
    const evtMaria = {
      id: 'evt-est-maria',
      summary: 'Fulano - Corte | WhatsApp: 5511988887777',
      start: { dateTime: '2026-06-20T14:00:00-03:00' },
      end: { dateTime: '2026-06-20T14:30:00-03:00' },
    };
    const cJoao = colabClientStub('cal-joao', []); // sem eventos do cliente
    const cMaria = colabClientStub('cal-maria', [evtMaria]); // o evento vive aqui
    const tools = await estabToolsFor('quero remarcar', [
      { colaboradorId: 10, nome: 'João', shortId: 'C1', client: cJoao },
      { colaboradorId: 11, nome: 'Maria', shortId: 'C2', client: cMaria },
    ]);
    const remarcar = tools.find((t) => t.name === 'remarcar_agendamento') as {
      run: (a: unknown) => Promise<Record<string, unknown>>;
    };
    const res = await remarcar.run({
      start_atual: '2026-06-20T14:00:00-03:00',
      novo_start: '2026-06-20T17:00:00-03:00',
      novo_end: '2026-06-20T17:30:00-03:00',
    });
    expect(res).toMatchObject({ ok: true, eventId: 'evt-est-maria' });
    // Patch na agenda da Maria (dona do evento), preservando o eventId; João intocado.
    expect(cMaria.patchEvent).toHaveBeenCalledWith('evt-est-maria', expect.any(Object));
    expect(cJoao.patchEvent).not.toHaveBeenCalled();
    expect(cMaria.createEvent).not.toHaveBeenCalled();
    // Sincroniza a MESMA linha com o colaborador DONO (comissão fica com Maria), sem 2º atendimento.
    expect(mocks.syncAtendimentoFromEvent).toHaveBeenCalledTimes(1);
    expect(mocks.upsertAtendimentoFromEvent).not.toHaveBeenCalled();
    expect(mocks.syncAtendimentoFromEvent.mock.calls[0][0]).toMatchObject({
      slot: 'clone_estab_x',
      tenantId: 't-estab',
      gcalEventId: 'evt-est-maria',
      colaboradorId: 11,
      // Reancorado no fuso do clone (SP): 17:00−03:00 == 20:00Z (MESMO instante).
      inicioAt: '2026-06-20T20:00:00.000Z',
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// IDOR / vazamento de PII cross-cliente — as tools consultar_* SEMPRE usam o telefone
// da CONVERSA (o remetente), NUNCA o que o LLM passa.
// ════════════════════════════════════════════════════════════════════════════════
//
// Bug fechado: `consultar_agendamento` (individual + estabelecimento) e `consultar_pacote`
// usavam o `telefone` cru vindo do modelo. Um cliente pedia "ver o pacote/horário do 5511…"
// e o bot devolvia nome/horário/saldo de OUTRO cliente do MESMO tenant. Agora o telefone
// vem SEMPRE da conversa; o argumento do LLM é ignorado (param deixou de ser obrigatório).

describe('TesteBarbeariaBot — IDOR/PII: consultar_* usam o telefone da CONVERSA, não do LLM', () => {
  const CONVERSA = '5511988887777'; // = makeCtx (remetente real da conversa)
  const OUTRO = '5511777776666'; // número de OUTRO cliente que o atacante tenta espiar

  beforeEach(() => {
    vi.clearAllMocks();
    cfg.CANCELAMENTO_ESCALADO_ENABLED = false;
    cfg.ESTABELECIMENTO_ENABLED = false;
    cfg.IDEMPOTENCY_ACTION_LOCK = false;
    cfg.PACOTES_ENABLED = false;
    cfg.ATEND_FROM_AGENDA_SLOTS = '';
    mocks.resolveClientPackages.mockResolvedValue([]);
    mocks.buildSeuPacoteBlock.mockReturnValue('');
  });

  it('consultar_agendamento (individual) IGNORA o telefone do LLM e só devolve o horário da CONVERSA', async () => {
    const calClient = setupSchedule();
    // A agenda do tenant tem o horário do PRÓPRIO cliente E o de OUTRO cliente.
    calClient.listEvents.mockResolvedValue([
      {
        summary: `Fulano - Corte | WhatsApp: ${CONVERSA}`,
        start: { dateTime: 'A' },
        end: { dateTime: 'B' },
      },
      {
        summary: `Vizinho - Corte | WhatsApp: ${OUTRO}`,
        start: { dateTime: 'C' },
        end: { dateTime: 'D' },
      },
    ]);
    const bot = new TesteBarbeariaBot();
    await (bot as unknown as { process: (c: BotContext) => Promise<string | null> }).process(
      makeCtx('quero ver meus agendamentos'),
    );
    const tools = mocks.runAgentConfigured.mock.calls[0][0].tools as Array<{ name: string }>;
    const consultar = tools.find((t) => t.name === 'consultar_agendamento') as unknown as {
      parameters: { required: string[] };
      run: (a: unknown) => Promise<{ events: Array<{ summary?: string }> }>;
    };
    // telefone deixou de ser obrigatório — o LLM não tem como alvejar outro número.
    expect(consultar.parameters.required).not.toContain('telefone');
    // Atacante tenta espiar o horário de OUTRO cliente...
    const res = await consultar.run({ telefone: OUTRO });
    // ...mas só recebe o agendamento do PRÓPRIO número da conversa.
    expect(res.events).toHaveLength(1);
    expect(res.events[0].summary).toContain(CONVERSA);
    expect(JSON.stringify(res.events)).not.toContain(OUTRO);
  });

  it('consultar_pacote IGNORA o telefone do LLM e consulta o saldo do número da CONVERSA', async () => {
    cfg.PACOTES_ENABLED = true;
    mocks.resolveClientPackages.mockResolvedValue([]);
    const { tools } = await runIndividual('quanto saldo eu tenho?');
    const consultar = tools.find((t) => t.name === 'consultar_pacote') as unknown as {
      parameters: { required: string[] };
      run: (a: unknown) => Promise<unknown>;
    };
    expect(consultar.parameters.required).not.toContain('telefone');
    // Atacante passa o número de OUTRO cliente.
    await consultar.run({ telefone: OUTRO });
    // resolveClientPackages NUNCA é chamado com o número do atacante...
    expect(mocks.resolveClientPackages).not.toHaveBeenCalledWith(
      expect.objectContaining({ telefone: OUTRO }),
    );
    // ...e É chamado com o telefone da conversa.
    expect(mocks.resolveClientPackages).toHaveBeenCalledWith(
      expect.objectContaining({ telefone: CONVERSA }),
    );
  });

  it('consultar_agendamento (estabelecimento) IGNORA o telefone do LLM ao cruzar as agendas', async () => {
    const c1 = colabClientStub('cal-joao', [
      {
        summary: `Fulano - Corte | WhatsApp: ${CONVERSA}`,
        start: { dateTime: 'A' },
        end: { dateTime: 'B' },
      },
      {
        summary: `Vizinho - Corte | WhatsApp: ${OUTRO}`,
        start: { dateTime: 'C' },
        end: { dateTime: 'D' },
      },
    ]);
    const tools = await estabToolsFor('quero ver meus agendamentos', [
      { colaboradorId: 10, nome: 'João S.', shortId: 'C1', client: c1 },
    ]);
    const consultar = tools.find((t) => t.name === 'consultar_agendamento') as unknown as {
      parameters: { required: string[] };
      run: (a: unknown) => Promise<{ events: Array<{ summary?: string }> }>;
    };
    expect(consultar.parameters.required).not.toContain('telefone');
    const res = await consultar.run({ telefone: OUTRO });
    expect(res.events).toHaveLength(1);
    expect(res.events[0].summary).toContain(CONVERSA);
    expect(JSON.stringify(res.events)).not.toContain(OUTRO);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// MODO ATENDENTE (SCRUM-59) — bot sem agenda automática
// ════════════════════════════════════════════════════════════════════════════════

/** Configura os mocks p/ o ramo ATENDENTE completar até o runAgent. */
function setupAtendente(opts?: { agendaAutomatica?: unknown; link?: string }) {
  mocks.renderPrompt.mockResolvedValue('PERSONA');
  mocks.buildContextBlock.mockResolvedValue('CONTEXT');
  mocks.runAgentConfigured.mockResolvedValue({ reply: 'posso te ajudar com isso' });
  mocks.loadHistory.mockResolvedValue([{ role: 'user', content: 'oi' }]);
  // getCloneBySlot alimenta o gate (agenda_automatica) + fuso + link no processAtendente.
  mocks.getCloneBySlot.mockResolvedValue({
    timezone: 'America/Sao_Paulo',
    personalizacao: {
      agenda_automatica: opts?.agendaAutomatica ?? false,
      ...(opts?.link ? { link_agendamento: opts.link } : {}),
    },
  });
  mocks.sendOwnerAlert.mockResolvedValue({ ok: true, escalado: true });
  mocks.addFlowPause.mockResolvedValue(undefined);
  // Default: individual (sem bloco [EQUIPE]). Testes de estabelecimento sobrescrevem.
  mocks.getProductType.mockResolvedValue('individual');
  mocks.listColaboradores.mockResolvedValue([]);
}

/** Roda process() no modo atendente e devolve o array `tools` passado ao runAgent. */
async function atendenteToolsFor(texto: string): Promise<Array<{ name: string }>> {
  const bot = new TesteBarbeariaBot();
  await (bot as unknown as { process: (c: BotContext) => Promise<string | null> }).process(
    makeCtx(texto),
  );
  return mocks.runAgentConfigured.mock.calls[0][0].tools;
}

describe('TesteBarbeariaBot — MODO ATENDENTE (SCRUM-59)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cfg.CANCELAMENTO_ESCALADO_ENABLED = false;
    cfg.ESTABELECIMENTO_ENABLED = false;
    cfg.IDEMPOTENCY_ACTION_LOCK = false;
    cfg.PACOTES_ENABLED = false;
    cfg.ATEND_FROM_AGENDA_SLOTS = '';
    cfg.MODO_ATENDENTE_SLOTS = '';
  });

  it('gate OFF (default): NÃO entra no modo atendente — caminho individual byte-a-byte', async () => {
    setupSchedule(); // caminho individual completo (com agenda)
    const tools = await atendenteToolsFor('quanto é o corte?');
    const names = tools.map((t) => t.name);
    // tools de AGENDA presentes (caminho individual), nenhuma tool de atendente.
    expect(names).toContain('inserir_agendamento');
    expect(names).toContain('consultar_agendamento');
    expect(names).not.toContain('escalar_para_humano');
    expect(names).not.toContain('registrar_interesse');
    // gate OFF short-circuita ANTES de ler o clone pro modo (byte-a-byte: 0 leitura extra).
    expect(mocks.getGcalForSlot).toHaveBeenCalled();
  });

  it('gate ON + agenda_automatica=false: RESPONDE sem gcal e só com as 2 tools do atendente', async () => {
    cfg.MODO_ATENDENTE_SLOTS = '*';
    setupAtendente({ agendaAutomatica: false });
    const reply = await (
      new TesteBarbeariaBot() as unknown as { process: (c: BotContext) => Promise<string | null> }
    ).process(makeCtx('quanto é o corte?'));
    expect(reply).toBe('posso te ajudar com isso');
    // NUNCA consulta a agenda (sem gate de gcal no modo atendente).
    expect(mocks.getGcalForSlot).not.toHaveBeenCalled();
    expect(mocks.loadScheduleConfig).not.toHaveBeenCalled();
    const tools = mocks.runAgentConfigured.mock.calls[0][0].tools as Array<{ name: string }>;
    const names = tools.map((t) => t.name);
    expect(names).toEqual(['escalar_para_humano', 'registrar_interesse']);
  });

  it('modo atendente NÃO registra NENHUMA tool de agenda (incapacidade por construção)', async () => {
    cfg.MODO_ATENDENTE_SLOTS = '*';
    setupAtendente({ agendaAutomatica: false });
    const tools = await atendenteToolsFor('quero marcar');
    for (const t of tools) {
      expect(t.name).not.toMatch(/inserir_agendamento|remarcar_agendamento|consultar_agendamento/);
    }
  });

  it('buildContextBlock é chamado SEM agendaFormatada (nega disponibilidade real-time)', async () => {
    cfg.MODO_ATENDENTE_SLOTS = '*';
    setupAtendente({ agendaAutomatica: false });
    await atendenteToolsFor('abre domingo?');
    const arg = mocks.buildContextBlock.mock.calls[0][0];
    expect(arg.agendaFormatada).toBeUndefined();
  });

  it('gate ON mas agenda_automatica=true: NÃO entra no atendente — caminho individual (agenda)', async () => {
    cfg.MODO_ATENDENTE_SLOTS = '*';
    // gate liga, mas o perfil mantém agenda automática -> cai no individual.
    mocks.getCloneBySlot.mockResolvedValue({
      timezone: 'America/Sao_Paulo',
      personalizacao: { agenda_automatica: true },
    });
    setupSchedule();
    const tools = await atendenteToolsFor('quanto é o corte?');
    const names = tools.map((t) => t.name);
    expect(names).toContain('inserir_agendamento');
    expect(names).not.toContain('escalar_para_humano');
    expect(mocks.getGcalForSlot).toHaveBeenCalled();
  });

  it('gate ON + agenda_automatica AUSENTE (undefined): NÃO entra no atendente — fluxo normal (gap qa)', async () => {
    cfg.MODO_ATENDENTE_SLOTS = '*';
    // gate liga, MAS a chave agenda_automatica nem existe no perfil (undefined) -> como
    // undefined != false/'false', o bot NÃO vira atendente e segue o caminho individual.
    mocks.getCloneBySlot.mockResolvedValue({
      timezone: 'America/Sao_Paulo',
      personalizacao: { nome_negocio: 'X' }, // SEM agenda_automatica
    });
    setupSchedule();
    const tools = await atendenteToolsFor('quanto é o corte?');
    const names = tools.map((t) => t.name);
    expect(names).toContain('inserir_agendamento');
    expect(names).not.toContain('escalar_para_humano');
    expect(names).not.toContain('registrar_interesse');
    expect(mocks.getGcalForSlot).toHaveBeenCalled();
  });

  it('agenda_automatica como STRING "false" também liga o modo atendente (defensivo)', async () => {
    cfg.MODO_ATENDENTE_SLOTS = '*';
    setupAtendente({ agendaAutomatica: 'false' });
    await atendenteToolsFor('oi');
    const tools = mocks.runAgentConfigured.mock.calls[0][0].tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(['escalar_para_humano', 'registrar_interesse']);
  });

  it('tool registrar_interesse -> chama sendOwnerAlert(kind=lead, transport=clone_session)', async () => {
    cfg.MODO_ATENDENTE_SLOTS = '*';
    setupAtendente({ agendaAutomatica: false });
    const tools = await atendenteToolsFor('quero marcar corte sábado de manhã');
    const tool = tools.find((t) => t.name === 'registrar_interesse') as unknown as {
      run: (a: unknown) => Promise<{ ok: boolean; registrado: boolean }>;
    };
    const res = await tool.run({ servico: 'Corte', janela: 'sábado de manhã', profissional: '' });
    expect(res).toEqual({ ok: true, registrado: true });
    expect(mocks.sendOwnerAlert).toHaveBeenCalledTimes(1);
    const arg = mocks.sendOwnerAlert.mock.calls[0][0];
    expect(arg).toMatchObject({ kind: 'lead', transport: 'clone_session' });
    expect(arg.payload).toMatchObject({ servico: 'Corte', janela: 'sábado de manhã' });
    // registrar_interesse NÃO auto-pausa (só escalar pausa).
    expect(mocks.addFlowPause).not.toHaveBeenCalled();
  });

  it('SCRUM-62: escalar_para_humano SÓ alerta (escalonamento) e NÃO auto-pausa', async () => {
    cfg.MODO_ATENDENTE_SLOTS = '*';
    setupAtendente({ agendaAutomatica: false });
    const tools = await atendenteToolsFor('quero falar com uma pessoa');
    const tool = tools.find((t) => t.name === 'escalar_para_humano') as unknown as {
      run: (a: unknown) => Promise<{ ok: boolean; escalado: boolean }>;
    };
    const res = await tool.run({ motivo: 'pediu_humano', resumo: 'quer falar com atendente' });
    expect(res).toEqual({ ok: true, escalado: true });
    const arg = mocks.sendOwnerAlert.mock.calls[0][0];
    expect(arg).toMatchObject({ kind: 'escalonamento', transport: 'clone_session' });
    // SCRUM-62: escalar NUNCA pausa (a pausa escalated_human PERMANENTE foi removida). A
    // pausa temporária só ocorre quando o atendente responde à mão (router.ts, human_reply).
    expect(mocks.addFlowPause).not.toHaveBeenCalled();
  });

  // ── Bloco [EQUIPE] no modo atendente (estabelecimento) ──────────────────────
  it('estabelecimento + atendente: injeta [EQUIPE] (nome+serviços) SEM tocar gcal', async () => {
    cfg.MODO_ATENDENTE_SLOTS = '*';
    setupAtendente({ agendaAutomatica: false });
    mocks.getProductType.mockResolvedValue('estabelecimento');
    mocks.listColaboradores.mockResolvedValue([
      { id: 1, nome: 'Thomas', servicos: ['corte', 'barba'], ativo: true },
      { id: 2, nome: 'Isaac', servicos: [], ativo: true },
      { id: 3, nome: 'Inativo', servicos: ['corte'], ativo: false }, // filtrado
    ]);
    await (
      new TesteBarbeariaBot() as unknown as { process: (c: BotContext) => Promise<string | null> }
    ).process(makeCtx('quem faz barba?'));
    const systemPrompt = mocks.runAgentConfigured.mock.calls[0][0].systemPrompt as string;
    expect(systemPrompt).toContain('[EQUIPE - PROFISSIONAIS DESTE NEGOCIO]');
    expect(systemPrompt).toContain('- Thomas: corte, barba');
    expect(systemPrompt).toContain('- Isaac'); // sem serviços -> só nome
    expect(systemPrompt).not.toContain('Inativo'); // colaborador inativo não entra
    // instrução de equipe no guardrail + NUNCA agenda por profissional.
    expect(systemPrompt).toContain('[EQUIPE - VARIOS PROFISSIONAIS]');
    // Modo atendente NÃO resolve agenda de colaborador (sem gcal).
    expect(mocks.getGcalsForSlot).not.toHaveBeenCalled();
    expect(mocks.getGcalForSlot).not.toHaveBeenCalled();
  });

  it('individual + atendente: SEM bloco [EQUIPE] (byte-a-byte)', async () => {
    cfg.MODO_ATENDENTE_SLOTS = '*';
    setupAtendente({ agendaAutomatica: false }); // getProductType='individual'
    await atendenteToolsFor('oi');
    const systemPrompt = mocks.runAgentConfigured.mock.calls[0][0].systemPrompt as string;
    // "EQUIPE" aparece no texto normal do guardrail ("EQUIPE vai confirmar"); o que NÃO deve
    // existir é o BLOCO de equipe (lista de profissionais + instrução de vários profissionais).
    expect(systemPrompt).not.toContain('[EQUIPE - PROFISSIONAIS DESTE NEGOCIO]');
    expect(systemPrompt).not.toContain('[EQUIPE - VARIOS PROFISSIONAIS]');
    expect(mocks.listColaboradores).not.toHaveBeenCalled();
  });

  it('GATE ORDER: estabelecimento + gate ON + agenda_automatica=false -> processAtendente (não processEstabelecimento)', async () => {
    cfg.MODO_ATENDENTE_SLOTS = '*';
    cfg.ESTABELECIMENTO_ENABLED = true; // mesmo com estabelecimento ligado...
    setupAtendente({ agendaAutomatica: false });
    mocks.getProductType.mockResolvedValue('estabelecimento');
    mocks.listColaboradores.mockResolvedValue([
      { id: 1, nome: 'Thomas', servicos: [], ativo: true },
    ]);
    const tools = await atendenteToolsFor('quero com o Thomas');
    // ...o modo atendente GANHA: só as 2 tools de atendente, ZERO tool/agenda de estabelecimento.
    expect(tools.map((t) => t.name)).toEqual(['escalar_para_humano', 'registrar_interesse']);
    expect(mocks.getGcalsForSlot).not.toHaveBeenCalled();
    expect(mocks.buildEstabelecimentoContext).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// DEGRADE ELEGANTE agenda→atendente (ADR 0030 D3, Onda 3)
//
// Clone individual que escolheu AGENDA mas cuja Service Account do Google ainda NÃO
// foi conectada pelo time: em vez do gate DURO ("agenda não configurada, avise o
// admin"), o bot degrada pra atendente. É derivação de RUNTIME (efetivo = agenda &&
// gcalConfigured) — o valor armazenado NÃO muda; ao conectar o gcal, vira agenda só.
// O modo-atendente por gate está OFF (MODO_ATENDENTE_SLOTS='') DE PROPÓSITO: prova que
// é o DEGRADE (gcal ausente), não o gate por-clone, que roteia pro atendente.
// ════════════════════════════════════════════════════════════════════════════════
describe('TesteBarbeariaBot — DEGRADE ELEGANTE agenda→atendente (ADR 0030 D3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cfg.CANCELAMENTO_ESCALADO_ENABLED = false;
    cfg.ESTABELECIMENTO_ENABLED = false;
    cfg.IDEMPOTENCY_ACTION_LOCK = false;
    cfg.PACOTES_ENABLED = false;
    cfg.ATEND_FROM_AGENDA_SLOTS = '';
    cfg.MODO_ATENDENTE_SLOTS = ''; // modo atendente OFF: o degrade é quem roteia.
    mocks.resolveClientPackages.mockResolvedValue([]);
    mocks.buildSeuPacoteBlock.mockReturnValue('');
  });

  /** Clone AGENDA (agenda_automatica=true), individual, mas SEM gcal conectado. */
  function setupDegrade() {
    mocks.getGcalForSlot.mockResolvedValue(null); // Service Account ainda não conectada
    mocks.getProductType.mockResolvedValue('individual');
    mocks.getCloneBySlot.mockResolvedValue({
      timezone: 'America/Sao_Paulo',
      personalizacao: { agenda_automatica: true }, // INTENÇÃO agenda (não é atendente)
    });
    mocks.renderPrompt.mockResolvedValue('PERSONA');
    mocks.buildContextBlock.mockResolvedValue('CONTEXT');
    mocks.runAgentConfigured.mockResolvedValue({ reply: 'posso te ajudar com isso' });
    mocks.loadHistory.mockResolvedValue([{ role: 'user', content: 'oi' }]);
    mocks.listColaboradores.mockResolvedValue([]);
    mocks.getArea.mockResolvedValue('barbearia');
  }

  it('clone agenda SEM gcal => degrada pra atendente: SÓ as 2 tools de atendente, NENHUMA de agenda', async () => {
    setupDegrade();
    const reply = await (
      new TesteBarbeariaBot() as unknown as { process: (c: BotContext) => Promise<string | null> }
    ).process(makeCtx('quero marcar um corte'));
    expect(reply).toBe('posso te ajudar com isso');
    const tools = mocks.runAgentConfigured.mock.calls[0][0].tools as Array<{ name: string }>;
    const names = tools.map((t) => t.name);
    expect(names).toEqual(['escalar_para_humano', 'registrar_interesse']);
    expect(names).not.toContain('inserir_agendamento');
    expect(names).not.toContain('consultar_agendamento');
    expect(names).not.toContain('remarcar_agendamento');
  });

  it('degrade NÃO promete horário: buildContextBlock chamado SEM agendaFormatada', async () => {
    setupDegrade();
    await (
      new TesteBarbeariaBot() as unknown as { process: (c: BotContext) => Promise<string | null> }
    ).process(makeCtx('tem horário amanhã?'));
    // getGcalForSlot foi consultado (é o sinal de "configurado?"), mas não devolveu client.
    expect(mocks.getGcalForSlot).toHaveBeenCalledTimes(1);
    expect(mocks.loadScheduleConfig).not.toHaveBeenCalled();
    const ctxArg = mocks.buildContextBlock.mock.calls[0][0];
    expect(ctxArg.agendaFormatada).toBeUndefined();
  });

  it('clone agenda COM gcal => caminho AGENDA normal (Cirilo/Samuel inalterados): tools de agenda, NÃO degrada', async () => {
    // setupSchedule liga o gcal (getGcalForSlot -> client) + product individual.
    const tools = await toolsPassedFor('quero marcar um corte');
    const names = tools.map((t) => t.name);
    expect(names).toContain('inserir_agendamento');
    expect(names).toContain('consultar_agendamento');
    expect(names).not.toContain('escalar_para_humano');
    expect(names).not.toContain('registrar_interesse');
  });
});
