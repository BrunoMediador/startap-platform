/**
 * Testes do job bot-detect (SCRUM-4 PR-C, Fase 1: heurística + alerta-only).
 *
 * `@startap/db` (botDetect/antibot/flowClones/alerts), `@startap/integrations` (waha) e
 * `@startap/core/logger` são MOCKADOS — sem banco, sem rede. `@startap/core/phone` é REAL (puro:
 * mascaramento/canônico de verdade). `../config.js` é injetado por teste (loadJob).
 *
 * Cobre:
 *  - heurística pura: timing (flood/jitter/insuficiente) + conteúdo (repetido/marketing/limpo) +
 *    regra dura (2 eixos = bot; 1 eixo = humano);
 *  - allowlist ENCERRA (já agendou / número interno) -> human, sem rodar sinais nem alertar;
 *  - ≥ 2 sinais ortogonais = bot -> alerta o dono 1× (telefone mascarado, NÃO pausa);
 *  - < 2 sinais = human;
 *  - cooldown: teto de alertas por ciclo (1× / cap), o excedente é ADIADO (não cacheado);
 *  - cache: sem candidatos (NOT EXISTS) -> NO-OP;
 *  - FLAGS OFF (BOT_DETECT_ENABLED=false OU sem slots) -> job NEM roda (zero query) byte-a-byte;
 *  - validação da heurística de conteúdo contra docs/bot-detect/eval-cases.jsonl (FP humano = 0).
 */
import { readFileSync } from 'node:fs';
import { phoneHint } from '@startap/core/phone';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks dos módulos externos ao job ───────────────────────────────────────────
const getCloneInfo = vi.fn();
const listUnclassifiedCandidates = vi.fn();
const getMessageTimestamps = vi.fn();
const getHumanMessages = vi.fn();
const upsertClassification = vi.fn();
const markAlerted = vi.fn();
const hasScheduledHistory = vi.fn();
const getCloneDisconnectAlertTarget = vi.fn();
const getConfig = vi.fn();
const getSenderSession = vi.fn();
const sendText = vi.fn();
// Classificador LLM da zona-cinza (PR-D): mockado pra testar SÓ o WIRING (a lógica do LLM tem
// teste próprio em bot-detect-llm.test.ts). isGrayZone é REAL (vive em bot-detect.ts).
const classifyGrayZone = vi.fn();

vi.mock('@startap/db', () => ({
  botDetect: {
    getCloneInfo,
    listUnclassifiedCandidates,
    getMessageTimestamps,
    getHumanMessages,
    upsertClassification,
    markAlerted,
  },
  antibot: { hasScheduledHistory },
  flowClones: { getCloneDisconnectAlertTarget },
  alerts: { getConfig, getSenderSession },
}));
vi.mock('@startap/integrations', () => ({ waha: { sendText } }));
vi.mock('./bot-detect-llm.js', () => ({ classifyGrayZone }));
vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const DEFAULT_CONFIG = {
  BOT_DETECT_ENABLED: true,
  BOT_DETECT_SLOTS: 'clone_x',
  BOT_DETECT_MAX_PER_RUN: 50,
  BOT_DETECT_MAX_ALERTS_PER_RUN: 3,
  BOT_DETECT_CONTENT_LIMIT: 20,
  BOT_DETECT_TYPING_DELAY_MS: 0,
  BOT_DETECT_SEND_TIMEOUT_MS: 8000,
};

async function loadJob(overrides: Record<string, unknown> = {}) {
  vi.resetModules();
  vi.doMock('../config.js', () => ({ config: { ...DEFAULT_CONFIG, ...overrides } }));
  return import('./bot-detect.js');
}

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// Timestamps espaçados regularmente (lowJitter) — 6 msgs a 30s => 5 intervalos, CV ~0.
function regularTimestamps(): Date[] {
  return [0, 30_000, 60_000, 90_000, 120_000, 150_000].map((ms) => new Date(ms));
}
// Conteúdo de bot: repetido + marketing (negrito + link + CTA).
const BOT_CONTENT = ['*PROMO* clique aqui http://x.com', '*PROMO* clique aqui http://x.com'];

function aliveTarget(over: Record<string, unknown> = {}) {
  return { phone: '5511988887777', enabled: true, nomeNegocio: 'Barbearia X', ...over };
}

// ─────────────────────────────────────────────────────────────────────────────
// Heurística pura — TIMING
// ─────────────────────────────────────────────────────────────────────────────
describe('computeTimingSignals', () => {
  it('flood: 6 msgs em < 60s dispara flood', async () => {
    const { computeTimingSignals } = await loadJob();
    const ts = [0, 5_000, 10_000, 15_000, 20_000, 25_000]; // 6 msgs em 25s
    const r = computeTimingSignals(ts);
    expect(r.flood).toBe(true);
    expect(r.fired).toBe(true);
  });

  it('lowJitter: cadência quase constante (CV < 0.15) com >= 5 intervalos dispara', async () => {
    const { computeTimingSignals } = await loadJob();
    const r = computeTimingSignals([0, 30_000, 60_000, 90_000, 120_000, 150_000]);
    expect(r.lowJitter).toBe(true);
    expect(r.intervals).toBe(5);
    expect(r.fired).toBe(true);
  });

  it('cadência IRREGULAR (humano) não dispara lowJitter', async () => {
    const { computeTimingSignals } = await loadJob();
    // intervalos bem variados (3s, 47s, 8s, 120s, 19s) -> CV alto.
    const r = computeTimingSignals([0, 3_000, 50_000, 58_000, 178_000, 197_000]);
    expect(r.lowJitter).toBe(false);
    expect(r.flood).toBe(false);
    expect(r.fired).toBe(false);
  });

  it('poucas mensagens (< 6) não dão sinal de timing', async () => {
    const { computeTimingSignals } = await loadJob();
    const r = computeTimingSignals([0, 30_000, 60_000]);
    expect(r.fired).toBe(false);
    expect(r.cv).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Heurística pura — CONTEÚDO
// ─────────────────────────────────────────────────────────────────────────────
describe('computeContentSignals', () => {
  it('texto repetido verbatim (>= 2x) dispara repeated', async () => {
    const { computeContentSignals } = await loadJob();
    const r = computeContentSignals([
      'Recebido. Em que posso ajudar?',
      'Recebido. Em que posso ajudar?',
    ]);
    expect(r.repeated).toBe(true);
    expect(r.fired).toBe(true);
  });

  it('formatação de marketing (>= 2 marcadores) dispara marketing', async () => {
    const { computeContentSignals } = await loadJob();
    const r = computeContentSignals(['🎁 GANHE R$50! CLIQUE AQUI: bonus.exemplo/agora']);
    expect(r.marketing).toBe(true);
    expect(r.marketingMaxHits).toBeGreaterThanOrEqual(2);
    expect(r.fired).toBe(true);
  });

  it('mensagem humana curta/informal NÃO dispara conteúdo (falso-positivo ~0)', async () => {
    const { computeContentSignals } = await loadJob();
    for (const msg of ['oi tem horario amanha?', 'Fexo kk', 'pode ser 16h', '[áudio recebido]']) {
      const r = computeContentSignals([msg]);
      expect(r.fired).toBe(false);
    }
  });

  it('UM marcador isolado (1 link) NÃO basta', async () => {
    const { computeContentSignals } = await loadJob();
    const r = computeContentSignals(['o endereço é rua tal, perto do mercado.com']);
    expect(r.marketing).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regra dura — 2 eixos ortogonais
// ─────────────────────────────────────────────────────────────────────────────
describe('classifyHeuristic (regra dura)', () => {
  it('timing + conteúdo (2 eixos) = bot', async () => {
    const { classifyHeuristic, computeTimingSignals, computeContentSignals } = await loadJob();
    const timing = computeTimingSignals([0, 30_000, 60_000, 90_000, 120_000, 150_000]);
    const content = computeContentSignals(BOT_CONTENT);
    const v = classifyHeuristic(timing, content);
    expect(v.verdict).toBe('bot');
    expect(v.signals.axes).toBe(2);
  });

  it('só conteúdo (1 eixo) = human (default seguro)', async () => {
    const { classifyHeuristic, computeTimingSignals, computeContentSignals } = await loadJob();
    const timing = computeTimingSignals([0, 30_000]); // insuficiente
    const content = computeContentSignals(BOT_CONTENT);
    expect(classifyHeuristic(timing, content).verdict).toBe('human');
  });

  it('só timing (1 eixo) = human', async () => {
    const { classifyHeuristic, computeTimingSignals, computeContentSignals } = await loadJob();
    const timing = computeTimingSignals([0, 30_000, 60_000, 90_000, 120_000, 150_000]);
    const content = computeContentSignals(['oi tudo bem? queria marcar um horario']);
    expect(classifyHeuristic(timing, content).verdict).toBe('human');
  });

  it('nenhum eixo = human', async () => {
    const { classifyHeuristic, computeTimingSignals, computeContentSignals } = await loadJob();
    expect(classifyHeuristic(computeTimingSignals([]), computeContentSignals([])).verdict).toBe(
      'human',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Allowlist
// ─────────────────────────────────────────────────────────────────────────────
describe('isInternalNumber', () => {
  it('reconhece o número interno default (sessão ALERTAS) e ignora número de cliente', async () => {
    const { isInternalNumber } = await loadJob();
    expect(isInternalNumber('553598373138')).toBe(true);
    expect(isInternalNumber('5511999990002')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orquestração — runBotDetect
// ─────────────────────────────────────────────────────────────────────────────
describe('runBotDetect — gates OFF (byte-a-byte)', () => {
  it('BOT_DETECT_ENABLED=false: job NEM roda (zero query)', async () => {
    const { runBotDetect } = await loadJob({ BOT_DETECT_ENABLED: false });
    const r = await runBotDetect();
    expect(r.skipped).toBe(true);
    expect(getCloneInfo).not.toHaveBeenCalled();
    expect(listUnclassifiedCandidates).not.toHaveBeenCalled();
    expect(upsertClassification).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('sem slots (BOT_DETECT_SLOTS=""): job NEM roda (zero query)', async () => {
    const { runBotDetect } = await loadJob({ BOT_DETECT_ENABLED: true, BOT_DETECT_SLOTS: '' });
    const r = await runBotDetect();
    expect(r.skipped).toBe(true);
    expect(getCloneInfo).not.toHaveBeenCalled();
  });

  it('só varre os slots LISTADOS (pagante fora da lista nunca é tocado)', async () => {
    getCloneInfo.mockResolvedValue(null); // qualquer slot resolvido -> sem sessão, pula
    const { runBotDetect } = await loadJob({ BOT_DETECT_SLOTS: 'clone_dragon' });
    await runBotDetect();
    expect(getCloneInfo).toHaveBeenCalledTimes(1);
    expect(getCloneInfo).toHaveBeenCalledWith('clone_dragon');
  });
});

describe('runBotDetect — allowlist ENCERRA', () => {
  it('número interno -> human (allowlist), sem rodar sinais nem alertar', async () => {
    getCloneInfo.mockResolvedValue({
      slot: 'clone_x',
      waha_sessao: 'SESS',
      chat_table: 'chat_histories',
    });
    listUnclassifiedCandidates.mockResolvedValue([{ telefone: '553598373138', total: 9 }]);
    const { runBotDetect } = await loadJob();
    const r = await runBotDetect();
    expect(r.allowlisted).toBe(1);
    expect(upsertClassification).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'human', source: 'allowlist' }),
    );
    expect(hasScheduledHistory).not.toHaveBeenCalled(); // interno encerra antes
    expect(getMessageTimestamps).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('já agendou no clone -> human (allowlist), sem rodar sinais nem alertar', async () => {
    getCloneInfo.mockResolvedValue({
      slot: 'clone_x',
      waha_sessao: 'SESS',
      chat_table: 'chat_histories',
    });
    listUnclassifiedCandidates.mockResolvedValue([{ telefone: '5511999990001', total: 12 }]);
    hasScheduledHistory.mockResolvedValue(true);
    const { runBotDetect } = await loadJob();
    const r = await runBotDetect();
    expect(r.allowlisted).toBe(1);
    expect(upsertClassification).toHaveBeenCalledWith(
      expect.objectContaining({
        verdict: 'human',
        source: 'allowlist',
        signals: { allowlist: 'scheduled' },
      }),
    );
    expect(getMessageTimestamps).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });
});

describe('runBotDetect — veredito + alerta', () => {
  function wireBotCandidate(phones: string[]) {
    getCloneInfo.mockResolvedValue({
      slot: 'clone_x',
      waha_sessao: 'SESS',
      chat_table: 'chat_histories',
    });
    listUnclassifiedCandidates.mockResolvedValue(phones.map((p) => ({ telefone: p, total: 8 })));
    hasScheduledHistory.mockResolvedValue(false);
    getMessageTimestamps.mockResolvedValue(regularTimestamps());
    getHumanMessages.mockResolvedValue(BOT_CONTENT);
    getCloneDisconnectAlertTarget.mockResolvedValue(aliveTarget());
    getConfig.mockResolvedValue({ sender_slot: 'startap' });
    getSenderSession.mockResolvedValue('ALERTAS_SESSION');
    sendText.mockResolvedValue(undefined);
    markAlerted.mockResolvedValue(true);
  }

  it('>= 2 sinais ortogonais = bot -> alerta o dono 1× (telefone MASCARADO, NÃO pausa)', async () => {
    wireBotCandidate(['5511999990002']);
    const { runBotDetect } = await loadJob();
    const r = await runBotDetect();

    expect(r.bots).toBe(1);
    expect(r.alerts).toBe(1);
    expect(upsertClassification).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'bot', source: 'heuristic' }),
    );
    expect(markAlerted).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);

    const arg = sendText.mock.calls[0][0];
    expect(arg.chatId).toBe('5511988887777@c.us');
    // telefone do suspeito mascarado na copy, número cru NUNCA aparece.
    expect(arg.texto).toContain(phoneHint('5511999990002'));
    expect(arg.texto).not.toContain('5511999990002');
    // Fase 1 não pausa: nenhuma chamada de pausa existe neste módulo (não há addFlowPause).
  });

  it('< 2 sinais (só conteúdo, timing insuficiente) = human -> sem alerta', async () => {
    getCloneInfo.mockResolvedValue({
      slot: 'clone_x',
      waha_sessao: 'SESS',
      chat_table: 'chat_histories',
    });
    listUnclassifiedCandidates.mockResolvedValue([{ telefone: '5511999990003', total: 2 }]);
    hasScheduledHistory.mockResolvedValue(false);
    getMessageTimestamps.mockResolvedValue([new Date(0), new Date(30_000)]); // insuficiente
    getHumanMessages.mockResolvedValue(BOT_CONTENT); // conteúdo dispara, mas timing não
    const { runBotDetect } = await loadJob();
    const r = await runBotDetect();
    expect(r.humans).toBe(1);
    expect(r.bots).toBe(0);
    expect(upsertClassification).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'human', source: 'heuristic' }),
    );
    expect(sendText).not.toHaveBeenCalled();
  });

  it('cache: sem candidatos novos (NOT EXISTS) -> NO-OP (não reclassifica)', async () => {
    getCloneInfo.mockResolvedValue({
      slot: 'clone_x',
      waha_sessao: 'SESS',
      chat_table: 'chat_histories',
    });
    listUnclassifiedCandidates.mockResolvedValue([]);
    const { runBotDetect } = await loadJob();
    const r = await runBotDetect();
    expect(r.classified).toBe(0);
    expect(getMessageTimestamps).not.toHaveBeenCalled();
    expect(upsertClassification).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('cooldown: teto de alertas por ciclo = 1 -> alerta 1×, 2º bot ADIADO (não cacheado)', async () => {
    wireBotCandidate(['5511999990010', '5511999990011']);
    const { runBotDetect } = await loadJob({ BOT_DETECT_MAX_ALERTS_PER_RUN: 1 });
    const r = await runBotDetect();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(r.alerts).toBe(1);
    expect(r.deferred).toBe(1);
    // só o 1º bot é cacheado; o adiado NÃO grava veredito (retry no próximo ciclo).
    expect(upsertClassification).toHaveBeenCalledTimes(1);
    expect(markAlerted).toHaveBeenCalledTimes(1);
  });

  it('opt-out (alert_owner_enabled=false): bot é CACHEADO mas NÃO alerta', async () => {
    wireBotCandidate(['5511999990020']);
    getCloneDisconnectAlertTarget.mockResolvedValue(aliveTarget({ enabled: false }));
    const { runBotDetect } = await loadJob();
    const r = await runBotDetect();
    expect(r.bots).toBe(1);
    expect(r.alerts).toBe(0);
    expect(upsertClassification).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'bot' }));
    expect(sendText).not.toHaveBeenCalled();
    expect(markAlerted).not.toHaveBeenCalled();
  });

  it('falha de envio (WAHA): bot NÃO é cacheado (retry no próximo ciclo)', async () => {
    wireBotCandidate(['5511999990030']);
    sendText.mockRejectedValue(new Error('waha down'));
    const { runBotDetect } = await loadJob();
    const r = await runBotDetect();
    expect(r.alertFailed).toBe(1);
    expect(r.bots).toBe(0);
    expect(upsertClassification).not.toHaveBeenCalled(); // não cacheia -> reavalia depois
    expect(markAlerted).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ZONA-CINZA — wiring do classificador LLM (SCRUM-4 PR-D), gated por BOT_DETECT_LLM
// ─────────────────────────────────────────────────────────────────────────────
describe('runBotDetect — zona-cinza (LLM gated)', () => {
  // 1 eixo só (conteúdo dispara; timing insuficiente) = ZONA-CINZA (ambíguo).
  function wireGrayCandidate(phones: string[], content: string[] = BOT_CONTENT) {
    getCloneInfo.mockResolvedValue({
      slot: 'clone_x',
      waha_sessao: 'SESS',
      chat_table: 'chat_histories',
    });
    listUnclassifiedCandidates.mockResolvedValue(phones.map((p) => ({ telefone: p, total: 4 })));
    hasScheduledHistory.mockResolvedValue(false);
    getMessageTimestamps.mockResolvedValue([new Date(0), new Date(30_000)]); // timing NÃO dispara
    getHumanMessages.mockResolvedValue(content); // conteúdo dispara -> 1 eixo
  }
  function wireAlertTarget() {
    getCloneDisconnectAlertTarget.mockResolvedValue(aliveTarget());
    getConfig.mockResolvedValue({ sender_slot: 'startap' });
    getSenderSession.mockResolvedValue('ALERTAS_SESSION');
    sendText.mockResolvedValue(undefined);
    markAlerted.mockResolvedValue(true);
  }

  it('flag ON + zona-cinza: chama o LLM; bot (conf>=0.85) -> alerta + cache source=llm', async () => {
    wireGrayCandidate(['5511999990050']);
    wireAlertTarget();
    classifyGrayZone.mockResolvedValue({
      verdict: 'bot',
      confidence: 0.9,
      signals: { llm: { model: 'gpt-4o-mini', is_bot: true, confidence: 0.9 } },
    });

    const { runBotDetect } = await loadJob({ BOT_DETECT_LLM: true });
    const r = await runBotDetect();

    expect(classifyGrayZone).toHaveBeenCalledTimes(1);
    // entrada ancorada por slot (chatTable + slot + telefone).
    expect(classifyGrayZone).toHaveBeenCalledWith({
      slot: 'clone_x',
      telefone: '5511999990050',
      chatTable: 'chat_histories',
    });
    expect(r.bots).toBe(1);
    expect(r.alerts).toBe(1);
    expect(upsertClassification).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'bot', source: 'llm' }),
    );
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('flag OFF (ausente): zona-cinza NÃO chama LLM (cai no comportamento atual = human)', async () => {
    wireGrayCandidate(['5511999990051']);
    const { runBotDetect } = await loadJob(); // BOT_DETECT_LLM ausente => OFF
    const r = await runBotDetect();
    expect(classifyGrayZone).not.toHaveBeenCalled();
    expect(r.humans).toBe(1);
    expect(r.bots).toBe(0);
    expect(upsertClassification).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'human', source: 'heuristic' }),
    );
    expect(sendText).not.toHaveBeenCalled();
  });

  it('flag ON + LLM confidence<0.85 -> human (source=llm), sem alerta', async () => {
    wireGrayCandidate(['5511999990052']);
    classifyGrayZone.mockResolvedValue({
      verdict: 'human',
      confidence: 0.6,
      signals: { llm: { is_bot: true, confidence: 0.6, parseOk: true } },
    });
    const { runBotDetect } = await loadJob({ BOT_DETECT_LLM: true });
    const r = await runBotDetect();
    expect(classifyGrayZone).toHaveBeenCalledTimes(1);
    expect(r.humans).toBe(1);
    expect(r.bots).toBe(0);
    expect(upsertClassification).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'human', source: 'llm' }),
    );
    expect(sendText).not.toHaveBeenCalled();
  });

  it('flag ON + LLM indisponível (null): mantém heurística (human, source=heuristic)', async () => {
    wireGrayCandidate(['5511999990053']);
    classifyGrayZone.mockResolvedValue(null);
    const { runBotDetect } = await loadJob({ BOT_DETECT_LLM: true });
    const r = await runBotDetect();
    expect(classifyGrayZone).toHaveBeenCalledTimes(1);
    expect(r.humans).toBe(1);
    expect(upsertClassification).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'human', source: 'heuristic' }),
    );
    expect(sendText).not.toHaveBeenCalled();
  });

  it('fora da zona-cinza (2 eixos = bot heurístico): NÃO chama LLM mesmo com flag ON', async () => {
    getCloneInfo.mockResolvedValue({
      slot: 'clone_x',
      waha_sessao: 'SESS',
      chat_table: 'chat_histories',
    });
    listUnclassifiedCandidates.mockResolvedValue([{ telefone: '5511999990054', total: 8 }]);
    hasScheduledHistory.mockResolvedValue(false);
    getMessageTimestamps.mockResolvedValue(regularTimestamps()); // timing dispara
    getHumanMessages.mockResolvedValue(BOT_CONTENT); // conteúdo dispara -> 2 eixos
    wireAlertTarget();
    const { runBotDetect } = await loadJob({ BOT_DETECT_LLM: true });
    const r = await runBotDetect();
    expect(classifyGrayZone).not.toHaveBeenCalled();
    expect(r.bots).toBe(1);
    expect(upsertClassification).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'bot', source: 'heuristic' }),
    );
  });

  it('fora da zona-cinza (0 eixos = humano claro): NÃO chama LLM', async () => {
    getCloneInfo.mockResolvedValue({
      slot: 'clone_x',
      waha_sessao: 'SESS',
      chat_table: 'chat_histories',
    });
    listUnclassifiedCandidates.mockResolvedValue([{ telefone: '5511999990055', total: 3 }]);
    hasScheduledHistory.mockResolvedValue(false);
    getMessageTimestamps.mockResolvedValue([new Date(0), new Date(30_000)]); // timing insuficiente
    getHumanMessages.mockResolvedValue(['oi tem horario amanha?']); // humano, sem sinal
    const { runBotDetect } = await loadJob({ BOT_DETECT_LLM: true });
    const r = await runBotDetect();
    expect(classifyGrayZone).not.toHaveBeenCalled();
    expect(r.humans).toBe(1);
    expect(upsertClassification).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'human', source: 'heuristic' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Validação da heurística de CONTEÚDO contra os fixtures de eval (SCRUM-4 PR-B)
// ─────────────────────────────────────────────────────────────────────────────
describe('computeContentSignals × eval-cases.jsonl', () => {
  interface EvalCase {
    id: string;
    label: 'human' | 'bot';
    messages: string[];
  }
  const raw = readFileSync(
    new URL('../../../../docs/bot-detect/eval-cases.jsonl', import.meta.url),
    'utf8',
  );
  const cases: EvalCase[] = raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as EvalCase);

  it('NENHUM caso HUMANO dispara o eixo de conteúdo (falso-positivo = 0)', async () => {
    const { computeContentSignals } = await loadJob();
    const fp = cases
      .filter((c) => c.label === 'human')
      .filter((c) => computeContentSignals(c.messages).fired)
      .map((c) => c.id);
    expect(fp).toEqual([]);
  });

  it('casos de marketing/blast óbvios disparam o eixo de conteúdo (poder >= 10)', async () => {
    const { computeContentSignals } = await loadJob();
    const fired = cases
      .filter((c) => c.label === 'bot')
      .filter((c) => computeContentSignals(c.messages).fired)
      .map((c) => c.id);
    expect(fired.length).toBeGreaterThanOrEqual(10);
    // alguns marcos esperados (links/CTA/negrito/repetição verbatim):
    for (const id of ['b01', 'b02', 'b04', 'b05', 'b11']) expect(fired).toContain(id);
  });
});
