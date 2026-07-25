/**
 * trial-owner-pause-alert — alerta INTERNO: TRIAL prestes a expirar com o bot DESLIGADO pelo dono (SCRUM-125).
 *
 * PROBLEMA (Meduzza, 07/2026): um clone em TRIAL (client_billing.last_payment_at NULL) teve o bot
 * DESLIGADO pelo próprio dono no portal (flow_clones.suspended_kind='owner_request') e ninguém religou.
 * O bot fica mudo, o trial caminha pro vencimento sem conversão, e vira CHURN SILENCIOSO — o time só
 * descobre por varredura manual. ⚠️ PIX NÃO religa owner_request: o dono pode até pagar e continuar mudo.
 *
 * ESTE JOB dá VISIBILIDADE (e SÓ isso — NÃO toca o bot/pausa): cruza os trials cujo bot está pausado
 * pelo dono há dias × a proximidade do vencimento e dispara UM alerta interno via ALERTAS ("falar com o
 * cliente antes de virar churn"), com COOLDOWN por-slot (default 24h) pra não repetir todo ciclo.
 *
 * DESENHO (regras de ouro + lições, espelhando billing-silence-alert):
 *  - GATE MACRO: TRIAL_PAUSE_ALERT_ENABLED (default-ON, SCRUM-130/125 ordem do Bruno). Checado pelo
 *    CHAMADOR (worker.ts) — kill-switch =false desliga sem deploy.
 *  - FONTE DA PAUSA: estado ATUAL de flow_clones (suspended_kind='owner_request' + flow_enabled=false +
 *    suspended_at), materialização transacional do "último suspend sem resume" — a mesma que o portal usa.
 *  - SÓ TRIAL: last_payment_at IS NULL. Pagante NUNCA entra aqui (é o billing-silence-alert quem cobre).
 *  - DECISÃO PURA em TS (testável sem banco): alerta ⟺ pausado há >= minPausedDays E vencimento dentro
 *    de dueWindowDays (inclui já-vencido). A query só traz os candidatos brutos (sem filtro de dias).
 *  - COOLDOWN / IDEMPOTÊNCIA: reusa alert_states (chave 'trialpause:<slot>', sem PII). Carimba SÓ APÓS
 *    envio bem-sucedido (sent>0) — nunca antes (senão vira alerta perdido carimbado como enviado).
 *  - FAIL-SAFE: nunca lança. Falha por-slot é logada e o loop segue; falha global cai no catch externo.
 *  - LGPD: zero telefone/CPF. A mensagem carrega só nome do negócio + slot + data + dias. Logs = só slot.
 */
import { logger } from '@startap/core/logger';
import { alerts, clientBilling } from '@startap/db';
import { internalAlert } from '@startap/integrations';

const log = logger.child({ job: 'trial-owner-pause-alert' });

export interface TrialOwnerPauseAlertResult extends Record<string, unknown> {
  /** trials owner-paused examinados neste ciclo. */
  scanned: number;
  /** candidatos de fato (pausado há dias + perto do vencimento). */
  atRisk: number;
  /** alertas internos ENVIADOS neste ciclo. */
  alerted: number;
  /** candidatos suprimidos pelo cooldown por-slot (avisado há < janela). */
  cooldownSuppressed: number;
  /** envios que NÃO saíram (sent=0) — não carimbados, re-tentados no próximo ciclo. */
  sendFailed: number;
  /** slots pulados por erro de leitura de estado (fail-closed, re-tentados no próximo ciclo). */
  stateErrors: number;
}

const EMPTY: TrialOwnerPauseAlertResult = {
  scanned: 0,
  atRisk: 0,
  alerted: 0,
  cooldownSuppressed: 0,
  sendFailed: 0,
  stateErrors: 0,
};

export interface RunTrialOwnerPauseAlertOpts {
  /** Dias MÍNIMOS de pausa do dono pra alertar (evita alarme por toggle curto). */
  minPausedDays: number;
  /** Janela (dias) até o vencimento pra considerar "prestes a expirar" (inclui já-vencido). */
  dueWindowDays: number;
  /** Cooldown (min) por-slot entre alertas do MESMO trial pausado. */
  cooldownMin: number;
  /** "Agora" injetável (só p/ teste). */
  now?: Date;
}

/** check_key do cooldown por-slot. Sem PII (usa o slot, não telefone). */
export function trialPauseCooldownKey(slot: string): string {
  return `trialpause:${slot}`;
}

/**
 * Decisão PURA de "trial em risco de churn": pausado pelo dono há tempo suficiente E com o
 * vencimento dentro da janela (dias_ate_vencer <= dueWindowDays, o que inclui já-vencido).
 */
export function evaluateTrialAtRisk(
  row: clientBilling.TrialOwnerPausedCandidate,
  minPausedDays: number,
  dueWindowDays: number,
): boolean {
  const pausadoTempo = row.dias_pausado >= minPausedDays;
  const pertoDoVenc = row.next_due_date != null && row.dias_ate_vencer <= dueWindowDays;
  return pausadoTempo && pertoDoVenc;
}

/**
 * Varre os trials owner-paused e dispara 1 alerta interno por clone em risco (com cooldown).
 * NUNCA lança (fire-and-forget pro cron do worker).
 */
export async function runTrialOwnerPauseAlert(
  opts: RunTrialOwnerPauseAlertOpts,
): Promise<TrialOwnerPauseAlertResult> {
  const result: TrialOwnerPauseAlertResult = { ...EMPTY };
  const now = opts.now ?? new Date();

  try {
    const rows = await clientBilling.listTrialOwnerPausedCandidates();
    result.scanned = rows.length;

    for (const row of rows) {
      if (!evaluateTrialAtRisk(row, opts.minPausedDays, opts.dueWindowDays)) continue;
      result.atRisk += 1;

      const key = trialPauseCooldownKey(row.slot);

      // Cooldown por-slot. FAIL-CLOSED em erro de leitura: pula ESTE slot neste ciclo (não arrisca
      // spam nem carimba às cegas) — o próximo ciclo re-tenta. O monitor cobre a saúde do DB.
      let prev: alerts.AlertStateRow | null;
      try {
        prev = await alerts.getState(key);
      } catch (e) {
        result.stateErrors += 1;
        log.warn(
          { slot: row.slot, err: e instanceof Error ? e.message : String(e) },
          'trial-owner-pause-alert: falha ao ler estado do cooldown — pula este slot (fail-closed)',
        );
        continue;
      }

      const last = prev?.last_alert_at ?? null;
      if (last && now.getTime() - last.getTime() < opts.cooldownMin * 60_000) {
        result.cooldownSuppressed += 1;
        continue;
      }

      const texto = internalAlert.msgTrialOwnerPausado({
        displayName: row.display_name ?? row.slot,
        slot: row.slot,
        // next_due_date é garantido não-nulo pelo WHERE da query + pertoDoVenc na decisão.
        nextDueDate: row.next_due_date ?? '',
        diasAteVencer: row.dias_ate_vencer,
        diasPausado: row.dias_pausado,
      });

      // sendInternalAlert NUNCA lança e retorna { sent }. Carimba o cooldown SÓ APÓS sucesso (sent>0)
      // — se não saiu, NÃO carimba, o próximo ciclo re-tenta (nunca registra um alerta perdido como
      // enviado).
      const { sent } = await internalAlert.sendInternalAlert(texto);
      if (sent > 0) {
        try {
          await alerts.upsertState({
            checkKey: key,
            state: 'down', // semântica local: "trial em episódio de risco já avisado"
            lastAlertAt: now,
            alertCount: (prev?.alert_count ?? 0) + 1,
          });
        } catch (e) {
          // Já entregou; falhar o carimbo só arrisca 1 alerta duplicado no próximo ciclo (aceitável).
          log.warn(
            { slot: row.slot, err: e instanceof Error ? e.message : String(e) },
            'trial-owner-pause-alert: alerta enviado mas falhou ao carimbar cooldown (pode duplicar)',
          );
        }
        result.alerted += 1;
      } else {
        result.sendFailed += 1;
        log.warn(
          { slot: row.slot },
          'trial-owner-pause-alert: alerta não entregue (sent=0) — não carimba, re-tenta no próximo ciclo',
        );
      }
    }
  } catch (e) {
    // Fail-safe global: nunca derruba o worker.
    log.error(
      { err: e instanceof Error ? e.message : String(e) },
      'trial-owner-pause-alert: falha inesperada na varredura — ciclo abortado (worker segue)',
    );
  }

  return result;
}
