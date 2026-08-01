/**
 * Job bot-detect-autopause — SCRUM-4 PR-E (Fase 2: escalação -> auto-pausa + TTL/reversão).
 *
 * PASSO ADITIVO sobre o bot-detect (Fase 1 só alerta). Lê o cache `contact_classification` que a
 * Fase 1 preenche e, para os bots JÁ ALERTADOS cuja CARÊNCIA expirou, aplica 3 condições
 * conservadoras antes de pausar:
 *   (a) o DONO não agiu  — não pausou manualmente o número (nem ele entrou na allowlist);
 *   (b) o número NÃO PAROU — ainda tem atividade recente em message_log;
 *   (c) AINDA classifica como BOT — re-roda a heurística (timing + conteúdo) ao vivo.
 * Só com as TRÊS verdadeiras -> addFlowPause(source='bot_detected') + contact_classification.paused_at.
 *
 * Máquina de estados (na coluna): suspeito -> alertado (alerted_at) -> (carência) -> auto_pausado
 * (paused_at + flow_pause ativo) -> despausado (flow_pause inativo; paused_at FICA = one-shot).
 *
 * REVERSÍVEL SEMPRE:
 *   - TTL: pausa 'bot_detected' com updated_at <= ttlCutoff é REMOVIDA (auto-expira sem humano);
 *   - auto-resume: número que vira allowlist (agendou / interno) é despausado na hora;
 *   - despausar do cliente no portal (rota dedicada) = a rede de proteção final.
 * Em qualquer caso `paused_at` permanece carimbado -> o número NUNCA é re-auto-pausado (one-shot,
 * anti loop pausa/despausa).
 *
 * ALLOWLIST DURA: número interno (sessão ALERTAS) ou que JÁ agendou no clone NUNCA é auto-pausado
 * (rechecado no momento da escalação — não confia só no cache da Fase 1).
 *
 * GATES (defesa em profundidade): BOT_DETECT_AUTOPAUSE (default OFF) + BOT_DETECT_SLOTS (CSV; vazio
 * = OFF pra todos). Sem flag/sem slots -> NO-OP total (zero query). Pagante fora da lista = OFF
 * byte-a-byte. Reusa as funções PURAS da Fase 1 (classifyHeuristic etc.) — zero duplicação de regra.
 *
 * LGPD/fail-safe: telefone SEMPRE mascarado no log (phoneHint). Falha de UM item nunca derruba o
 * ciclo nem afeta outros números/clones (try/catch por item). Idempotente: re-rodar não duplica
 * (markPaused guarda paused_at IS NULL; addFlowPause é ON CONFLICT).
 */
import { logger } from '@startap/core/logger';
import { phoneHint } from '@startap/core/phone';
import { antibot, botDetect, contactNames, pausa } from '@startap/db';
import { config } from '../config.js';
import {
  classifyHeuristic,
  computeContentSignals,
  computeTimingSignals,
  isInternalNumber,
} from './bot-detect.js';

const log = logger.child({ job: 'bot-detect-autopause' });

/** Source das pausas criadas pela auto-pausa (chave da seção do portal + do TTL/auto-resume). */
const BOT_PAUSE_SOURCE = 'bot_detected';
const HOUR_MS = 3_600_000;

export interface BotDetectAutopauseResult extends Record<string, unknown> {
  /** true = gate OFF (flag/sem slots) -> não rodou (zero query). */
  skipped: boolean;
  /** clones varridos. */
  slots: number;
  /** candidatos de escalação avaliados. */
  evaluated: number;
  /** números AUTO-PAUSADOS neste ciclo. */
  paused: number;
  /** pulados por allowlist (cliente real / interno) — rebaixados a human. */
  skippedAllowlist: number;
  /** pulados porque o dono já tinha pausado manualmente (cond. a). */
  skippedOwnerActed: number;
  /** pulados porque o número parou (sem atividade recente — cond. b). */
  skippedStopped: number;
  /** pulados porque a heurística não confirma mais bot (cond. c) — rebaixados a human. */
  skippedReclassified: number;
  /** pausas 'bot_detected' removidas por TTL. */
  ttlExpired: number;
  /** pausas 'bot_detected' removidas por auto-resume (número virou allowlist). */
  autoResumed: number;
}

function emptyResult(skipped: boolean): BotDetectAutopauseResult {
  return {
    skipped,
    slots: 0,
    evaluated: 0,
    paused: 0,
    skippedAllowlist: 0,
    skippedOwnerActed: 0,
    skippedStopped: 0,
    skippedReclassified: 0,
    ttlExpired: 0,
    autoResumed: 0,
  };
}

/** Espelha parseSlots do bot-detect: CSV explícito, sem wildcard (precisa resolver sessão por slot). */
function parseSlots(csv: string): string[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '*');
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Allowlist DURA: número interno OU já agendou no clone. fail-closed (erro -> NÃO allowlista). */
async function isAllowlisted(slot: string, telefone: string): Promise<boolean> {
  if (isInternalNumber(telefone)) return true;
  return antibot.hasScheduledHistory(slot, telefone).catch((e: unknown) => {
    log.warn(
      { slot, telefone: phoneHint(telefone), err: errMsg(e) },
      'bot-detect-autopause: erro ao checar allowlist — fail-closed (não allowlista)',
    );
    return false;
  });
}

/**
 * Roda 1 ciclo de escalação + TTL. NO-OP total (zero query) se BOT_DETECT_AUTOPAUSE off OU sem
 * slots. Idempotente; conservador; reversível.
 */
export async function runBotDetectAutopause(): Promise<BotDetectAutopauseResult> {
  // GATE (defesa em profundidade): sem flag OU sem slots -> NO-OP. Zero query. Byte-a-byte OFF.
  if (!config.BOT_DETECT_AUTOPAUSE) return emptyResult(true);
  const slots = parseSlots(config.BOT_DETECT_SLOTS);
  if (slots.length === 0) return emptyResult(true);

  const result = emptyResult(false);
  const now = Date.now();
  const graceCutoff = new Date(now - config.BOT_DETECT_GRACE_HOURS * HOUR_MS);
  const activityCutoff = new Date(now - config.BOT_DETECT_ACTIVITY_WINDOW_HOURS * HOUR_MS);
  const ttlCutoff = new Date(now - config.BOT_DETECT_PAUSE_TTL_HOURS * HOUR_MS);

  for (const slot of slots) {
    const info = await botDetect.getCloneInfo(slot).catch((e: unknown) => {
      log.warn(
        { slot, err: errMsg(e) },
        'bot-detect-autopause: erro ao resolver clone — slot pulado',
      );
      return null;
    });
    if (!info) continue;
    result.slots++;

    // ── 1) ESCALAÇÃO -> auto-pausa ──────────────────────────────────────────────────────────
    let candidates: Awaited<ReturnType<typeof botDetect.listEscalationCandidates>>;
    try {
      candidates = await botDetect.listEscalationCandidates(
        slot,
        graceCutoff,
        config.BOT_DETECT_AUTOPAUSE_MAX_PER_RUN,
      );
    } catch (e: unknown) {
      log.error(
        { slot, err: errMsg(e) },
        'bot-detect-autopause: erro ao listar candidatos — slot pulado',
      );
      candidates = [];
    }

    for (const cand of candidates) {
      const telefone = cand.telefone;
      result.evaluated++;
      try {
        // (a.1) ALLOWLIST DURA — cliente real / infra: NUNCA auto-pausa; rebaixa a human (sai da fila).
        if (await isAllowlisted(slot, telefone)) {
          await botDetect.markHumanOverride({
            flowId: slot,
            telefone,
            source: 'allowlist',
            signalsPatch: { autopause: 'skip_allowlisted' },
          });
          result.skippedAllowlist++;
          continue;
        }

        // (a.2) DONO JÁ AGIU — pausou manualmente: não duplica; carimba paused_at (escalação concluída).
        if (await pausa.isFlowPaused({ flowId: slot, telefone })) {
          await botDetect.markPaused(slot, telefone);
          result.skippedOwnerActed++;
          continue;
        }

        // (b) NÚMERO PAROU — sem atividade recente: não pausa (conservador). NÃO carimba (pode voltar).
        const ativo = await botDetect.hasRecentMessages(info.waha_sessao, telefone, activityCutoff);
        if (!ativo) {
          result.skippedStopped++;
          continue;
        }

        // (c) AINDA É BOT? — re-roda a heurística ao vivo (não confia só no cache da Fase 1).
        const timestamps = await botDetect.getMessageTimestamps(info.waha_sessao, telefone);
        const timing = computeTimingSignals(timestamps.map((d) => d.getTime()));
        const contents = info.chat_table
          ? await botDetect
              .getHumanMessages(info.chat_table, slot, telefone, config.BOT_DETECT_CONTENT_LIMIT)
              .catch((e: unknown) => {
                log.warn(
                  { slot, err: errMsg(e) },
                  'bot-detect-autopause: erro ao ler conteúdo — eixo de conteúdo vazio',
                );
                return [] as string[];
              })
          : [];
        const content = computeContentSignals(contents);
        const { verdict } = classifyHeuristic(timing, content);
        if (verdict !== 'bot') {
          await botDetect.markHumanOverride({
            flowId: slot,
            telefone,
            source: 'heuristic',
            signalsPatch: { autopause: 'reclassified_human' },
          });
          result.skippedReclassified++;
          continue;
        }

        // SCRUM-144: snapshota o nome do CONTATO do store durável (pushName do INBOUND).
        // Fail-safe: erro/ausência nunca atrasa nem derruba a auto-pausa (nome fica NULL).
        const contactNameAutopause = await contactNames
          .getContactName({ session: info.waha_sessao, telefone })
          .catch(() => null);

        // 3 condições VERDADEIRAS -> AUTO-PAUSA (reversível por TTL / despausar do cliente).
        await pausa.addFlowPause({
          flowId: slot,
          telefone,
          session: info.waha_sessao,
          source: BOT_PAUSE_SOURCE,
          reason: 'Auto-pausado por suspeita de bot (carência expirada)',
          contactName: contactNameAutopause,
        });
        await botDetect.markPaused(slot, telefone);
        result.paused++;
        log.info(
          { slot, telefone: phoneHint(telefone) },
          'bot-detect-autopause: número AUTO-PAUSADO (suspeita de bot)',
        );
      } catch (e: unknown) {
        // fail-safe por item: nunca derruba o ciclo nem afeta outros números/clones.
        log.error(
          { slot, telefone: phoneHint(telefone), err: errMsg(e) },
          'bot-detect-autopause: erro no item de escalação',
        );
      }
    }

    // ── 2) TTL / auto-resume das pausas 'bot_detected' ──────────────────────────────────────
    let active: Awaited<ReturnType<typeof pausa.listActiveFlowPausesBySource>>;
    try {
      active = await pausa.listActiveFlowPausesBySource(slot, BOT_PAUSE_SOURCE);
    } catch (e: unknown) {
      log.error(
        { slot, err: errMsg(e) },
        'bot-detect-autopause: erro ao listar pausas ativas — TTL pulado',
      );
      active = [];
    }

    for (const p of active) {
      const telefone = p.telefone;
      try {
        // TTL: pausa vencida -> remove (auto-expira). paused_at FICA -> não re-auto-pausa.
        if (p.updated_at.getTime() <= ttlCutoff.getTime()) {
          await pausa.removeFlowPause({ flowId: slot, telefone });
          result.ttlExpired++;
          log.info(
            { slot, telefone: phoneHint(telefone) },
            'bot-detect-autopause: pausa expirou (TTL) — despausado',
          );
          continue;
        }
        // Auto-resume: número virou allowlist (agendou / interno = sinal humano) -> despausa + human.
        if (await isAllowlisted(slot, telefone)) {
          await pausa.removeFlowPause({ flowId: slot, telefone });
          await botDetect.markHumanOverride({
            flowId: slot,
            telefone,
            source: 'allowlist',
            signalsPatch: { autopause: 'auto_resume_allowlisted' },
          });
          result.autoResumed++;
          log.info(
            { slot, telefone: phoneHint(telefone) },
            'bot-detect-autopause: sinal humano (agendou) — auto-resume',
          );
        }
      } catch (e: unknown) {
        log.error(
          { slot, telefone: phoneHint(telefone), err: errMsg(e) },
          'bot-detect-autopause: erro no item de TTL/resume',
        );
      }
    }
  }

  return result;
}
