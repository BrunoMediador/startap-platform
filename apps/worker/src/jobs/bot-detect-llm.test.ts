/**
 * Testes do classificador LLM da ZONA-CINZA (SCRUM-4 PR-D).
 *
 * `@startap/integrations` (openai.runAgent) e `@startap/db` (botDetect.getHumanMessages,
 * modelUsage.logUsage) são MOCKADOS — sem rede, sem banco, sem chamar API de verdade.
 * `@startap/core/phone` é REAL (phoneHint puro). `../config.js` é injetado por teste.
 *
 * Cobre:
 *  - parseLlmOutput: JSON válido / com cercas markdown / malformado / fora do schema;
 *  - buildUserMessage: numerado, cronológico, trunca msg longa;
 *  - threshold 0.85: is_bot && conf>=0.85 => bot; conf<0.85 OU is_bot=false => human;
 *  - parse-fail => human (default seguro), parseOk=false nos sinais;
 *  - ISOLAMENTO: getHumanMessages chamado com (chatTable, SLOT, telefone, N);
 *  - sem mensagens => null, LLM NUNCA chamado;
 *  - erro/timeout do LLM => null (mantém heurística);
 *  - custo: logUsage chamado com slot+model+tokens, SEM telefone (PII); não loga se total=0;
 *  - alinhamento com os casos de zona-cinza de docs/bot-detect/eval-cases.jsonl (g01..g04).
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runAgent = vi.fn();
const getHumanMessages = vi.fn();
const logUsage = vi.fn();

vi.mock('@startap/integrations', () => ({ openai: { runAgent } }));
vi.mock('@startap/db', () => ({
  botDetect: { getHumanMessages },
  modelUsage: { logUsage },
}));
vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const DEFAULT_CONFIG = {
  BOT_DETECT_LLM_MODEL: 'gpt-4o-mini',
  BOT_DETECT_LLM_MAX_MSGS: 12,
  BOT_DETECT_LLM_TIMEOUT_MS: 30_000,
};

async function loadModule(overrides: Record<string, unknown> = {}) {
  vi.resetModules();
  vi.doMock('../config.js', () => ({ config: { ...DEFAULT_CONFIG, ...overrides } }));
  return import('./bot-detect-llm.js');
}

/** Resposta padrão do runAgent (usage não-zero pra exercitar o log de custo). */
function llmReply(json: unknown, usage = { prompt: 800, completion: 30, total: 830, cached: 0 }) {
  return { reply: JSON.stringify(json), toolCalls: [], usage };
}

beforeEach(() => {
  vi.resetAllMocks();
  logUsage.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// parseLlmOutput (puro)
// ─────────────────────────────────────────────────────────────────────────────
describe('parseLlmOutput', () => {
  it('JSON válido -> objeto parseado', async () => {
    const { parseLlmOutput } = await loadModule();
    expect(parseLlmOutput('{"is_bot":true,"confidence":0.9,"reason":"link de campanha"}')).toEqual({
      is_bot: true,
      confidence: 0.9,
      reason: 'link de campanha',
    });
  });

  it('tolera cercas markdown ao redor do JSON', async () => {
    const { parseLlmOutput } = await loadModule();
    const r = parseLlmOutput('```json\n{"is_bot":false,"confidence":0.4,"reason":"gíria"}\n```');
    expect(r?.is_bot).toBe(false);
  });

  it('texto não-JSON -> null', async () => {
    const { parseLlmOutput } = await loadModule();
    expect(parseLlmOutput('não sei dizer')).toBeNull();
    expect(parseLlmOutput('')).toBeNull();
  });

  it('JSON fora do schema (confidence > 1) -> null', async () => {
    const { parseLlmOutput } = await loadModule();
    expect(parseLlmOutput('{"is_bot":true,"confidence":3,"reason":"x"}')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildUserMessage (puro)
// ─────────────────────────────────────────────────────────────────────────────
describe('buildUserMessage', () => {
  it('numera as mensagens em ordem e fecha com "Classifique."', async () => {
    const { buildUserMessage } = await loadModule();
    const out = buildUserMessage(['oi', 'tem horario?']);
    expect(out).toContain('1. oi');
    expect(out).toContain('2. tem horario?');
    expect(out.trimEnd().endsWith('Classifique.')).toBe(true);
  });

  it('trunca mensagem muito longa', async () => {
    const { buildUserMessage } = await loadModule();
    const out = buildUserMessage(['x'.repeat(2000)]);
    expect(out).toContain('…');
    expect(out.length).toBeLessThan(1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyGrayZone — threshold + isolamento + custo
// ─────────────────────────────────────────────────────────────────────────────
describe('classifyGrayZone', () => {
  it('is_bot && confidence>=0.85 -> bot; lê via getHumanMessages(chatTable, SLOT, telefone, N)', async () => {
    getHumanMessages.mockResolvedValue(['Olá! Conheça nosso curso.', 'Responda SIM pra receber.']);
    runAgent.mockResolvedValue(llmReply({ is_bot: true, confidence: 0.9, reason: 'pitch B2B' }));
    const { classifyGrayZone } = await loadModule();

    const r = await classifyGrayZone({
      slot: 'clone_x',
      telefone: '5511999990002',
      chatTable: 'chat_histories',
    });

    expect(r?.verdict).toBe('bot');
    expect(r?.confidence).toBe(0.9);
    // ISOLAMENTO: ancorado por slot, com o limite N do config.
    expect(getHumanMessages).toHaveBeenCalledWith('chat_histories', 'clone_x', '5511999990002', 12);
    // temperatura 0 explícita + modelo do config no LLM.
    const callArg = runAgent.mock.calls[0][0];
    expect(callArg.temperature).toBe(0);
    expect(callArg.model).toBe('gpt-4o-mini');
  });

  it('confidence < 0.85 -> human (default seguro)', async () => {
    getHumanMessages.mockResolvedValue(['Olá, tudo bem?']);
    runAgent.mockResolvedValue(llmReply({ is_bot: true, confidence: 0.7, reason: 'ambíguo' }));
    const { classifyGrayZone } = await loadModule();
    const r = await classifyGrayZone({
      slot: 'clone_x',
      telefone: '5511999990003',
      chatTable: 'chat_histories',
    });
    expect(r?.verdict).toBe('human');
  });

  it('is_bot=false (alta confiança) -> human', async () => {
    getHumanMessages.mockResolvedValue(['oi tem vaga amanha?']);
    runAgent.mockResolvedValue(
      llmReply({ is_bot: false, confidence: 0.95, reason: 'agendamento' }),
    );
    const { classifyGrayZone } = await loadModule();
    const r = await classifyGrayZone({
      slot: 'clone_x',
      telefone: '5511999990004',
      chatTable: 'chat_histories',
    });
    expect(r?.verdict).toBe('human');
  });

  it('saída malformada -> human + parseOk=false nos sinais (nunca pausa por JSON ruim)', async () => {
    getHumanMessages.mockResolvedValue(['Olá, tudo bem?']);
    runAgent.mockResolvedValue({
      reply: 'desculpe, não sei',
      toolCalls: [],
      usage: { prompt: 700, completion: 10, total: 710, cached: 0 },
    });
    const { classifyGrayZone } = await loadModule();
    const r = await classifyGrayZone({
      slot: 'clone_x',
      telefone: '5511999990005',
      chatTable: 'chat_histories',
    });
    expect(r?.verdict).toBe('human');
    expect((r?.signals.llm as Record<string, unknown>).parseOk).toBe(false);
  });

  it('custo: logUsage chamado com slot+model+tokens e SEM telefone (PII)', async () => {
    getHumanMessages.mockResolvedValue(['Olá! Conheça nosso curso.']);
    runAgent.mockResolvedValue(
      llmReply(
        { is_bot: true, confidence: 0.9, reason: 'x' },
        { prompt: 800, completion: 30, total: 830, cached: 100 },
      ),
    );
    const { classifyGrayZone } = await loadModule();
    await classifyGrayZone({
      slot: 'clone_x',
      telefone: '5511999990006',
      chatTable: 'chat_histories',
    });

    expect(logUsage).toHaveBeenCalledTimes(1);
    const usageArg = logUsage.mock.calls[0][0];
    expect(usageArg).toMatchObject({
      slot: 'clone_x',
      model: 'gpt-4o-mini',
      provider: 'openai',
      prompt: 800,
      completion: 30,
      total: 830,
      cached: 100,
    });
    expect(usageArg.telefone).toBeUndefined(); // nunca grava telefone no custo
  });

  it('usage.total=0 -> NÃO loga custo', async () => {
    getHumanMessages.mockResolvedValue(['Olá']);
    runAgent.mockResolvedValue(
      llmReply(
        { is_bot: false, confidence: 0.5, reason: 'x' },
        { prompt: 0, completion: 0, total: 0, cached: 0 },
      ),
    );
    const { classifyGrayZone } = await loadModule();
    await classifyGrayZone({
      slot: 'clone_x',
      telefone: '5511999990007',
      chatTable: 'chat_histories',
    });
    expect(logUsage).not.toHaveBeenCalled();
  });

  it('sem mensagens -> null, LLM NUNCA é chamado (zero custo)', async () => {
    getHumanMessages.mockResolvedValue([]);
    const { classifyGrayZone } = await loadModule();
    const r = await classifyGrayZone({
      slot: 'clone_x',
      telefone: '5511999990008',
      chatTable: 'chat_histories',
    });
    expect(r).toBeNull();
    expect(runAgent).not.toHaveBeenCalled();
    expect(logUsage).not.toHaveBeenCalled();
  });

  it('LLM lança -> null (mantém heurística)', async () => {
    getHumanMessages.mockResolvedValue(['Olá, tudo bem?']);
    runAgent.mockRejectedValue(new Error('openai 500'));
    const { classifyGrayZone } = await loadModule();
    const r = await classifyGrayZone({
      slot: 'clone_x',
      telefone: '5511999990009',
      chatTable: 'chat_histories',
    });
    expect(r).toBeNull();
  });

  it('timeout duro -> null (nunca aguarda o provider infinito)', async () => {
    getHumanMessages.mockResolvedValue(['Olá, tudo bem?']);
    runAgent.mockReturnValue(new Promise(() => {})); // nunca resolve
    const { classifyGrayZone } = await loadModule({ BOT_DETECT_LLM_TIMEOUT_MS: 10 });
    const r = await classifyGrayZone({
      slot: 'clone_x',
      telefone: '5511999990010',
      chatTable: 'chat_histories',
    });
    expect(r).toBeNull();
  });

  it('lê DESC e envia ao LLM em ordem cronológica (antigo->recente)', async () => {
    // getHumanMessages retorna recente->antigo; o prompt tem que inverter.
    getHumanMessages.mockResolvedValue(['msg_recente', 'msg_antiga']);
    runAgent.mockResolvedValue(llmReply({ is_bot: false, confidence: 0.5, reason: 'x' }));
    const { classifyGrayZone } = await loadModule();
    await classifyGrayZone({
      slot: 'clone_x',
      telefone: '5511999990011',
      chatTable: 'chat_histories',
    });
    const userMsg: string = runAgent.mock.calls[0][0].userMessage;
    expect(userMsg.indexOf('msg_antiga')).toBeLessThan(userMsg.indexOf('msg_recente'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Alinhamento com os casos de ZONA-CINZA de eval-cases.jsonl (g01..g04)
// ─────────────────────────────────────────────────────────────────────────────
describe('classifyGrayZone × eval-cases.jsonl (zona-cinza g01..g04)', () => {
  interface EvalCase {
    id: string;
    label: 'human' | 'bot';
    messages: string[];
  }
  const raw = readFileSync(
    new URL('../../../../docs/bot-detect/eval-cases.jsonl', import.meta.url),
    'utf8',
  );
  const grayCases: EvalCase[] = raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as EvalCase)
    .filter((c) => c.id.startsWith('g'));

  it('mapeia cada caso de zona-cinza ao veredito rotulado (LLM mockado no limiar)', async () => {
    expect(grayCases.length).toBeGreaterThanOrEqual(4);
    for (const c of grayCases) {
      vi.resetAllMocks();
      logUsage.mockResolvedValue(undefined);
      getHumanMessages.mockResolvedValue([...c.messages].reverse()); // DESC como vem do banco
      // modelo "ideal" no limiar: bot => conf alta; humano => is_bot=false.
      runAgent.mockResolvedValue(
        llmReply(
          c.label === 'bot'
            ? { is_bot: true, confidence: 0.9, reason: 'campanha/pitch' }
            : { is_bot: false, confidence: 0.6, reason: 'cliente real' },
        ),
      );
      const { classifyGrayZone } = await loadModule();
      const r = await classifyGrayZone({
        slot: 'clone_x',
        telefone: '5511999990099',
        chatTable: 'chat_histories',
      });
      expect(r?.verdict, `caso ${c.id}`).toBe(c.label);
      // as mensagens do caso entram no prompt.
      const userMsg: string = runAgent.mock.calls[0][0].userMessage;
      expect(userMsg).toContain(c.messages[0]);
    }
  });
});
