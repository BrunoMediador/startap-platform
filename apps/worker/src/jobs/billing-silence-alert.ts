/**
 * billing-silence-alert — alerta INTERNO quando um clone PAGANTE fica MUDO por inadimplência (SCRUM-67).
 *
 * PROBLEMA: o gate de silêncio por inadimplência (router, ADR 0016, atrás de BILLING_OVERDUE_SILENCE)
 * cala o bot no 4º dia de atraso (daysUntilDue < -GRACE_DAYS). É um DERIVADO puro da data — não escreve
 * estado, não avisa ninguém. Resultado real: o bot do Cirilo (PAGANTE) ficou ~2 dias mudo, 37 msgs
 * ignoradas, e só uma varredura manual descobriu. Ninguém sabia.
 *
 * ESTE JOB dá VISIBILIDADE (e SÓ isso — NÃO toca o gate/silêncio): varre os clones PAGANTES
 * (client_billing.last_payment_at preenchido) que estão silenciados por atraso e dispara UM alerta
 * interno via ALERTAS ("bot do <cliente> silenciado por atraso — reconciliar ou confirmar churn"),
 * com COOLDOWN por-slot (default 24h) pra não repetir todo ciclo enquanto seguir pendente.
 *
 * DESENHO (regras de ouro + lições):
 *  - GATE MACRO: BILLING_SILENCE_ALERT_ENABLED (default OFF). Checado pelo CHAMADOR (worker.ts) ANTES
 *    de registrar o cron — com OFF este job nem roda.
 *  - FIEL AO GATE REAL: só age quando o PRÓPRIO gate de silêncio está ligado
 *    (overdueSilenceEnabled = process.env.BILLING_OVERDUE_SILENCE === 'true', a MESMA fonte do router).
 *    Com o gate OFF ninguém está silenciado -> NO-OP (nenhum alerta falso). Missing no worker = OFF = safe.
 *  - SÓ PAGANTE: last_payment_at != null. Trial / linha sintética (sem pagamento) NUNCA alerta.
 *  - PARIDADE COM O ROUTER: escopo `clone_%` + silenciado ⟺ dias_atraso > GRACE_DAYS (o dias_atraso vem
 *    do mesmo eixo UTC do daysUntilDue). O gate cala ⟺ este job alerta — sem divergência.
 *  - COOLDOWN / IDEMPOTÊNCIA: reusa alert_states (chave 'billsilence:<slot>', sem PII). Carimba o
 *    'já avisei' SÓ APÓS envio bem-sucedido (sent > 0) — nunca antes (lição de client-disconnect-notify:
 *    carimbar antes sem rollback vira alerta perdido). Envio que não sai (sent=0) NÃO carimba -> o
 *    próximo ciclo re-tenta. Concorrência coberta por { protect:true } no cron (sem overlap).
 *  - FAIL-SAFE: nunca lança. Falha por-slot (DB/envio) é logada e o loop segue; falha global cai no
 *    catch externo. NUNCA derruba o worker nem afeta outro clone.
 *  - LGPD: zero telefone/CPF. A mensagem carrega só nome do negócio + slot + data + dias (o transporte
 *    sendInternalAlert resolve os destinatários internamente e nunca loga número). Logs usam só o slot.
 */
import { logger } from '@startap/core/logger';
import { alerts, clientBilling } from '@startap/db';
import { internalAlert } from '@startap/integrations';

const log = logger.child({ job: 'billing-silence-alert' });

export interface BillingSilenceAlertResult extends Record<string, unknown> {
  /** true quando o gate de silêncio (BILLING_OVERDUE_SILENCE) está OFF — NO-OP, ninguém está mudo. */
  skipped: boolean;
  /** clones com cobrança configurada examinados neste ciclo. */
  scanned: number;
  /** pagantes de fato silenciados por atraso agora. */
  silenced: number;
  /** alertas internos ENVIADOS neste ciclo. */
  alerted: number;
  /** clones silenciados suprimidos pelo cooldown por-slot (avisado há < janela). */
  cooldownSuppressed: number;
  /** envios que NÃO saíram (sent=0) — não carimbados, re-tentados no próximo ciclo. */
  sendFailed: number;
  /** slots pulados por erro de leitura de estado (fail-closed, re-tentados no próximo ciclo). */
  stateErrors: number;
}

const EMPTY: BillingSilenceAlertResult = {
  skipped: false,
  scanned: 0,
  silenced: 0,
  alerted: 0,
  cooldownSuppressed: 0,
  sendFailed: 0,
  stateErrors: 0,
};

export interface RunBillingSilenceAlertOpts {
  /** Espelho do gate real (process.env.BILLING_OVERDUE_SILENCE === 'true'). OFF => NO-OP. */
  overdueSilenceEnabled: boolean;
  /** Cooldown (min) por-slot entre alertas do MESMO clone silenciado. */
  cooldownMin: number;
  /** "Agora" injetável (só p/ teste). */
  now?: Date;
}

/** check_key do cooldown por-slot. Sem PII (usa o slot, não telefone). */
export function silenceCooldownKey(slot: string): string {
  return `billsilence:${slot}`;
}

/**
 * Decisão PURA de silêncio-por-inadimplência (paridade com o gate do router, ADR 0016):
 *   silenciado ⟺ PAGANTE (last_payment_at) && temBilling (data + valor>0) && dias_atraso > GRACE_DAYS.
 * O dias_atraso já vem do mesmo eixo UTC do daysUntilDue (query listBillingClonesForSilenceCheck).
 */
export function evaluateOverdueSilence(
  row: clientBilling.BillingSilenceCandidate,
  graceDays: number = clientBilling.GRACE_DAYS,
): { silenced: boolean; diasAtraso: number } {
  const paying = row.last_payment_at != null;
  const temBilling = row.next_due_date != null && (row.amount_cents ?? 0) > 0;
  const diasAtraso = row.dias_atraso;
  const silenced = paying && temBilling && diasAtraso > graceDays;
  return { silenced, diasAtraso };
}

/**
 * Varre os pagantes silenciados por atraso e dispara 1 alerta interno por clone (com cooldown).
 * NUNCA lança (fire-and-forget pro cron do worker).
 */
export async function runBillingSilenceAlert(
  opts: RunBillingSilenceAlertOpts,
): Promise<BillingSilenceAlertResult> {
  const result: BillingSilenceAlertResult = { ...EMPTY };
  const now = opts.now ?? new Date();

  // Fiel ao gate real: com BILLING_OVERDUE_SILENCE OFF ninguém está mudo -> NO-OP (sem alerta falso).
  if (!opts.overdueSilenceEnabled) {
    return { ...result, skipped: true };
  }

  try {
    const rows = await clientBilling.listBillingClonesForSilenceCheck();
    result.scanned = rows.length;

    for (const row of rows) {
      const { silenced, diasAtraso } = evaluateOverdueSilence(row);
      if (!silenced) continue;
      result.silenced += 1;

      const key = silenceCooldownKey(row.slot);

      // Cooldown por-slot. FAIL-CLOSED em erro de leitura: pula ESTE slot neste ciclo (não arrisca
      // spam nem carimba às cegas) — o próximo ciclo re-tenta. O monitor cobre a saúde do DB.
      let prev: alerts.AlertStateRow | null;
      try {
        prev = await alerts.getState(key);
      } catch (e) {
        result.stateErrors += 1;
        log.warn(
          { slot: row.slot, err: e instanceof Error ? e.message : String(e) },
          'billing-silence-alert: falha ao ler estado do cooldown — pula este slot (fail-closed)',
        );
        continue;
      }

      const last = prev?.last_alert_at ?? null;
      if (last && now.getTime() - last.getTime() < opts.cooldownMin * 60_000) {
        result.cooldownSuppressed += 1;
        continue;
      }

      const texto = internalAlert.msgBotSilenciadoInadimplencia({
        displayName: row.display_name ?? row.slot,
        slot: row.slot,
        // next_due_date é garantido não-nulo pelo WHERE da query + temBilling na decisão.
        nextDueDate: row.next_due_date ?? '',
        diasAtraso,
      });

      // sendInternalAlert NUNCA lança e retorna { sent }. Carimba o cooldown SÓ APÓS sucesso (sent>0)
      // — se não saiu, NÃO carimba, o próximo ciclo re-tenta (nunca registra um alerta perdido como
      // enviado). Consome 1 unidade do anti-flood global (rede de segurança compartilhada c/ o monitor).
      const { sent } = await internalAlert.sendInternalAlert(texto);
      if (sent > 0) {
        try {
          await alerts.upsertState({
            checkKey: key,
            state: 'down', // semântica local: "clone em episódio de silêncio já avisado"
            lastAlertAt: now,
            alertCount: (prev?.alert_count ?? 0) + 1,
          });
        } catch (e) {
          // Já entregou; falhar o carimbo só arrisca 1 alerta duplicado no próximo ciclo (aceitável,
          // melhor que perder). Não reverte a entrega.
          log.warn(
            { slot: row.slot, err: e instanceof Error ? e.message : String(e) },
            'billing-silence-alert: alerta enviado mas falhou ao carimbar cooldown (pode duplicar)',
          );
        }
        result.alerted += 1;
      } else {
        result.sendFailed += 1;
        log.warn(
          { slot: row.slot },
          'billing-silence-alert: alerta não entregue (sent=0) — não carimba, re-tenta no próximo ciclo',
        );
      }
    }
  } catch (e) {
    // Fail-safe global: nunca derruba o worker.
    log.error(
      { err: e instanceof Error ? e.message : String(e) },
      'billing-silence-alert: falha inesperada na varredura — ciclo abortado (worker segue)',
    );
  }

  return result;
}
