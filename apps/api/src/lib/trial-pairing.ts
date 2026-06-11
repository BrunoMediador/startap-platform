/**
 * trial-pairing — hook do "primeiro WORKING da sessão" (Missão 020 F1).
 *
 * Recebe eventos `session.status` do webhook WAHA (as sessões de clone já são
 * criadas com esse evento — clone-provisioning/with-waha). Quando a sessão de um
 * clone de TRIAL atinge WORKING, lê o número REALMENTE pareado (me.id — prova de
 * posse), canonicaliza, e decide contra o trial_ledger:
 *
 *   - número virgem  -> consome trial + next_due_date = hoje + 10d (trial COMEÇA).
 *   - exempt         -> segue normal sem consumir (whitelist interna do time).
 *   - já consumido   -> BLOQUEIA (flow_enabled=false, kind='billing' — pagar PIX
 *                       reativa pelo auto-resume que JÁ existe).
 *   - me.id != cadastro -> RE-VINCULA cliente_telefone ao me.id (doc 020: fonte
 *                       de verdade é quem pareou) e consome pelo me.id.
 *   - troca de número durante trial ativo -> consome TAMBÉM o novo (máx 2 por
 *                       trial; dias não resetam). 3º número -> bloqueia.
 *
 * SEGURANÇA/ISOLAMENTO:
 *   - Clones com trial_status='none' (Cirilo, matrizes, clones manuais do
 *     gestão): NOOP absoluto — zero mudança de comportamento.
 *   - Pepper (TRIAL_PHONE_PEPPER) validado LAZY: ausência LOGA e ignora o
 *     evento; NUNCA crasha o webhook (lição #247).
 *   - LGPD: telefone NUNCA logado em claro — só phone_hint (DDD + 2 últimos).
 *   - Idempotente: ledger com ON CONFLICT DO NOTHING; next_due_date só nasce se
 *     NULL; eventos WORKING repetidos viram no-op.
 */
import { logger } from '@startap/core/logger';
import { canonicalE164, phoneHint } from '@startap/core/phone';
import { TrialPepperMissingError, trialPhoneHmac } from '@startap/core/trial';
import type { WahaWebhookBody } from '@startap/core/types';
import { flowExecutionLog, trialLedger } from '@startap/db';
import { waha } from '@startap/integrations';
import { z } from 'zod';

const log = logger.child({ module: 'trial-pairing' });

/** Payload do evento session.status (passthrough — engines variam). */
const SessionStatusPayload = z
  .object({
    status: z.string().nullish(),
    me: z.object({ id: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();

const WAHA_TIMEOUT_MS = 8_000;

interface HookOpts {
  executionId: string;
  startedAt: number;
}

/**
 * Entry point — chamado pelo router para body.event === 'session.status'.
 * Sempre resolve (nunca lança): o webhook WAHA precisa de 2xx.
 */
export async function handleSessionStatusEvent(
  body: WahaWebhookBody,
  opts: HookOpts,
): Promise<{ status: string }> {
  try {
    return await processSessionStatus(body, opts);
  } catch (e) {
    log.error(
      { session: body.session, err: e instanceof Error ? e.message : String(e) },
      'trial-pairing: erro inesperado (ignorado, webhook responde 2xx)',
    );
    await flowExecutionLog.logFlowEvent({
      executionId: opts.executionId,
      session: body.session,
      eventType: 'trial.hook-error',
      status: 'error',
      message: 'Hook de trial falhou',
      error: e,
      durationMs: Date.now() - opts.startedAt,
    });
    return { status: 'error:trial-hook' };
  }
}

async function processSessionStatus(
  body: WahaWebhookBody,
  opts: HookOpts,
): Promise<{ status: string }> {
  const baseLog = { executionId: opts.executionId, session: body.session };
  const parsed = SessionStatusPayload.safeParse(body.payload ?? {});
  const sessionStatus = parsed.success ? (parsed.data.status ?? null) : null;

  if (sessionStatus !== 'WORKING') {
    return { status: 'ignored:session-status' };
  }

  // Clone do tenant pela sessão — leitura fresh (sem cache TTL).
  const info = await trialLedger.getTrialInfoBySession(body.session);
  if (!info) {
    return { status: 'ignored:session-status' };
  }

  // Clones manuais/legados: NOOP absoluto (Cirilo nunca passa daqui).
  if (info.trial_status === 'none' || info.trial_status === 'exempt') {
    return { status: 'ignored:trial-none' };
  }

  // Número REALMENTE pareado (prova de posse): payload.me.id ou GET na sessão.
  let meId = parsed.success ? (parsed.data.me?.id ?? null) : null;
  if (!meId) {
    try {
      const s = await waha.sessions.getSessionStatus(body.session, {
        timeoutMs: WAHA_TIMEOUT_MS,
      });
      meId = s.me?.id ?? null;
    } catch (e) {
      log.warn(
        { ...baseLog, err: e instanceof Error ? e.message : String(e) },
        'trial-pairing: WAHA indisponível para ler me.id (tenta no próximo evento)',
      );
      return { status: 'ignored:no-me-id' };
    }
  }
  if (!meId) {
    log.warn(baseLog, 'trial-pairing: sessão WORKING sem me.id (tenta no próximo evento)');
    return { status: 'ignored:no-me-id' };
  }

  const paired = canonicalE164(meId);
  if (!paired) {
    log.warn(baseLog, 'trial-pairing: me.id não canonicalizável');
    return { status: 'ignored:bad-me-id' };
  }
  const hint = phoneHint(paired);

  let hmac: string;
  try {
    hmac = trialPhoneHmac(paired);
  } catch (e) {
    if (e instanceof TrialPepperMissingError) {
      // Lição #247: env ausente NUNCA crasha. Loga alto e ignora — o trial não
      // inicia até o pepper ser provisionado (flag PORTAL_SIGNUP exige o mesmo).
      log.error(
        { ...baseLog, slot: info.slot },
        'trial-pairing: TRIAL_PHONE_PEPPER ausente — trial NÃO iniciado',
      );
      return { status: 'ignored:no-pepper' };
    }
    throw e;
  }

  const registeredCanonical = info.cliente_telefone ? canonicalE164(info.cliente_telefone) : null;
  const diverged = registeredCanonical != null && registeredCanonical !== paired;

  const ledger = await trialLedger.findByPhoneHmac(hmac);

  // ── Whitelist interna: pareia à vontade sem consumir ─────────────────────────
  if (ledger?.status === 'exempt') {
    await trialLedger.markExempt(info.slot, paired);
    await logTrialEvent(opts, body.session, info.slot, 'trial.exempt', 'success', {
      phoneHint: hint,
    });
    return { status: 'ok:trial-exempt' };
  }

  // ── Número já consumido ───────────────────────────────────────────────────────
  if (ledger?.status === 'consumed') {
    if (ledger.slot === info.slot) {
      // Reconexão do mesmo número no mesmo clone — trial já contado, no-op.
      return { status: 'ok:trial-already-counted' };
    }
    if (info.trial_status !== 'blocked') {
      await trialLedger.blockTrial({ slot: info.slot });
      await logTrialEvent(opts, body.session, info.slot, 'trial.blocked', 'ignored', {
        phoneHint: hint,
        reason: 'numero ja consumiu trial em outro clone',
      });
    }
    return { status: 'ok:trial-blocked' };
  }

  // ── Número virgem ─────────────────────────────────────────────────────────────
  if (info.trial_status === 'awaiting') {
    const { nextDueDate } = await trialLedger.startTrial({
      slot: info.slot,
      phoneHmac: hmac,
      phoneHint: hint,
      pairedPhone: paired,
      notes: diverged ? 're-vinculado: pareou numero diferente do cadastro' : null,
    });
    await logTrialEvent(opts, body.session, info.slot, 'trial.started', 'success', {
      phoneHint: hint,
      nextDueDate,
      diverged,
    });
    return { status: 'ok:trial-started' };
  }

  if (info.trial_status === 'active') {
    // Troca de número durante o trial (doc 020): consome TAMBÉM o novo número,
    // dias não resetam. Máximo 2 números por trial; o 3º bloqueia.
    const consumed = await trialLedger.countConsumedBySlot(info.slot);
    if (consumed >= 2) {
      await trialLedger.blockTrial({
        slot: info.slot,
        reason: 'trial: excedeu limite de 2 numeros por trial',
      });
      await logTrialEvent(opts, body.session, info.slot, 'trial.blocked', 'ignored', {
        phoneHint: hint,
        reason: 'excedeu 2 numeros por trial',
      });
      return { status: 'ok:trial-blocked' };
    }
    await trialLedger.consumeAdditionalNumber({
      slot: info.slot,
      phoneHmac: hmac,
      phoneHint: hint,
      pairedPhone: paired,
    });
    await logTrialEvent(opts, body.session, info.slot, 'trial.number-swapped', 'success', {
      phoneHint: hint,
    });
    return { status: 'ok:trial-number-swapped' };
  }

  // trial_status === 'blocked' com número virgem: permanece bloqueado (estrito —
  // desbloqueio é pagar o PIX ou override manual do Bruno no gestão).
  return { status: 'ignored:trial-blocked' };
}

async function logTrialEvent(
  opts: HookOpts,
  session: string,
  slot: string,
  eventType: string,
  status: 'success' | 'ignored',
  metadata: Record<string, unknown>,
): Promise<void> {
  await flowExecutionLog
    .logFlowEvent({
      executionId: opts.executionId,
      session,
      flowId: slot,
      eventType,
      status,
      message: eventType,
      metadata,
      durationMs: Date.now() - opts.startedAt,
    })
    .catch((e: unknown) =>
      log.warn({ slot, err: e instanceof Error ? e.message : String(e) }, 'log de trial falhou'),
    );
}
