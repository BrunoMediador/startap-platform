/**
 * Testes do job bot-detect-autopause (SCRUM-4 PR-E, Fase 2: escalação -> auto-pausa + TTL/reversão).
 *
 * `@startap/db` (botDetect/antibot/pausa) e `@startap/core/logger` são MOCKADOS — sem banco, sem
 * rede. `@startap/integrations` é mockado (o módulo bot-detect.js, importado pelas funções puras,
 * o referencia). `@startap/core/phone` é REAL (mascaramento de verdade). `../config.js` é injetado
 * por teste (loadJob). As funções PURAS da heurística (classifyHeuristic etc.) são REAIS.
 *
 * Cobre:
 *  - flags OFF (BOT_DETECT_AUTOPAUSE=false / sem slots) -> NO-OP byte-a-byte (zero query);
 *  - as 3 condições da escalação: TODAS verdadeiras -> AUTO-PAUSA; cada uma falsa -> NÃO pausa
 *    (allowlist/dono-agiu = cond. a; número parou = cond. b; não classifica mais bot = cond. c);
 *  - allowlistado NUNCA auto-pausa (rebaixa a human);
 *  - TTL expira -> despausa (removeFlowPause); auto-resume quando vira allowlist.
 */
import { phoneHint } from '@startap/core/phone';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks dos módulos externos ──────────────────────────────────────────────────
const getCloneInfo = vi.fn();
const listEscalationCandidates = vi.fn();
const markPaused = vi.fn();
const markHumanOverride = vi.fn();
const hasRecentMessages = vi.fn();
const getMessageTimestamps = vi.fn();
const getHumanMessages = vi.fn();
const hasScheduledHistory = vi.fn();
const isFlowPaused = vi.fn();
const addFlowPause = vi.fn();
const removeFlowPause = vi.fn();
const listActiveFlowPausesBySource = vi.fn();

vi.mock('@startap/db', () => ({
  botDetect: {
    getCloneInfo,
    listEscalationCandidates,
    markPaused,
    markHumanOverride,
    hasRecentMessages,
    getMessageTimestamps,
    getHumanMessages,
  },
  antibot: { hasScheduledHistory },
  pausa: { isFlowPaused, addFlowPause, removeFlowPause, listActiveFlowPausesBySource },
}));
// bot-detect.js (funções puras reais) referencia @startap/integrations — mock mínimo.
vi.mock('@startap/integrations', () => ({ waha: { sendText: vi.fn() } }));
vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const DEFAULT_CONFIG = {
  BOT_DETECT_AUTOPAUSE: true,
  BOT_DETECT_SLOTS: 'clone_x',
  BOT_DETECT_GRACE_HOURS: 24,
  BOT_DETECT_PAUSE_TTL_HOURS: 168,
  BOT_DETECT_ACTIVITY_WINDOW_HOURS: 12,
  BOT_DETECT_AUTOPAUSE_MAX_PER_RUN: 10,
  BOT_DETECT_CONTENT_LIMIT: 20,
};

async function loadJob(overrides: Record<string, unknown> = {}) {
  vi.resetModules();
  vi.doMock('../config.js', () => ({ config: { ...DEFAULT_CONFIG, ...overrides } }));
  return import('./bot-detect-autopause.js');
}

const SUSPECT = '5511999990123';
const CLONE = { slot: 'clone_x', waha_sessao: 'SESS', chat_table: 'chat_histories' };
// Timestamps regulares (lowJitter) — dispara o eixo timing.
const REGULAR_TS = [0, 30_000, 60_000, 90_000, 120_000, 150_000].map((ms) => new Date(ms));
// Conteúdo de bot (repetido + marketing) — dispara o eixo conteúdo.
const BOT_CONTENT = ['*PROMO* clique aqui http://x.com', '*PROMO* clique aqui http://x.com'];

/** Wire padrão pra a ESCALAÇÃO de UM bot real (todas as 3 condições verdadeiras). */
function wireEscalationBot() {
  getCloneInfo.mockResolvedValue(CLONE);
  listEscalationCandidates.mockResolvedValue([{ telefone: SUSPECT, alerted_at: new Date(0) }]);
  hasScheduledHistory.mockResolvedValue(false); // não allowlist
  isFlowPaused.mockResolvedValue(false); // dono não agiu
  hasRecentMessages.mockResolvedValue(true); // não parou
  getMessageTimestamps.mockResolvedValue(REGULAR_TS);
  getHumanMessages.mockResolvedValue(BOT_CONTENT); // ainda classifica bot
  addFlowPause.mockResolvedValue(undefined);
  markPaused.mockResolvedValue(true);
  markHumanOverride.mockResolvedValue(undefined);
  // TTL step: sem pausas ativas por default.
  listActiveFlowPausesBySource.mockResolvedValue([]);
}

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Gates OFF (byte-a-byte)
// ─────────────────────────────────────────────────────────────────────────────
describe('runBotDetectAutopause — gates OFF', () => {
  it('BOT_DETECT_AUTOPAUSE=false: NO-OP (zero query)', async () => {
    const { runBotDetectAutopause } = await loadJob({ BOT_DETECT_AUTOPAUSE: false });
    const r = await runBotDetectAutopause();
    expect(r.skipped).toBe(true);
    expect(getCloneInfo).not.toHaveBeenCalled();
    expect(listEscalationCandidates).not.toHaveBeenCalled();
    expect(addFlowPause).not.toHaveBeenCalled();
  });

  it('sem slots (BOT_DETECT_SLOTS=""): NO-OP (zero query)', async () => {
    const { runBotDetectAutopause } = await loadJob({ BOT_DETECT_SLOTS: '' });
    const r = await runBotDetectAutopause();
    expect(r.skipped).toBe(true);
    expect(getCloneInfo).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// As 3 condições da escalação
// ─────────────────────────────────────────────────────────────────────────────
describe('runBotDetectAutopause — escalação (3 condições)', () => {
  it('TODAS verdadeiras -> AUTO-PAUSA (addFlowPause source=bot_detected + paused_at)', async () => {
    wireEscalationBot();
    const { runBotDetectAutopause } = await loadJob();
    const r = await runBotDetectAutopause();
    expect(r.paused).toBe(1);
    expect(addFlowPause).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: 'clone_x', telefone: SUSPECT, source: 'bot_detected' }),
    );
    expect(markPaused).toHaveBeenCalledWith('clone_x', SUSPECT);
  });

  it('cond. (a) FALSA — número allowlistado (já agendou): NÃO pausa, rebaixa a human', async () => {
    wireEscalationBot();
    hasScheduledHistory.mockResolvedValue(true); // allowlist
    const { runBotDetectAutopause } = await loadJob();
    const r = await runBotDetectAutopause();
    expect(r.paused).toBe(0);
    expect(r.skippedAllowlist).toBe(1);
    expect(addFlowPause).not.toHaveBeenCalled();
    expect(markHumanOverride).toHaveBeenCalledWith(
      expect.objectContaining({ telefone: SUSPECT, source: 'allowlist' }),
    );
  });

  it('cond. (a) FALSA — dono JÁ pausou manualmente: NÃO pausa, carimba paused_at (concluído)', async () => {
    wireEscalationBot();
    isFlowPaused.mockResolvedValue(true); // dono agiu
    const { runBotDetectAutopause } = await loadJob();
    const r = await runBotDetectAutopause();
    expect(r.paused).toBe(0);
    expect(r.skippedOwnerActed).toBe(1);
    expect(addFlowPause).not.toHaveBeenCalled();
    expect(markPaused).toHaveBeenCalledWith('clone_x', SUSPECT);
  });

  it('cond. (b) FALSA — número PAROU (sem atividade recente): NÃO pausa', async () => {
    wireEscalationBot();
    hasRecentMessages.mockResolvedValue(false); // parou
    const { runBotDetectAutopause } = await loadJob();
    const r = await runBotDetectAutopause();
    expect(r.paused).toBe(0);
    expect(r.skippedStopped).toBe(1);
    expect(addFlowPause).not.toHaveBeenCalled();
  });

  it('cond. (c) FALSA — heurística não confirma mais bot: NÃO pausa, rebaixa a human', async () => {
    wireEscalationBot();
    // conteúdo humano + timing irregular -> classifyHeuristic = human.
    getMessageTimestamps.mockResolvedValue([new Date(0), new Date(3_000), new Date(50_000)]);
    getHumanMessages.mockResolvedValue(['oi, tem horario amanha?']);
    const { runBotDetectAutopause } = await loadJob();
    const r = await runBotDetectAutopause();
    expect(r.paused).toBe(0);
    expect(r.skippedReclassified).toBe(1);
    expect(addFlowPause).not.toHaveBeenCalled();
    expect(markHumanOverride).toHaveBeenCalledWith(
      expect.objectContaining({ telefone: SUSPECT, source: 'heuristic' }),
    );
  });

  it('número INTERNO (sessão ALERTAS) NUNCA auto-pausa', async () => {
    wireEscalationBot();
    listEscalationCandidates.mockResolvedValue([
      { telefone: '553598373138', alerted_at: new Date(0) },
    ]);
    const { runBotDetectAutopause } = await loadJob();
    const r = await runBotDetectAutopause();
    expect(r.paused).toBe(0);
    expect(r.skippedAllowlist).toBe(1);
    expect(hasScheduledHistory).not.toHaveBeenCalled(); // interno encerra antes
    expect(addFlowPause).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TTL / auto-resume (reversão)
// ─────────────────────────────────────────────────────────────────────────────
describe('runBotDetectAutopause — TTL / auto-resume', () => {
  it('TTL expirado -> despausa (removeFlowPause)', async () => {
    getCloneInfo.mockResolvedValue(CLONE);
    listEscalationCandidates.mockResolvedValue([]); // sem escalação
    const old = new Date(Date.now() - 200 * 3_600_000); // 200h atrás > TTL 168h
    listActiveFlowPausesBySource.mockResolvedValue([
      { telefone: SUSPECT, session: 'SESS', updated_at: old },
    ]);
    removeFlowPause.mockResolvedValue(undefined);
    const { runBotDetectAutopause } = await loadJob();
    const r = await runBotDetectAutopause();
    expect(r.ttlExpired).toBe(1);
    expect(removeFlowPause).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: 'clone_x', telefone: SUSPECT }),
    );
  });

  it('número vira allowlist (agendou) -> auto-resume (despausa + human)', async () => {
    getCloneInfo.mockResolvedValue(CLONE);
    listEscalationCandidates.mockResolvedValue([]);
    const recent = new Date(Date.now() - 1 * 3_600_000); // 1h atrás < TTL
    listActiveFlowPausesBySource.mockResolvedValue([
      { telefone: SUSPECT, session: 'SESS', updated_at: recent },
    ]);
    hasScheduledHistory.mockResolvedValue(true); // virou allowlist
    removeFlowPause.mockResolvedValue(undefined);
    markHumanOverride.mockResolvedValue(undefined);
    const { runBotDetectAutopause } = await loadJob();
    const r = await runBotDetectAutopause();
    expect(r.autoResumed).toBe(1);
    expect(r.ttlExpired).toBe(0);
    expect(removeFlowPause).toHaveBeenCalled();
    expect(markHumanOverride).toHaveBeenCalledWith(
      expect.objectContaining({ telefone: SUSPECT, source: 'allowlist' }),
    );
  });

  it('pausa recente e NÃO-allowlist permanece (nada acontece)', async () => {
    getCloneInfo.mockResolvedValue(CLONE);
    listEscalationCandidates.mockResolvedValue([]);
    const recent = new Date(Date.now() - 1 * 3_600_000);
    listActiveFlowPausesBySource.mockResolvedValue([
      { telefone: SUSPECT, session: 'SESS', updated_at: recent },
    ]);
    hasScheduledHistory.mockResolvedValue(false);
    const { runBotDetectAutopause } = await loadJob();
    const r = await runBotDetectAutopause();
    expect(r.ttlExpired).toBe(0);
    expect(r.autoResumed).toBe(0);
    expect(removeFlowPause).not.toHaveBeenCalled();
  });
});

describe('phoneHint (sanity — telefone mascarado nos logs)', () => {
  it('mascara o número', () => {
    expect(phoneHint(SUSPECT)).not.toContain('999990123');
  });
});
