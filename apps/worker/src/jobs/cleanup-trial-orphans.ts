/**
 * Job — limpeza de trials ÓRFÃOS (Missão 020 F1; condição 2 pra ligar PORTAL_SIGNUP).
 *
 * Órfão = signup self-service que provisionou clone + sessão WAHA mas NUNCA
 * pareou (trial nunca iniciou) e passou da idade limite (TRIAL_ORPHAN_MAX_AGE_HOURS,
 * default 72h). Cada órfão é 1 sessão WAHA (instância Baileys) comendo RAM na
 * VPS sem swap — sem limpeza, cadastros abandonados amplificam o DoS de recurso
 * (security review PR #268).
 *
 * SEMÂNTICA (fonte: migration 044 + portal-signup.ts + doc 020):
 *   flow_clones.trial_status = 'awaiting'  E  status rascunho/aguardando_qr
 *   E  client_billing.next_due_date IS NULL  E  slot LIKE 'clone\_%'
 *   E  created_at mais velho que a idade limite.
 *
 * SEGURANÇA EM CAMADAS:
 *  1. SELECT de candidatos já filtra trial_status='awaiting' — 'none' (Cirilo,
 *     matrizes, clones manuais do gestão) e 'exempt' JAMAIS entram (query em
 *     packages/db trial-ledger).
 *  2. Guard DEFENSIVO no chamador antes do teardown (o teardown compartilhado
 *     não conhece trial_status — propositalmente, pois o signup o usa com
 *     clone ainda 'none'): trial_status precisa ser 'awaiting' e o slot
 *     prefixado clone_.
 *  3. MESMO advisory lock do pareamento (withTrialSlotLock — 'trial:'+slot):
 *     cliente pareando no exato momento da limpeza não perde a sessão. Dentro
 *     do lock o estado é RE-LIDO fresh; se deixou de ser órfão => skip logado.
 *  4. Teardown REUSADO (teardownProvisionedClone — security #268): guarda
 *     interna de prefixo clone_ + status rascunho/aguardando_qr (FOR UPDATE),
 *     NUNCA toca trial_ledger, best-effort (nunca lança).
 *  5. Fail-safe WAHA: se o WAHA estiver inacessível, a rodada INTEIRA aborta —
 *     teardown parcial deletaria o DB e deixaria a sessão viva e invisível.
 *     Órfão não estraga esperando a próxima rodada.
 *
 * IDEMPOTENTE: rodada repetida não quebra — órfão já desfeito sai do SELECT;
 * teardown re-executado é DELETE idempotente. Candidato em corrida => skip
 * silencioso logado (WAHA reenvia session.status; o hook de pareamento cobre).
 *
 * LGPD: o job NUNCA lê nem loga telefone — só slot/sessão/idade (a query de
 * candidatos não seleciona cliente_telefone; o ledger só guarda HMAC).
 *
 * Com PORTAL_SIGNUP OFF (estado atual de prod): zero clones 'awaiting' =>
 * o job roda e não faz nada. Nenhuma env nova é obrigatória no boot (lição #247).
 */
import { logger } from '@startap/core/logger';
import { pool, trialLedger } from '@startap/db';
import { provisioning } from '@startap/integrations';
import { config } from '../config.js';

const log = logger.child({ job: 'cleanup-trial-orphans' });

/** Teto de teardowns por rodada (cinto anti-rajada; o resto fica pra próxima). */
export const MAX_PER_RUN = 20;

const WAHA_PING_TIMEOUT_MS = 8_000;

export interface CleanupTrialOrphansResult extends Record<string, unknown> {
  /** true quando o kill switch TRIAL_ORPHAN_CLEANUP_ENABLED estava OFF. */
  skipped: boolean;
  /** candidatos retornados pelo SELECT nesta rodada. */
  scanned: number;
  /** órfãos com registros do DB removidos (teardown dbDeleted). */
  deleted: number;
  /** sessões WAHA confirmadamente deletadas. */
  wahaSessionsDeleted: number;
  /** advisory lock do slot ocupado (pareamento em curso?) — próxima rodada cobre. */
  skippedLockBusy: number;
  /** recheck dentro do lock disse que NÃO é mais órfão (ex.: pareou no meio). */
  skippedNotOrphan: number;
  /** erros não-fatais por candidato (job não quebra os demais). */
  errors: number;
}

const EMPTY_RESULT: CleanupTrialOrphansResult = {
  skipped: false,
  scanned: 0,
  deleted: 0,
  wahaSessionsDeleted: 0,
  skippedLockBusy: 0,
  skippedNotOrphan: 0,
  errors: 0,
};

/** Adapter pg.Pool -> SqlPool do módulo de provisionamento (mesmo do portal-signup). */
function dbAdapter(): provisioning.SqlPool {
  return {
    query: async (text, values) => pool.query(text, values as unknown[]),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (text, values) => client.query(text, values as unknown[]),
        release: () => client.release(),
      };
    },
  };
}

/**
 * Ping barato no WAHA antes da rodada (fail-safe da camada 5). GET /api/sessions
 * é o mesmo check do runbook waha-webhook-auth. NUNCA lança.
 */
async function wahaReachable(url: string, apiKey: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/api/sessions`, {
      headers: apiKey ? { 'X-Api-Key': apiKey } : {},
      signal: AbortSignal.timeout(WAHA_PING_TIMEOUT_MS),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function runCleanupTrialOrphans(): Promise<CleanupTrialOrphansResult> {
  // ── Kill switch OFF -> NO-OP total (não lê banco, não toca WAHA). ──────────
  if (!config.TRIAL_ORPHAN_CLEANUP_ENABLED) {
    return { ...EMPTY_RESULT, skipped: true };
  }

  const result: CleanupTrialOrphansResult = { ...EMPTY_RESULT };
  const maxAgeHours = config.TRIAL_ORPHAN_MAX_AGE_HOURS;

  const candidates = await trialLedger.listOrphanTrialCandidates(maxAgeHours, MAX_PER_RUN);
  result.scanned = candidates.length;
  if (candidates.length === 0) {
    // Caminho comum com PORTAL_SIGNUP OFF: nada a fazer, nem consulta o WAHA.
    return result;
  }

  // Fail-safe: WAHA fora do ar => aborta a rodada inteira (sem teardown parcial
  // que limparia o DB deixando a sessão Baileys viva e órfã DE VERDADE no WAHA).
  if (!(await wahaReachable(config.WAHA_URL, config.WAHA_API_KEY))) {
    result.errors += 1;
    log.error(
      { candidates: candidates.length, wahaUrl: config.WAHA_URL },
      'cleanup-trial-orphans: WAHA inacessível — rodada abortada (próxima cobre)',
    );
    return result;
  }

  const deps = {
    db: dbAdapter(),
    waha: {
      url: config.WAHA_URL,
      apiKey: config.WAHA_API_KEY,
      webhookUrl: config.TS_WEBHOOK_URL,
    },
  };

  for (const candidate of candidates) {
    const slot = candidate.slot;
    try {
      // Guard DEFENSIVO do chamador (camada 2): o SELECT já filtra, mas o
      // teardown compartilhado não conhece trial_status — nunca confiar numa
      // única camada pra proteger Cirilo/clones manuais.
      if (candidate.trial_status !== 'awaiting' || !slot.startsWith('clone_')) {
        result.errors += 1;
        log.error(
          { slot, trialStatus: candidate.trial_status },
          'cleanup-trial-orphans: candidato fora do contrato de órfão — recusado (investigar query)',
        );
        continue;
      }

      // MESMO lock do trial-pairing (camada 3): pareamento em curso vence.
      const lock = await trialLedger.withTrialSlotLock(slot, async () => {
        const fresh = await trialLedger.findOrphanTrialClone(slot, maxAgeHours);
        if (!fresh) return null; // deixou de ser órfão entre o SELECT e o lock
        const sessionName = fresh.waha_sessao ?? fresh.slot; // signup usa sessionName = slot
        const torn = await provisioning.teardownProvisionedClone(deps, {
          slot: fresh.slot,
          sessionName,
        });
        return { torn, sessionName, ageHours: Math.round(fresh.age_hours) };
      });

      if (!lock.acquired) {
        result.skippedLockBusy += 1;
        log.warn(
          { slot },
          'cleanup-trial-orphans: lock do slot ocupado (pareamento em curso?) — pulado, próxima rodada cobre',
        );
        continue;
      }
      if (lock.result === null) {
        result.skippedNotOrphan += 1;
        log.info(
          { slot },
          'cleanup-trial-orphans: candidato deixou de ser órfão no recheck — pulado',
        );
        continue;
      }

      const { torn, sessionName, ageHours } = lock.result;
      if (torn.dbDeleted) {
        result.deleted += 1;
        if (torn.wahaDeleted) {
          result.wahaSessionsDeleted += 1;
        } else {
          // DB limpo mas o DELETE da sessão não confirmou (ex.: sessão nunca
          // criada no signup, ou WAHA caiu no meio da rodada) — visibilidade
          // pra ops conferir no dashboard WAHA.
          log.warn(
            { slot, sessionName },
            'cleanup-trial-orphans: DB limpo mas sessão WAHA não confirmou DELETE — conferir no WAHA',
          );
        }
        log.info(
          { slot, sessionName, ageHours, wahaDeleted: torn.wahaDeleted },
          'cleanup-trial-orphans: trial órfão removido',
        );
      } else {
        // Teardown abortou (guarda interna) ou falhou no DB — best-effort, o
        // candidato continua no SELECT e a próxima rodada retenta.
        result.errors += 1;
        log.error(
          { slot, sessionName, wahaDeleted: torn.wahaDeleted },
          'cleanup-trial-orphans: teardown não removeu o DB — retenta na próxima rodada',
        );
      }
    } catch (e) {
      result.errors += 1;
      log.error(
        { slot, err: e instanceof Error ? e.message : String(e) },
        'cleanup-trial-orphans: falha no candidato (pulado, demais seguem)',
      );
    }
  }

  return result;
}
