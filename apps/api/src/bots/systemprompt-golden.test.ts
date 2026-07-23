/**
 * REDE DE SEGURANÇA BYTE-A-BYTE do systemPrompt — gate do SCRUM-92 increment 2 (ADR 0032, T1).
 *
 * OBJETIVO
 *   Congelar (golden fixture) o systemPrompt FINAL montado HOJE no caminho INDIVIDUAL de um
 *   clone de barbearia com cartão BAKED (cartao_mode='baked' — o default de todo clone, incl.
 *   Cirilo `clone_cirilobarbearia_c8w2f0` e Samuel `clone_barbearia_samuel_uefpqc`, ambos
 *   prompt_custom=false, área 'barbearia'). O teste FALHA se qualquer mudança futura alterar
 *   1 byte da montagem. É o gate que vai proteger a INJEÇÃO-EM-RUNTIME do cartão (increment 2):
 *   quando o código passar a montar o cartão em runtime, os clones 'baked' NÃO podem mudar —
 *   se a injeção vazar pro caminho baked, o systemPrompt capturado ganha bytes e este teste
 *   quebra ANTES de chegar a produção.
 *
 * O QUE ESTE GOLDEN CONGELA (e o que NÃO congela) — leitura honesta da fidelidade:
 *   - CONGELA a LÓGICA DE MONTAGEM real, exercitando o método `TesteBarbeariaBot.process()` de
 *     ponta a ponta e capturando o `systemPrompt` que o bot passa ao runAgent. É EXATAMENTE a
 *     linha que o increment 2 vai tocar (o `.join('\n\n')` de persona/contexto/pacote/cartão em
 *     apps/api/src/bots/teste_barbearia.ts). buildCartaoEmojiOverrideBlock roda REAL (não é
 *     mockado) — pra barbearia+baked ele devolve '' (nada injetado), e é aí que o cartão-runtime
 *     do increment 2 vai encostar. Se ele deixar de devolver '' no baked, o golden quebra.
 *   - NÃO congela o CONTEÚDO do bot_prompt/contexto REAIS de produção (persona + [CONTEXTO] com
 *     nome do negócio, preços, horários, telefone do cliente). Esses vivem no BANCO e:
 *       (a) exigiriam DB real + data/agenda determinísticas (não são estáveis num unit test); e
 *       (b) seriam DADO DE CLIENTE num repo versionado (LGPD/regra de ouro — não commitar PII/
 *           dado de negócio de cliente).
 *     Por isso usamos FIXTURES SINTÉTICAS e PII-FREE (persona de barbearia representativa com o
 *     cartão baked 💈/✂️ + um [CONTEXTO] representativo). Isso é o CORRETO pro escopo do gate:
 *     o increment 2 muda a MONTAGEM, não o conteúdo do banco. O golden trava a camada que muda.
 *
 *   GAP CONHECIDO (sinalizado ao PM): este é um golden da MONTAGEM com entradas sintéticas, não
 *   um snapshot do systemPrompt exato de produção. Um golden de produção-fiel exigiria DB +
 *   fixar `now`/agenda e commitaria dado de cliente — fora do escopo de um unit test estável.
 *
 * COMO REGENERAR DE PROPÓSITO (quando uma mudança na montagem for INTENCIONAL):
 *   UPDATE_GOLDEN=1 npx vitest run apps/api/src/bots/systemprompt-golden.test.ts
 *   Isso reescreve o(s) arquivo(s) .golden.txt com o output atual. REVISE o diff no PR — um diff
 *   inesperado aqui = alguém mudou o systemPrompt dos clones baked sem querer.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BotContext } from '@startap/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Fixtures SINTÉTICAS (PII-free) — representam um bot_prompt de barbearia BAKED + [CONTEXTO].
// NÃO são dados reais do Cirilo/Samuel; são entradas estáveis para congelar a MONTAGEM. O cartão
// baked (💈/✂️) vive DENTRO da persona (como em produção no caminho individual barbearia).
const PERSONA_FIXTURE = [
  'Você é o atendente virtual da Barbearia Exemplo. Fale de forma simpática e objetiva.',
  '',
  '[REGRAS CRITICAS]',
  '- Só agende depois do cliente confirmar com SIM.',
  '- Nunca invente horário: use [HORARIOS DISPONIVEIS].',
  '',
  '[CARTAO DE CONFIRMACAO]',
  'Antes de agendar, mostre este cartão e peça SIM:',
  '💈 Barbearia Exemplo',
  '📅 DIA: <dia>',
  '⏰ HORARIO: <horario>',
  '✂️ SERVICO: <servico>',
  '💰 VALOR: <valor>',
  '✅ Responda SIM para confirmar.',
].join('\n');

const CONTEXT_FIXTURE = [
  '[CONTEXTO - DADOS DO BANCO, NAO REMOVIVEL]',
  '',
  '[DATA ATUAL]',
  'segunda-feira, 1 de janeiro de 2035',
  'ANO: 2035 - use SEMPRE este ano ao calcular datas.',
  '',
  '[DADOS DO CLIENTE - JA IDENTIFICADO]',
  'NOME: Cliente Teste',
  'WHATSAPP: 5500000000000',
  '',
  '[FUNCIONAMENTO]',
  'Seg-Sex 09:00-19:00',
  '',
  '[SERVICOS E PRECOS]',
  'Corte: R$ 50',
].join('\n');

const SLOTS_BAKED_BARBEARIA = {
  cirilo: 'clone_cirilobarbearia_c8w2f0',
  samuel: 'clone_barbearia_samuel_uefpqc',
} as const;

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

// Flags TODAS no default de produção que preserva o caminho baked byte-a-byte.
const cfg = {
  CANCELAMENTO_ESCALADO_ENABLED: false,
  IDEMPOTENCY_ACTION_LOCK: false,
  ESTABELECIMENTO_ENABLED: false,
  PACOTES_ENABLED: false,
  ATEND_FROM_AGENDA_SLOTS: '',
  MODO_ATENDENTE_SLOTS: '',
  // Kill-switch da injeção em runtime (SCRUM-92 inc.2). Nesta PR ainda ninguém lê — mas já
  // deixamos explícito no golden que o baseline congelado é com a injeção DESLIGADA.
  CARTAO_RUNTIME_ENABLED: false,
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

// IMPORTANTE: buildCartaoEmojiOverrideBlock (../lib/area-emojis.js) NÃO é mockado — roda REAL.
// É a peça pura que o increment 2 vai encostar; pra barbearia+baked ela devolve '' (nada
// injetado). Se isso mudar, o golden quebra.
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

/** Prepara os mocks pro caminho INDIVIDUAL barbearia BAKED completar até o runAgent. */
function setupBakedIndividual(): void {
  const calClient = { listEvents: vi.fn().mockResolvedValue([]) };
  mocks.getGcalForSlot.mockResolvedValue(calClient);
  mocks.loadScheduleConfig.mockResolvedValue({
    source: 'flow_clones',
    services: [],
    timezone: 'America/Sao_Paulo',
  });
  mocks.formatarAgendaComConfig.mockReturnValue('AGENDA');
  // Persona e contexto = fixtures sintéticas estáveis (entradas do golden).
  mocks.renderPrompt.mockResolvedValue(PERSONA_FIXTURE);
  mocks.buildContextBlock.mockResolvedValue(CONTEXT_FIXTURE);
  mocks.runAgentConfigured.mockResolvedValue({ reply: 'ok' });
  mocks.loadHistory.mockResolvedValue([{ role: 'user', content: 'oi' }]);
  mocks.getProductType.mockResolvedValue('individual');
  mocks.getArea.mockResolvedValue('barbearia');
  // barbearia + persona NÃO-custom = exatamente Cirilo/Samuel (prompt_custom=false).
  mocks.getAreaAndPromptCustom.mockResolvedValue({ area: 'barbearia', promptCustom: false });
  // Reader unificado (SCRUM-92 inc.2) que o caminho individual passou a usar. cartao_mode='baked'
  // (default de TODO clone) + config null = estado de HOJE: nada injetado em runtime → o cartão
  // segue vindo do bot_prompt (baked). É o que congela o byte-a-byte do golden.
  mocks.getAreaPromptCustomCartao.mockResolvedValue({
    area: 'barbearia',
    promptCustom: false,
    cartaoMode: 'baked',
    cartaoConfig: null,
  });
  mocks.resolveClientPackages.mockResolvedValue([]);
  mocks.buildSeuPacoteBlock.mockReturnValue('');
}

/** Roda process() pro slot dado e devolve o systemPrompt que o bot passou ao runAgent. */
async function systemPromptFor(slot: string): Promise<string> {
  setupBakedIndividual();
  const bot = new TesteBarbeariaBot({ slotOverride: slot });
  await (bot as unknown as { process: (c: BotContext) => Promise<string | null> }).process(
    makeCtx('quero marcar um corte'),
  );
  const calls = mocks.runAgentConfigured.mock.calls;
  return calls[calls.length - 1][0].systemPrompt as string;
}

/** Lê (ou, com UPDATE_GOLDEN=1, regrava) o golden e asserta igualdade estrita byte-a-byte. */
function assertGolden(fixtureName: string, actual: string): void {
  const goldenPath = fileURLToPath(new URL(`./__fixtures__/${fixtureName}`, import.meta.url));
  if (process.env.UPDATE_GOLDEN === '1') {
    writeFileSync(goldenPath, actual, 'utf8');
  }
  const expected = readFileSync(goldenPath, 'utf8');
  expect(actual).toBe(expected);
}

describe('systemPrompt golden — clones BAKED de barbearia (SCRUM-92 inc.2, T1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cfg.CANCELAMENTO_ESCALADO_ENABLED = false;
    cfg.IDEMPOTENCY_ACTION_LOCK = false;
    cfg.ESTABELECIMENTO_ENABLED = false;
    cfg.PACOTES_ENABLED = false;
    cfg.ATEND_FROM_AGENDA_SLOTS = '';
    cfg.MODO_ATENDENTE_SLOTS = '';
    cfg.CARTAO_RUNTIME_ENABLED = false;
  });

  it('Cirilo (clone_cirilobarbearia_c8w2f0) → systemPrompt byte-a-byte o golden congelado', async () => {
    const sp = await systemPromptFor(SLOTS_BAKED_BARBEARIA.cirilo);
    assertGolden('systemprompt-baked-barbearia.golden.txt', sp);
  });

  it('Samuel (clone_barbearia_samuel_uefpqc) → MESMO systemPrompt (montagem é slot-invariante no baked)', async () => {
    const sp = await systemPromptFor(SLOTS_BAKED_BARBEARIA.samuel);
    // A montagem do caminho individual barbearia baked NÃO depende do slot (as diferenças
    // Cirilo×Samuel vivem só no DADO do banco, que aqui é fixture comum). Congelar isso é
    // valioso: prova que o increment 2 não pode injetar bloco slot-específico no baked.
    assertGolden('systemprompt-baked-barbearia.golden.txt', sp);
  });

  it('o golden NÃO contém nenhum bloco injetado em runtime (baked = só persona + contexto)', async () => {
    const sp = await systemPromptFor(SLOTS_BAKED_BARBEARIA.cirilo);
    // Guardas semânticas anti-regressão do increment 2: se a injeção em runtime vazar pro
    // caminho baked, um destes marcadores aparece e o teste quebra (defesa além do byte-a-byte).
    expect(sp).not.toContain('[CARTAO DE CONFIRMACAO - EMOJIS DESTE NEGOCIO]');
    expect(sp).not.toContain('[CARTAO DE CONFIRMACAO - ESTABELECIMENTO');
    expect(sp).not.toContain('[SEU PACOTE]');
    // A montagem é exatamente persona + '\n\n' + contexto (nada mais no baked barbearia).
    expect(sp).toBe(`${PERSONA_FIXTURE}\n\n${CONTEXT_FIXTURE}`);
  });

  it('buildCartaoEmojiOverrideBlock (peça pura que o inc.2 vai encostar) devolve "" no baked barbearia', async () => {
    // Congela a pré-condição do gate: no caminho individual+barbearia+não-custom nada é
    // injetado. É a função REAL (não mockada) que roda dentro do process() acima.
    const { buildCartaoEmojiOverrideBlock } = await import('../lib/area-emojis.js');
    expect(buildCartaoEmojiOverrideBlock('barbearia', false)).toBe('');
    expect(buildCartaoEmojiOverrideBlock('barbearia', true)).toBe('');
  });
});
