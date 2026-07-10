/**
 * message-ack-alert — alerta INTERNO de ENTREGA falhando de outbound WhatsApp (SCRUM-58).
 *
 * PROBLEMA: o app é CEGO à entrega. Loga `bot.reply-sent` no HTTP 2xx do WAHA, mas o `ack error:463`
 * (NackCallerReachoutTimelocked) e outros nacks acontecem DEPOIS, no nível do WhatsApp. Resultado:
 * o Bruno perguntou "chegou?" no teste; a Lola ficou 3 DIAS muda sem ninguém saber (SCRUM-55).
 *
 * Com o rastreio ON (base.ts registra o outbound; o router atualiza via evento message.ack), ESTE
 * cron varre os outbounds que:
 *   - receberam NACK TERMINAL (ack -1 / 463), ou
 *   - ficaram PRESOS em PENDING/SERVER (aceitos pelo WAHA mas sem confirmação de ENTREGA ao aparelho)
 *     além do timeout (MESSAGE_ACK_STUCK_MIN) — o caso 463 em que o DEVICE nunca chega;
 * e AVISA o time via ALERTAS. NÃO usa READ (recibo de leitura pode estar desligado — falso-negativo).
 *
 * ANTI-SPAM (o risco real: uma sessão muda por 463 falha TODAS as mensagens):
 *  - AGREGA por SESSÃO — 1 alerta cobre N outbounds falhando naquela sessão;
 *  - COOLDOWN por sessão via alert_states (chave 'msgack:<session>'), default 6h;
 *  - carimba os outbounds da sessão como avisados SÓ APÓS envio bem-sucedido (lição de
 *    client-disconnect-notify: nunca marcar "já avisei" antes do envio → alerta perdido registrado
 *    como enviado). Envio que não sai (sent=0) NÃO carimba → o próximo ciclo re-tenta.
 *
 * GATE: MESSAGE_ACK_TRACKING_ENABLED (default OFF) — checado pelo CHAMADOR (worker.ts) ANTES de
 * registrar o cron. Com OFF este job nem roda.
 *
 * FAIL-SAFE: nunca lança (fire-and-forget pro cron). Falha por-sessão é logada e o loop segue;
 * falha global cai no catch externo. NUNCA derruba o worker. LGPD: zero telefone em claro — só o
 * phone_hint JÁ mascarado (de UM exemplo), slot e contagens.
 */
import { logger } from '@startap/core/logger';
import type { OutboundMessageRow } from '@startap/db';
import { alerts, outboundMessages } from '@startap/db';
import { internalAlert } from '@startap/integrations';

const log = logger.child({ job: 'message-ack-alert' });

export interface MessageAckAlertResult extends Record<string, unknown> {
  /** outbounds alertáveis lidos neste ciclo (nack terminal + presos). */
  scanned: number;
  /** sessões distintas com entrega falhando. */
  sessions: number;
  /** alertas internos ENVIADOS neste ciclo (1 por sessão, agregado). */
  alerted: number;
  /** sessões suprimidas pelo cooldown (avisadas há < janela). */
  cooldownSuppressed: number;
  /** sessões cujo alerta NÃO saiu (sent=0) — não carimbadas, re-tentadas no próximo ciclo. */
  sendFailed: number;
  /** sessões puladas por erro de leitura de estado (fail-closed, re-tentadas no próximo ciclo). */
  stateErrors: number;
  /** linhas de tracking podadas por retenção. */
  pruned: number;
}

const EMPTY: MessageAckAlertResult = {
  scanned: 0,
  sessions: 0,
  alerted: 0,
  cooldownSuppressed: 0,
  sendFailed: 0,
  stateErrors: 0,
  pruned: 0,
};

export interface RunMessageAckAlertOpts {
  /** Janela (min) pra um outbound em PENDING/SERVER ser considerado PRESO. */
  stuckMin: number;
  /** Cooldown (min) por sessão entre alertas da mesma sessão. */
  cooldownMin: number;
  /** Teto de outbounds alertáveis lidos por ciclo. */
  maxPerRun: number;
  /** Retenção (dias) das linhas de tracking. */
  retentionDays: number;
  /** "Agora" injetável (só p/ teste). */
  now?: Date;
}

/** check_key do cooldown por-sessão. Sem PII (usa o nome da sessão). */
export function ackCooldownKey(session: string): string {
  return `msgack:${session}`;
}

interface SessionAggregate {
  session: string;
  slot: string | null;
  total: number;
  nackTerminal: number;
  presos: number;
  sampleHint: string;
  sampleStatus: string;
}

/** Agrega as linhas alertáveis por sessão (pura — testável). O "exemplo" prioriza um nack terminal. */
export function aggregateBySession(rows: OutboundMessageRow[]): SessionAggregate[] {
  const bySession = new Map<string, SessionAggregate>();
  for (const row of rows) {
    let agg = bySession.get(row.session);
    if (!agg) {
      agg = {
        session: row.session,
        slot: row.slot,
        total: 0,
        nackTerminal: 0,
        presos: 0,
        sampleHint: row.phone_hint,
        sampleStatus: row.ack_status,
      };
      bySession.set(row.session, agg);
    }
    agg.total += 1;
    if (row.ack_status === 'ERROR') agg.nackTerminal += 1;
    else agg.presos += 1;
    // Prioriza um ERROR como exemplo (o sinal mais forte); senão mantém o 1º visto.
    if (row.ack_status === 'ERROR' && agg.sampleStatus !== 'ERROR') {
      agg.sampleHint = row.phone_hint;
      agg.sampleStatus = 'ERROR';
    }
    // Primeira linha com slot preenchido define o slot do grupo (rows da mesma sessão ⇒ mesmo clone).
    if (agg.slot == null && row.slot != null) agg.slot = row.slot;
  }
  return [...bySession.values()];
}

export async function runMessageAckAlert(
  opts: RunMessageAckAlertOpts,
): Promise<MessageAckAlertResult> {
  const result: MessageAckAlertResult = { ...EMPTY };
  const now = opts.now ?? new Date();

  try {
    // Retenção primeiro (best-effort; não bloqueia o alerta se falhar).
    try {
      result.pruned = await outboundMessages.pruneOldOutbound(opts.retentionDays);
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'message-ack-alert: falha ao podar linhas antigas (segue)',
      );
    }

    const stuckBefore = new Date(now.getTime() - opts.stuckMin * 60_000);
    const rows = await outboundMessages.listAlertable({ stuckBefore, limit: opts.maxPerRun });
    result.scanned = rows.length;
    if (rows.length === 0) return result;

    const groups = aggregateBySession(rows);
    result.sessions = groups.length;

    for (const group of groups) {
      const key = ackCooldownKey(group.session);

      // Cooldown por-sessão. FAIL-CLOSED em erro de leitura: pula ESTA sessão neste ciclo (não
      // arrisca spam nem carimba às cegas) — o próximo ciclo re-tenta.
      let prev: alerts.AlertStateRow | null;
      try {
        prev = await alerts.getState(key);
      } catch (e) {
        result.stateErrors += 1;
        log.warn(
          { session: group.session, err: e instanceof Error ? e.message : String(e) },
          'message-ack-alert: falha ao ler estado do cooldown — pula sessão (fail-closed)',
        );
        continue;
      }

      const last = prev?.last_alert_at ?? null;
      if (last && now.getTime() - last.getTime() < opts.cooldownMin * 60_000) {
        result.cooldownSuppressed += 1;
        continue;
      }

      const displayName = group.slot
        ? await internalAlert.displayNameForSlot(group.slot)
        : group.session;
      const texto = internalAlert.msgOutboundNaoEntregue({
        session: group.session,
        displayName,
        slot: group.slot,
        total: group.total,
        nackTerminal: group.nackTerminal,
        presos: group.presos,
        sampleHint: group.sampleHint,
        sampleStatus: group.sampleStatus,
      });

      // sendInternalAlert NUNCA lança e retorna { sent }. Carimba (marca outbounds + cooldown) SÓ
      // APÓS sucesso (sent>0) — se não saiu, NÃO carimba, o próximo ciclo re-tenta.
      const { sent } = await internalAlert.sendInternalAlert(texto);
      if (sent > 0) {
        try {
          await outboundMessages.markAlertedForSession({
            session: group.session,
            stuckBefore,
            at: now,
          });
        } catch (e) {
          // Já entregou o alerta; falhar o carimbo só arrisca 1 duplicado no próximo ciclo.
          log.warn(
            { session: group.session, err: e instanceof Error ? e.message : String(e) },
            'message-ack-alert: alerta enviado mas falhou ao marcar outbounds (pode duplicar)',
          );
        }
        try {
          await alerts.upsertState({
            checkKey: key,
            state: 'down', // semântica local: "sessão em episódio de entrega falhando já avisado"
            lastAlertAt: now,
            alertCount: (prev?.alert_count ?? 0) + 1,
          });
        } catch (e) {
          log.warn(
            { session: group.session, err: e instanceof Error ? e.message : String(e) },
            'message-ack-alert: falhou ao carimbar cooldown da sessão (pode duplicar)',
          );
        }
        result.alerted += 1;
      } else {
        result.sendFailed += 1;
        log.warn(
          { session: group.session },
          'message-ack-alert: alerta não entregue (sent=0) — não carimba, re-tenta no próximo ciclo',
        );
      }
    }
  } catch (e) {
    // Fail-safe global: nunca derruba o worker.
    log.error(
      { err: e instanceof Error ? e.message : String(e) },
      'message-ack-alert: falha inesperada na varredura — ciclo abortado (worker segue)',
    );
  }

  return result;
}
