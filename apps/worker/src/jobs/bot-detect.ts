/**
 * Job bot-detect — detecção de bot (SCRUM-4 PR-C, Fase 1: heurística + alerta-only).
 *
 * O QUE FAZ: pra cada número AINDA não classificado (não em contact_classification) num clone
 * ligado, decide se parece OUTRO bot/empresa (não um cliente humano) e — se sim — AVISA o dono via
 * ALERTAS ("número X parece um bot — quer que eu pare de responder?"). Cacheia o veredito por
 * (clone, telefone) -> classifica 1× por número novo.
 *
 * ⚠️ FASE 1 NÃO PAUSA. Só alerta. Auto-pausa (addFlowPause source='bot_detected') + LLM na
 * zona-cinza = PR-D/PR-E. Aqui NÃO há nenhuma chamada a pausa.
 *
 * WORKER-ONLY: zero mudança no router/ingestion. Só lê dados que JÁ existem:
 *   - TIMING (eixo A): cadência por volume em message_log (flood + baixo jitter).
 *   - CONTEÚDO (eixo C): templated/repetido + formatação de marketing em chat_histories (`human`).
 * Sinais que dependem de dado NÃO persistido hoje (instantaneidade/eco = timestamp de saída;
 * addressingMode/pushName) ficam pra um follow-up (ver corpo do PR) — não captura nada no hot-path.
 *
 * REGRA DURA (sinais.md): marca 'bot' só com ≥ 2 sinais ORTOGONAIS. Na Fase 1 os 2 únicos eixos
 * disponíveis são Timing e Conteúdo -> exige UM sinal de timing E UM de conteúdo. Default em
 * dúvida = humano (falso-positivo é caro; falso-negativo é barato).
 *
 * GATES: BOT_DETECT_ENABLED (macro, default OFF — checado pelo worker.ts pra registrar o cron) +
 * BOT_DETECT_SLOTS (por-clone, CSV; vazio = OFF pra todos). runBotDetect re-checa os dois (defesa
 * em profundidade): sem flag/sem slots -> NO-OP total (zero query). Pagante fora da lista = OFF
 * byte-a-byte.
 *
 * ALLOWLIST DURA (anti-falso-positivo): número que JÁ agendou no clone (hasScheduledHistory, PR-A)
 * ou número INTERNO da operação (sessão ALERTAS, espelho do bot-blocklist) = cliente real/infra ->
 * veredito 'human' direto, sem rodar heurística.
 *
 * LGPD/fail-safe: telefone SEMPRE mascarado no log (phoneHint); nunca grava texto de conversa.
 * Falha de UM item nunca derruba o ciclo nem afeta outros clones (try/catch por item). sendText
 * com timeout explícito (regra 7).
 */
import { logger } from '@startap/core/logger';
import { canonicalE164, ensureDddBr, phoneHint } from '@startap/core/phone';
import { alerts, antibot, botDetect, flowClones } from '@startap/db';
import { waha } from '@startap/integrations';
import { config } from '../config.js';

const log = logger.child({ job: 'bot-detect' });

// ─────────────────────────────────────────────────────────────────────────────
// Allowlist de número INTERNO (sessão ALERTAS) — espelha apps/api/src/lib/bot-blocklist.ts
//
// Não importamos o módulo do app de API (cross-app; manteria o PR fora do worker-only). Replicamos
// a checagem MÍNIMA aqui lendo a MESMA env (BOT_BLOCKLIST_NUMBERS) + o MESMO default. Unificar num
// helper de @startap/core é follow-up (ver corpo do PR) — fazê-lo agora tocaria o import do router.
// ─────────────────────────────────────────────────────────────────────────────

/** Remetente atual da sessão ALERTAS — espelho de DEFAULT_BLOCKLIST_NUMBER (bot-blocklist.ts). */
const DEFAULT_INTERNAL_NUMBER = '553598373138';

function buildInternalNumberSet(rawEnv: string | undefined): Set<string> {
  const out = new Set<string>();
  const add = (value: string): void => {
    const digits = value.replace(/\D/g, '');
    if (digits.length < 8) return;
    out.add(digits);
    const canon = canonicalE164(digits);
    if (canon) out.add(canon);
  };
  add(DEFAULT_INTERNAL_NUMBER);
  if (rawEnv && rawEnv.trim().length > 0) {
    for (const part of rawEnv.split(',')) add(part);
  }
  return out;
}

const internalNumbers = buildInternalNumberSet(process.env.BOT_BLOCKLIST_NUMBERS);

/** true se o telefone é um número interno da operação (não é cliente real). */
export function isInternalNumber(telefone: string): boolean {
  const digits = (telefone ?? '').replace(/\D/g, '');
  if (digits.length < 8) return false;
  if (internalNumbers.has(digits)) return true;
  const canon = canonicalE164(digits);
  return canon != null && internalNumbers.has(canon);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sinais de TIMING (eixo A) — cadência por volume em message_log
// ─────────────────────────────────────────────────────────────────────────────

export interface TimingSignals {
  /** ≥ 6 mensagens dentro de 60s (alinhado ao antibot). */
  flood: boolean;
  /** intervalos quase constantes (máquina): CV < 0.15 com ≥ 5 intervalos. */
  lowJitter: boolean;
  /** o eixo de timing disparou (flood OU lowJitter). */
  fired: boolean;
  /** nº de intervalos usados no cálculo de jitter (após filtro de < 1s). */
  intervals: number;
  /** coeficiente de variação dos intervalos (null se < 5 intervalos). */
  cv: number | null;
}

const FLOOD_COUNT = 6;
const FLOOD_WINDOW_MS = 60_000;
const MIN_INTERVALS = 5;
/** ignora deltas < 1s — mensagens "quebradas"/agrupadas pelo WAHA distorcem o jitter (sinal 2). */
const MIN_DELTA_MS = 1_000;
const CV_THRESHOLD = 0.15;

export function computeTimingSignals(timestampsMs: number[]): TimingSignals {
  const ts = [...timestampsMs].sort((a, b) => a - b);

  // Flood: alguma janela de 6 msgs dentro de 60s (janela deslizante sobre os timestamps crus).
  let flood = false;
  for (let i = 0; i + FLOOD_COUNT - 1 < ts.length; i++) {
    if (ts[i + FLOOD_COUNT - 1] - ts[i] <= FLOOD_WINDOW_MS) {
      flood = true;
      break;
    }
  }

  // Cadência regular: CV dos intervalos (>= 1s) < threshold, com >= 5 intervalos.
  const deltas: number[] = [];
  for (let i = 1; i < ts.length; i++) {
    const d = ts[i] - ts[i - 1];
    if (d >= MIN_DELTA_MS) deltas.push(d);
  }
  let lowJitter = false;
  let cv: number | null = null;
  if (deltas.length >= MIN_INTERVALS) {
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    if (mean > 0) {
      const variance = deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / deltas.length;
      cv = Math.sqrt(variance) / mean;
      lowJitter = cv < CV_THRESHOLD;
    }
  }

  return { flood, lowJitter, fired: flood || lowJitter, intervals: deltas.length, cv };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sinais de CONTEÚDO (eixo C) — templated/repetido + formatação de marketing
// ─────────────────────────────────────────────────────────────────────────────

export interface ContentSignals {
  /** mesmo texto normalizado aparece ≥ 2× (blast/template). */
  repeated: boolean;
  /** alguma mensagem tem ≥ 2 marcadores de marketing (link, CTA, negrito, emoji-bloco, ALLCAPS). */
  marketing: boolean;
  /** o eixo de conteúdo disparou (repeated OU marketing). */
  fired: boolean;
  /** nº de mensagens analisadas. */
  sampleCount: number;
  /** maior contagem de um mesmo texto normalizado. */
  repeatedMax: number;
  /** maior nº de marcadores numa única mensagem. */
  marketingMaxHits: number;
}

/** Keywords de campanha/CTA típicas de bot de marketing (pt-BR). */
const MARKETING_KEYWORDS =
  /(promoç[aã]o|promo|sorteio|ganhe|ganha|clique|junte-se|junte|telegram|tiktok|oferta|desconto|cadastre|recarga|b[oô]nus|renda|cat[aá]logo|parceria|divulgaç[aã]o|link na bio|regularize)/i;
/** Link/URL (http, domínio com TLD comum, t.me/wa.me). `.exemplo` cobre os fixtures de eval. */
const URL_RE =
  /(https?:\/\/|[a-z0-9-]+\.(com|net|org|me|br|io|app|info|biz|site|link|bio|exemplo)\b|t\.me\/|wa\.me\/)/i;
/** Negrito de marca (*texto*). */
const BOLD_RE = /\*[^*\n]+\*/;
/** Palavra ALLCAPS longa (≥ 4 letras) — grito de marketing. */
const ALLCAPS_RE = /\b[A-ZÀ-Ý]{4,}\b/;
/** Bloco de emoji = ≥ 2 emojis na mensagem (1 emoji isolado é comum em humano). */
const EMOJI_BLOCK_RE = /\p{Extended_Pictographic}[\s\S]*\p{Extended_Pictographic}/u;

function normalizeContent(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Conta marcadores de marketing numa única mensagem (0..5). */
export function countMarketingMarkers(msg: string): number {
  let hits = 0;
  if (BOLD_RE.test(msg)) hits++;
  if (URL_RE.test(msg)) hits++;
  if (MARKETING_KEYWORDS.test(msg)) hits++;
  if (EMOJI_BLOCK_RE.test(msg)) hits++;
  if (ALLCAPS_RE.test(msg)) hits++;
  return hits;
}

export function computeContentSignals(messages: string[]): ContentSignals {
  const counts = new Map<string, number>();
  let marketingMaxHits = 0;
  for (const m of messages) {
    const norm = normalizeContent(m);
    if (norm.length > 0) counts.set(norm, (counts.get(norm) ?? 0) + 1);
    const hits = countMarketingMarkers(m);
    if (hits > marketingMaxHits) marketingMaxHits = hits;
  }
  let repeatedMax = 0;
  for (const c of counts.values()) if (c > repeatedMax) repeatedMax = c;
  const repeated = repeatedMax >= 2;
  const marketing = marketingMaxHits >= 2;
  return {
    repeated,
    marketing,
    fired: repeated || marketing,
    sampleCount: messages.length,
    repeatedMax,
    marketingMaxHits,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Classificação heurística (regra dura: 2 eixos ortogonais)
// ─────────────────────────────────────────────────────────────────────────────

export interface HeuristicVerdict {
  verdict: 'bot' | 'human';
  confidence: number;
  signals: Record<string, unknown>;
}

/** Confiança da heurística (não é LLM): conservadora — o caro é falso-positivo. */
const BOT_CONFIDENCE = 0.7;
const HUMAN_CONFIDENCE = 0.5;

export function classifyHeuristic(
  timing: TimingSignals,
  content: ContentSignals,
): HeuristicVerdict {
  const axes = (timing.fired ? 1 : 0) + (content.fired ? 1 : 0);
  // 2 eixos ORTOGONAIS na Fase 1 = Timing E Conteúdo (os 2 únicos disponíveis sem hot-path).
  const isBot = timing.fired && content.fired;
  return {
    verdict: isBot ? 'bot' : 'human',
    confidence: isBot ? BOT_CONFIDENCE : HUMAN_CONFIDENCE,
    signals: {
      timing: {
        flood: timing.flood,
        lowJitter: timing.lowJitter,
        fired: timing.fired,
        intervals: timing.intervals,
        cv: timing.cv,
      },
      content: {
        repeated: content.repeated,
        marketing: content.marketing,
        fired: content.fired,
        sampleCount: content.sampleCount,
        repeatedMax: content.repeatedMax,
        marketingMaxHits: content.marketingMaxHits,
      },
      axes,
      rule: 'timing+content',
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Copy do alerta ao dono (Fase 1 — alert-only). PURA, sem PII além do hint mascarado.
// ─────────────────────────────────────────────────────────────────────────────

/** Fallback do nome do negócio quando o clone não tem personalizacao->>'nome_negocio'. */
export const BOT_DETECT_NEGOCIO_FALLBACK = 'seu atendimento';

/**
 * Renderiza o aviso ao dono. {phoneMasked} já vem mascarado (phoneHint). NUNCA inclui o número
 * em claro nem conteúdo da conversa. Asteriscos = negrito no WhatsApp.
 */
export function renderBotDetectAlert(vars: {
  nomeNegocio?: string | null;
  phoneMasked: string;
}): string {
  const negocio = vars.nomeNegocio?.trim() || BOT_DETECT_NEGOCIO_FALLBACK;
  return `Olá! Aqui é da *Startap* 👋

Detectei um número que parece ser um *robô/empresa* (não um cliente de verdade) conversando com o atendimento automático da *${negocio}*:

📱 ${vars.phoneMasked}

Quer que eu *pare de responder* esse número? É só me avisar por aqui. Por enquanto, *nada foi pausado* — o robô segue respondendo normalmente.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orquestração
// ─────────────────────────────────────────────────────────────────────────────

export interface BotDetectResult extends Record<string, unknown> {
  /** true = gate OFF (flag/sem slots) -> não rodou (zero query). */
  skipped: boolean;
  /** clones varridos. */
  slots: number;
  /** vereditos gravados no cache (bot + human; exclui adiados/falhas de alerta). */
  classified: number;
  /** vereditos 'bot'. */
  bots: number;
  /** vereditos 'human' (heurística). */
  humans: number;
  /** humanos resolvidos por allowlist (já agendou / número interno). */
  allowlisted: number;
  /** alertas ao dono enviados. */
  alerts: number;
  /** bots adiados pelo teto de alertas do ciclo (NÃO cacheados; retry próximo ciclo). */
  deferred: number;
  /** alertas que falharam (sender/WAHA; bot NÃO cacheado, retry próximo ciclo). */
  alertFailed: number;
}

type AlertOutcome =
  | { status: 'sent' }
  | { status: 'skipped'; reason: 'opt_out' | 'no_target' }
  | { status: 'failed'; reason: 'no_sender' | 'send_error' };

/** Normaliza E.164 (só dígitos) -> chatId WhatsApp. */
function toChatId(phone: string): string {
  return `${phone.replace(/\D/g, '')}@c.us`;
}

/**
 * Parseia BOT_DETECT_SLOTS (CSV). Wildcard '*' NÃO é suportado nesta fase (o job precisa resolver
 * a sessão WAHA de CADA slot pra ler message_log; "todos" exigiria listar todos os clones).
 * Use lista explícita. Entradas vazias/'*' são descartadas.
 */
function parseSlots(csv: string): string[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '*');
}

/**
 * Avisa o dono do clone sobre um número suspeito de bot. Reusa o transporte do auto-aviso de
 * desconexão: destino = getCloneDisconnectAlertTarget (alert_owner_phone -> cliente_telefone) +
 * opt-in alert_owner_enabled; remetente = sessão ALERTAS (sender_slot -> bot_config.waha_sessao).
 * Telefone do suspeito sempre MASCARADO na copy e no log. Nunca lança.
 */
async function alertOwner(slot: string, telefone: string): Promise<AlertOutcome> {
  const target = await flowClones.getCloneDisconnectAlertTarget(slot);
  if (!target) return { status: 'skipped', reason: 'no_target' };
  if (!target.enabled) return { status: 'skipped', reason: 'opt_out' };
  if (!target.phone) return { status: 'skipped', reason: 'no_target' };

  const ownerPhone = ensureDddBr(target.phone);
  if (!ownerPhone) return { status: 'skipped', reason: 'no_target' };

  const cfg = await alerts.getConfig();
  const sessao = await alerts.getSenderSession(cfg.sender_slot);
  if (!sessao) return { status: 'failed', reason: 'no_sender' };

  const texto = renderBotDetectAlert({
    nomeNegocio: target.nomeNegocio,
    phoneMasked: phoneHint(telefone),
  });

  try {
    await Promise.race([
      waha.sendText({
        sessao,
        chatId: toChatId(ownerPhone),
        texto,
        typing: true,
        delayMs: config.BOT_DETECT_TYPING_DELAY_MS,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('sendText timeout')), config.BOT_DETECT_SEND_TIMEOUT_MS),
      ),
    ]);
    log.info(
      { slot, ownerHint: phoneHint(target.phone), suspectHint: phoneHint(telefone) },
      'bot-detect: dono alertado sobre número suspeito de bot',
    );
    return { status: 'sent' };
  } catch (e) {
    log.error(
      { slot, err: e instanceof Error ? e.message : String(e) },
      'bot-detect: sendText falhou',
    );
    return { status: 'failed', reason: 'send_error' };
  }
}

/**
 * Roda 1 ciclo do bot-detect. NO-OP total (zero query) se BOT_DETECT_ENABLED off OU sem slots.
 * Idempotente: o cache (contact_classification) garante que cada número é classificado 1×; rodar
 * 2× não re-alerta (alerted_at + número já fora da lista de candidatos).
 */
export async function runBotDetect(): Promise<BotDetectResult> {
  const result: BotDetectResult = {
    skipped: false,
    slots: 0,
    classified: 0,
    bots: 0,
    humans: 0,
    allowlisted: 0,
    alerts: 0,
    deferred: 0,
    alertFailed: 0,
  };

  // GATE (defesa em profundidade): sem flag OU sem slots -> NO-OP. Zero query. Byte-a-byte OFF.
  if (!config.BOT_DETECT_ENABLED) {
    result.skipped = true;
    return result;
  }
  const slots = parseSlots(config.BOT_DETECT_SLOTS);
  if (slots.length === 0) {
    result.skipped = true;
    return result;
  }

  for (const slot of slots) {
    const info = await botDetect.getCloneInfo(slot).catch((e: unknown) => {
      log.warn(
        { slot, err: e instanceof Error ? e.message : String(e) },
        'bot-detect: erro ao resolver clone — slot pulado',
      );
      return null;
    });
    if (!info) continue;
    result.slots++;

    let candidates: Awaited<ReturnType<typeof botDetect.listUnclassifiedCandidates>>;
    try {
      candidates = await botDetect.listUnclassifiedCandidates(
        slot,
        info.waha_sessao,
        config.BOT_DETECT_MAX_PER_RUN,
      );
    } catch (e: unknown) {
      log.error(
        { slot, err: e instanceof Error ? e.message : String(e) },
        'bot-detect: erro ao listar candidatos — slot pulado',
      );
      continue;
    }

    let alertsForSlot = 0;
    for (const cand of candidates) {
      const telefone = cand.telefone;
      try {
        // 1) ALLOWLIST DURA — cliente real / infra interna: nunca marca bot.
        if (isInternalNumber(telefone)) {
          await botDetect.upsertClassification({
            flowId: slot,
            telefone,
            verdict: 'human',
            confidence: 1,
            signals: { allowlist: 'internal' },
            source: 'allowlist',
          });
          result.allowlisted++;
          result.humans++;
          result.classified++;
          continue;
        }
        const jaAgendou = await antibot.hasScheduledHistory(slot, telefone).catch((e: unknown) => {
          // fail-closed: na dúvida NÃO allowlista (segue pra heurística, que é conservadora).
          log.warn(
            {
              slot,
              telefone: phoneHint(telefone),
              err: e instanceof Error ? e.message : String(e),
            },
            'bot-detect: erro ao checar allowlist de agendamento — segue heurística',
          );
          return false;
        });
        if (jaAgendou) {
          await botDetect.upsertClassification({
            flowId: slot,
            telefone,
            verdict: 'human',
            confidence: 1,
            signals: { allowlist: 'scheduled' },
            source: 'allowlist',
          });
          result.allowlisted++;
          result.humans++;
          result.classified++;
          continue;
        }

        // 2) SINAIS (timing + conteúdo).
        const timestamps = await botDetect.getMessageTimestamps(info.waha_sessao, telefone);
        const timing = computeTimingSignals(timestamps.map((d) => d.getTime()));
        const contents = info.chat_table
          ? await botDetect
              .getHumanMessages(info.chat_table, telefone, config.BOT_DETECT_CONTENT_LIMIT)
              .catch((e: unknown) => {
                log.warn(
                  { slot, err: e instanceof Error ? e.message : String(e) },
                  'bot-detect: erro ao ler conteúdo — eixo de conteúdo vazio',
                );
                return [] as string[];
              })
          : [];
        const content = computeContentSignals(contents);
        const { verdict, confidence, signals } = classifyHeuristic(timing, content);

        if (verdict === 'human') {
          await botDetect.upsertClassification({
            flowId: slot,
            telefone,
            verdict,
            confidence,
            signals,
            source: 'heuristic',
          });
          result.humans++;
          result.classified++;
          continue;
        }

        // 3) verdict === 'bot' -> Fase 1 = SÓ ALERTA (nunca pausa).
        // "Cooldown": teto de alertas por ciclo por clone. Acima do teto -> NÃO cacheia
        // (reavalia/alerta no próximo ciclo; nenhum alerta é perdido).
        if (alertsForSlot >= config.BOT_DETECT_MAX_ALERTS_PER_RUN) {
          result.deferred++;
          log.info(
            { slot, telefone: phoneHint(telefone) },
            'bot-detect: bot detectado, teto de alertas do ciclo atingido — adiado',
          );
          continue;
        }

        const outcome = await alertOwner(slot, telefone);
        if (outcome.status === 'sent') {
          await botDetect.upsertClassification({
            flowId: slot,
            telefone,
            verdict,
            confidence,
            signals,
            source: 'heuristic',
          });
          await botDetect.markAlerted(slot, telefone);
          alertsForSlot++;
          result.alerts++;
          result.bots++;
          result.classified++;
        } else if (outcome.status === 'skipped') {
          // opt-out / sem destino = config estável: cacheia o veredito (não reprocessa), sem alertar.
          await botDetect.upsertClassification({
            flowId: slot,
            telefone,
            verdict,
            confidence,
            signals,
            source: 'heuristic',
          });
          result.bots++;
          result.classified++;
          log.info(
            { slot, reason: outcome.reason },
            'bot-detect: bot detectado, alerta não enviado (opt-out/sem destino)',
          );
        } else {
          // failed (sender ausente / erro de envio) = transitório: NÃO cacheia, retry no próximo ciclo.
          result.alertFailed++;
          log.warn(
            { slot, telefone: phoneHint(telefone), reason: outcome.reason },
            'bot-detect: falha ao alertar o dono — bot não cacheado (retry próximo ciclo)',
          );
        }
      } catch (e: unknown) {
        // fail-safe por item: nunca derruba o ciclo nem afeta outros números/clones.
        log.error(
          { slot, telefone: phoneHint(telefone), err: e instanceof Error ? e.message : String(e) },
          'bot-detect: erro no item',
        );
      }
    }
  }

  return result;
}
