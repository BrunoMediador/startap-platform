/**
 * INJEÇÃO DO CARTÃO EM RUNTIME (SCRUM-92 inc.2 / ADR 0032) — caminho novo LIGADO.
 *
 * Complementa o golden byte-a-byte (systemprompt-golden.test.ts, que congela o baseline OFF):
 * aqui provamos o OUTRO lado do gate DUPLO (CARTAO_RUNTIME_ENABLED ON **E** cartao_mode='runtime')
 *   - individual: o cartão é montado por CÓDIGO, aparece UMA vez, com os emojis por área /
 *     do override do dono, e SUBSTITUI (não soma) o buildCartaoEmojiOverrideBlock;
 *   - estabelecimento: cartão runtime com 👤 PROFISSIONAL, uma vez só;
 *   - trava do gate: flag ON mas cartao_mode='baked' (default de todo clone) NÃO injeta nada.
 *
 * Reusa o mesmo scaffolding de mocks do golden (process() end-to-end até o runAgent).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BotContext } from '@startap/core/types';
import { BLOCO_ESTRUTURAL_MARKER } from '@startap/integrations/prompt-builder';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Persona SEM cartão baked (representa um clone cartao_mode='runtime': o cartão NÃO vive no
// bot_prompt, é montado por código). Sem [CARTAO...] e sem o header estrutural.
const PERSONA_RUNTIME = 'Você é o atendente virtual da Barbearia Runtime. Simpático e objetivo.';
const CONTEXT_FIXTURE = ['[CONTEXTO - DADOS DO BANCO]', 'NOME: Cliente Teste'].join('\n');

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
  getAreaAndPromptCustom: vi.fn(),
  getAreaPromptCustomCartao: vi.fn(),
  getScopeBySlot: vi.fn(),
  renderPrompt: vi.fn(),
  loadHistory: vi.fn(),
  logFlowEvent: vi.fn(),
  resolveClientPackages: vi.fn(),
  buildSeuPacoteBlock: vi.fn(),
  deduzirPacoteNoAgendamento: vi.fn(),
  servicoFromSummary: vi.fn(),
  clienteFromSummary: vi.fn(),
  getCloneBySlot: vi.fn(),
  upsertAtendimentoFromEvent: vi.fn(),
  syncAtendimentoFromEvent: vi.fn(),
  withActionLock: vi.fn(),
  csvGate: (slot: string, csv?: string | null): boolean => {
    if (!csv) return false;
    const e = csv
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return e.includes('*') || e.includes(slot);
  },
}));

vi.mock('@startap/db', () => ({
  chatMemory: { loadHistory: mocks.loadHistory },
  flowExecutionLog: { logFlowEvent: mocks.logFlowEvent },
  cloneColaboradores: {
    getProductType: mocks.getProductType,
    listBySlot: mocks.listColaboradores,
    getArea: mocks.getArea,
    getAreaAndPromptCustom: mocks.getAreaAndPromptCustom,
    getAreaPromptCustomCartao: mocks.getAreaPromptCustomCartao,
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

const cfg = {
  CANCELAMENTO_ESCALADO_ENABLED: false,
  IDEMPOTENCY_ACTION_LOCK: false,
  ESTABELECIMENTO_ENABLED: false,
  PACOTES_ENABLED: false,
  ATEND_FROM_AGENDA_SLOTS: '',
  MODO_ATENDENTE_SLOTS: '',
  CARTAO_RUNTIME_ENABLED: true, // caminho novo LIGADO neste arquivo
};
vi.mock('../config.js', () => ({ config: cfg }));

vi.mock('../lib/run-agent.js', () => ({ runAgentConfigured: mocks.runAgentConfigured }));
vi.mock('../lib/client-alert.js', () => ({
  sendClientCancellationAlert: mocks.sendClientCancellationAlert,
  sendOwnerAlert: mocks.sendOwnerAlert,
  phoneHint: (t: string) => t,
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
vi.mock('@startap/integrations/scheduling', async () => {
  const real = await vi.importActual<typeof import('@startap/integrations/scheduling')>(
    '@startap/integrations/scheduling',
  );
  return {
    ...real,
    loadScheduleConfig: mocks.loadScheduleConfig,
    formatarAgendaComConfig: mocks.formatarAgendaComConfig,
    buildContextBlock: mocks.buildContextBlock,
    buildEstabelecimentoContext: mocks.buildEstabelecimentoContext,
  };
});

const { TesteBarbeariaBot } = await import('./teste_barbearia.js');

function makeCtx(texto: string): BotContext {
  return {
    flowId: 'f1',
    message: {
      telefone: '5500000000000',
      texto,
      pushName: 'Cliente Teste',
      chatId: 'c',
      sessao: 's',
    },
  } as unknown as BotContext;
}

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

/** Roda process() e devolve o systemPrompt que o bot passou ao runAgent. */
async function systemPromptFor(slot: string): Promise<string> {
  const bot = new TesteBarbeariaBot({ slotOverride: slot });
  await (bot as unknown as { process: (c: BotContext) => Promise<string | null> }).process(
    makeCtx('quero marcar um corte'),
  );
  const calls = mocks.runAgentConfigured.mock.calls;
  return calls[calls.length - 1][0].systemPrompt as string;
}

function setupCommon(): void {
  mocks.renderPrompt.mockResolvedValue(PERSONA_RUNTIME);
  mocks.buildContextBlock.mockResolvedValue(CONTEXT_FIXTURE);
  mocks.runAgentConfigured.mockResolvedValue({ reply: 'ok' });
  mocks.loadHistory.mockResolvedValue([{ role: 'user', content: 'oi' }]);
  mocks.resolveClientPackages.mockResolvedValue([]);
  mocks.buildSeuPacoteBlock.mockReturnValue('');
}

function setupIndividual(cartao: {
  area: string | null;
  cartaoMode: 'baked' | 'runtime';
  cartaoConfig?: unknown;
}): void {
  setupCommon();
  mocks.getGcalForSlot.mockResolvedValue({ listEvents: vi.fn().mockResolvedValue([]) });
  mocks.loadScheduleConfig.mockResolvedValue({
    source: 'flow_clones',
    services: [],
    timezone: 'America/Sao_Paulo',
  });
  mocks.formatarAgendaComConfig.mockReturnValue('AGENDA');
  mocks.getProductType.mockResolvedValue('individual');
  mocks.getArea.mockResolvedValue(cartao.area);
  mocks.getAreaAndPromptCustom.mockResolvedValue({ area: cartao.area, promptCustom: false });
  mocks.getAreaPromptCustomCartao.mockResolvedValue({
    area: cartao.area,
    promptCustom: false,
    cartaoMode: cartao.cartaoMode,
    cartaoConfig: cartao.cartaoConfig ?? null,
    nomeNegocio: 'Barbearia Runtime',
  });
}

function setupEstabelecimento(cartao: {
  area: string | null;
  cartaoMode: 'baked' | 'runtime';
  cartaoConfig?: unknown;
}): void {
  setupCommon();
  cfg.ESTABELECIMENTO_ENABLED = true;
  mocks.getProductType.mockResolvedValue('estabelecimento');
  mocks.getGcalsForSlot.mockResolvedValue([{ shortId: 'C1', colaboradorId: 1 }]);
  mocks.loadScheduleConfig.mockResolvedValue({
    source: 'flow_clones',
    services: [],
    timezone: 'America/Sao_Paulo',
  });
  mocks.buildEstabelecimentoContext.mockResolvedValue({
    colaboradores: [],
    profissionaisBlock: 'C1 - Fulano',
    horariosBlock: 'C1: 09:00',
  });
  mocks.getArea.mockResolvedValue(cartao.area);
  mocks.getAreaPromptCustomCartao.mockResolvedValue({
    area: cartao.area,
    promptCustom: false,
    cartaoMode: cartao.cartaoMode,
    cartaoConfig: cartao.cartaoConfig ?? null,
    nomeNegocio: 'Estabelecimento Runtime',
  });
}

describe('cartão em runtime — caminho INDIVIDUAL (gate ON + cartao_mode=runtime)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cfg.ESTABELECIMENTO_ENABLED = false;
    cfg.PACOTES_ENABLED = false;
    cfg.CARTAO_RUNTIME_ENABLED = true;
  });

  it('injeta EXATAMENTE 1 cartão por código, com emojis da área e a REGRA cartão+SIM', async () => {
    setupIndividual({ area: 'barbearia', cartaoMode: 'runtime' });
    const sp = await systemPromptFor('clone_runtime_x');
    // 1 cartão só (1 header estrutural + 1 abertura de cartão).
    expect(count(sp, BLOCO_ESTRUTURAL_MARKER)).toBe(1);
    expect(count(sp, '[CARTAO DE CONFIRMACAO')).toBe(1);
    expect(sp).toContain('💈');
    expect(sp).toMatch(/SÓ DEPOIS do SIM, chamar a ferramenta inserir_agendamento/);
    // SUBSTITUIÇÃO, não soma: o override de emojis legado NÃO é injetado junto.
    expect(sp).not.toContain('[CARTAO DE CONFIRMACAO - EMOJIS DESTE NEGOCIO]');
  });

  it('emojis do dono (cartao_config.emojis) VENCEM a área — 🌻 no lugar de 💈, sem duplicar', async () => {
    setupIndividual({
      area: 'barbearia',
      cartaoMode: 'runtime',
      cartaoConfig: { emojis: { marca: '🌻' } },
    });
    const sp = await systemPromptFor('clone_runtime_ingrid');
    expect(sp).toContain('🌻');
    expect(sp).not.toContain('💈');
    expect(count(sp, '[CARTAO DE CONFIRMACAO')).toBe(1);
  });

  it('área sem config usa os emojis da área (salão → 💇)', async () => {
    setupIndividual({ area: 'salao', cartaoMode: 'runtime' });
    const sp = await systemPromptFor('clone_runtime_salao');
    expect(sp).toContain('💇');
    expect(count(sp, BLOCO_ESTRUTURAL_MARKER)).toBe(1);
  });

  it('TRAVA do gate duplo: flag ON mas cartao_mode=baked NÃO injeta cartão em runtime', async () => {
    setupIndividual({ area: 'barbearia', cartaoMode: 'baked' });
    const sp = await systemPromptFor('clone_baked_x');
    expect(sp).not.toContain(BLOCO_ESTRUTURAL_MARKER);
    // Barbearia baked → override legado devolve '' → systemPrompt = persona + contexto (byte-a-byte).
    expect(sp).toBe(`${PERSONA_RUNTIME}\n\n${CONTEXT_FIXTURE}`);
  });
});

// ── GOLDEN byte-a-byte do 1º clone RUNTIME (arquiteto: prova de estabilidade) ─────────
// Complementa o golden do BAKED (systemprompt-golden.test.ts): congela o systemPrompt montado no
// caminho INDIVIDUAL de um clone cartao_mode='runtime' barbearia (persona-only + contexto + cartão
// injetado por código). Se a montagem/cartão-runtime mudar 1 byte sem querer, este teste quebra
// ANTES de prod. Regenerar de propósito: UPDATE_GOLDEN=1 npx vitest run <este arquivo>.
function assertGolden(fixtureName: string, actual: string): void {
  const goldenPath = fileURLToPath(new URL(`./__fixtures__/${fixtureName}`, import.meta.url));
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(goldenPath, actual, 'utf8');
  expect(actual).toBe(readFileSync(goldenPath, 'utf8'));
}

describe('systemPrompt golden — clone RUNTIME de barbearia (SCRUM-92 inc.2, T5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cfg.ESTABELECIMENTO_ENABLED = false;
    cfg.PACOTES_ENABLED = false;
    cfg.CARTAO_RUNTIME_ENABLED = true;
  });

  it('runtime barbearia → systemPrompt byte-a-byte o golden congelado', async () => {
    setupIndividual({ area: 'barbearia', cartaoMode: 'runtime' });
    const sp = await systemPromptFor('clone_runtime_barbearia');
    assertGolden('systemprompt-runtime-barbearia.golden.txt', sp);
  });
});

describe('cartão em runtime — caminho ESTABELECIMENTO (gate ON + cartao_mode=runtime)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cfg.ESTABELECIMENTO_ENABLED = true;
    cfg.PACOTES_ENABLED = false;
    cfg.CARTAO_RUNTIME_ENABLED = true;
  });

  it('injeta o cartão de estabelecimento por código com 👤 Profissional uma única vez', async () => {
    setupEstabelecimento({ area: 'barbearia', cartaoMode: 'runtime' });
    const sp = await systemPromptFor('clone_estab_runtime');
    // Header estrutural presente = bloco RUNTIME (o baked buildCartaoEstabelecimentoBlock não tem HEADER).
    expect(sp).toContain(BLOCO_ESTRUTURAL_MARKER);
    expect(count(sp, '👤 Profissional:')).toBe(1);
    expect(count(sp, '[CARTAO DE CONFIRMACAO - ESTABELECIMENTO')).toBe(1);
    expect(sp).toMatch(/SÓ DEPOIS do SIM, chamar a ferramenta inserir_agendamento/);
  });

  it('baked (default) NÃO usa o bloco runtime (sem HEADER estrutural), cartão do #325 INTACTO (baked NUNCA muda)', async () => {
    setupEstabelecimento({ area: 'barbearia', cartaoMode: 'baked' });
    const sp = await systemPromptFor('clone_estab_baked');
    expect(sp).not.toContain(BLOCO_ESTRUTURAL_MARKER);
    // Cartão de estabelecimento baked (#325, buildCartaoEmojiOverrideBlock) é OUTRO módulo —
    // não tocado por esta PR. Segue com o rótulo velho (CAIXA ALTA), 1 vez, com 👤.
    expect(count(sp, '[CARTAO DE CONFIRMACAO - ESTABELECIMENTO')).toBe(1);
    expect(count(sp, '👤 PROFISSIONAL:')).toBe(1);
  });
});
