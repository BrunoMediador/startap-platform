/**
 * billing_webhook_events + processamento transacional do PAID (ADR 0013, F2).
 *
 * Este modulo concentra os controles de seguranca do threat-model que dependem do
 * BANCO (C1, C2, C4). O handler HTTP (apps/api) faz a validacao de assinatura (C3/C6)
 * e a redacao de PII (C5), e chama applyPaidWebhook() — que roda TUDO numa transacao:
 *
 *   1. INSERT billing_webhook_events ON CONFLICT (event_id) DO NOTHING  (C4 dedupe)
 *      -> 0 linhas = replay -> retorna { outcome:'duplicate' } e sai (sem reprocessar).
 *   2. SELECT ... FROM billing_charges WHERE abacate_charge_id = $ FOR UPDATE  (C4 race)
 *      -> nao achou = orfao -> { outcome:'orphan' }.
 *   3. Se charge.status='paid' ja -> { outcome:'already_paid' } (idempotente).
 *   4. Reconciliacao de valor (C2): se paidAmountCents < charge.amount_cents (SNAPSHOT)
 *      -> marca pago, NAO avanca vencimento, NAO reativa -> { outcome:'underpaid' }.
 *      NOTA: no caso PIX o paidAmountCents pode chegar DERIVADO de `amount` (o gateway
 *      omite paidAmount no transparent.completed do PIX/simulate; o parser faz fallback
 *      fail-closed so pra PIX — ver integrations/abacatepay/webhook.ts). A reconciliacao
 *      aqui e INALTERADA: continua comparando o valor recebido contra o snapshot
 *      amount_cents; pago a menos -> underpaid, independentemente da origem do valor.
 *   5. UPDATE billing_charges SET status='paid', paid_at, paid_amount_cents.
 *   6. Avanca client_billing.next_due_date +1 mes (mesma logica do register_payment).
 *   7. Auto-resume (C1): SO se flow_enabled=false E suspended_kind='billing'
 *      -> flow_enabled=true, limpa suspended_reason/at/kind, loga resume.
 *      NUNCA reativa outros suspended_kind nem NULL.
 *
 * Tudo na MESMA transacao, guardado pela transicao de status (5) — idempotente sob
 * retry. `slot` vem SEMPRE do registro de billing_charges casado, nunca de campo
 * livre do payload (anti-spoof do slot).
 */
import { pool, query } from '../client.js';
import { advanceDueDate } from './client-billing.js';

export interface BillingWebhookEventRow {
  event_id: string;
  event: string;
  charge_id: string | null;
  received_at: Date;
  processed_at: Date | null;
  payload: unknown;
}

/** Resultado do processamento — dirige o status HTTP e o log no handler. */
export type PaidWebhookOutcome =
  | 'duplicate' // replay: event_id ja processado (C4)
  | 'orphan' // nenhuma cobranca casada por abacate_charge_id
  | 'already_paid' // cobranca ja estava 'paid' (idempotente)
  | 'underpaid' // pago < snapshot: marcou pago mas NAO avancou/reativou (C2)
  | 'applied'; // pago >= snapshot: avancou vencimento e (talvez) reativou

export interface PaidWebhookResult {
  outcome: PaidWebhookOutcome;
  slot: string | null;
  /** true se o auto-resume levantou a suspensao de cobranca (C1). */
  resumed: boolean;
  /** snapshot congelado da cobranca (centavos) — pra alerta de underpaid. */
  amountCents: number | null;
  paidAmountCents: number | null;
}

export interface ApplyPaidWebhookInput {
  /** envelope.id do evento (dedupe — C4). */
  eventId: string;
  /** tipo do evento (ex 'transparent.completed'). */
  event: string;
  /** id da cobranca no gateway ('pix_char_*') — casa com billing_charges.abacate_charge_id. */
  abacateChargeId: string;
  /** valor efetivamente pago, em centavos (do payload). */
  paidAmountCents: number;
  /** payload JA REDIGIDO (C5) pelo handler — sem CPF/email/telefone/brCode. */
  redactedPayload: unknown;
  /** quem agiu, pro flow_suspension_log do auto-resume. */
  actor?: string;
  /** meses a avancar (default 1). */
  cycleMonths?: number;
}

/**
 * Processa um webhook PAID de forma TRANSACIONAL e idempotente (C1/C2/C4).
 *
 * Pre-condicao: a ASSINATURA ja foi validada (C3/C6) e o payload ja foi REDIGIDO
 * (C5) pelo handler. Aqui so toca o banco.
 */
export async function applyPaidWebhook(input: ApplyPaidWebhookInput): Promise<PaidWebhookResult> {
  const cycleMonths = input.cycleMonths ?? 1;
  const actor = input.actor ?? 'abacatepay-webhook';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── (1) Dedupe atomico (C4). 0 linhas = replay -> sai. ──────────────────────
    const dedupe = await client.query<{ event_id: string }>(
      `INSERT INTO billing_webhook_events (event_id, event, payload, received_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [input.eventId, input.event, JSON.stringify(input.redactedPayload ?? null)],
    );
    if (dedupe.rowCount === 0) {
      // Replay: ja processado. Commit no-op e sai.
      await client.query('COMMIT');
      return {
        outcome: 'duplicate',
        slot: null,
        resumed: false,
        amountCents: null,
        paidAmountCents: input.paidAmountCents,
      };
    }

    // ── (2) Casa a cobranca por abacate_charge_id, com FOR UPDATE (C4 race). ─────
    const chargeRes = await client.query<{
      id: string;
      slot: string;
      amount_cents: number;
      status: string;
    }>(
      `SELECT id::text AS id, slot, amount_cents, status
         FROM billing_charges
        WHERE abacate_charge_id = $1
        FOR UPDATE`,
      [input.abacateChargeId],
    );
    const charge = chargeRes.rows[0];
    if (!charge) {
      // Orfao: evento sem cobranca casada. Registra (ja inserido) com charge_id NULL
      // e marca processado pra nao reprocessar. 200 no handler (evita retry infinito).
      await client.query(
        'UPDATE billing_webhook_events SET processed_at = NOW() WHERE event_id = $1',
        [input.eventId],
      );
      await client.query('COMMIT');
      return {
        outcome: 'orphan',
        slot: null,
        resumed: false,
        amountCents: null,
        paidAmountCents: input.paidAmountCents,
      };
    }

    // Liga o evento a cobranca encontrada (forense).
    await client.query('UPDATE billing_webhook_events SET charge_id = $1 WHERE event_id = $2', [
      charge.id,
      input.eventId,
    ]);

    const amountCents = charge.amount_cents;

    // ── (3) Ja pago? Idempotente — sai sem efeito duplo. ────────────────────────
    if (charge.status === 'paid') {
      await client.query(
        'UPDATE billing_webhook_events SET processed_at = NOW() WHERE event_id = $1',
        [input.eventId],
      );
      await client.query('COMMIT');
      return {
        outcome: 'already_paid',
        slot: charge.slot,
        resumed: false,
        amountCents,
        paidAmountCents: input.paidAmountCents,
      };
    }

    // ── (4) Reconciliacao de valor (C2). Underpaid -> marca pago, NAO avanca. ────
    const underpaid = input.paidAmountCents < amountCents;

    // ── (5) Marca a cobranca como paga (transicao que guarda a idempotencia). ───
    // NAO grava receipt_url: a URL do recibo nao e necessaria pra confirmar/renovar/
    // reativar e a coluna nao existe em billing_charges (041/042). O receiptUrl continua
    // redigido no payload bruto do evento (billing_webhook_events) — nunca persistido aqui.
    await client.query(
      `UPDATE billing_charges
          SET status            = 'paid',
              paid_at           = NOW(),
              paid_amount_cents = $2,
              updated_at        = NOW()
        WHERE id = $1`,
      [charge.id, input.paidAmountCents],
    );

    if (underpaid) {
      // C2: pago a menos. NAO avanca vencimento, NAO reativa. Handler alerta o Bruno.
      await client.query(
        'UPDATE billing_webhook_events SET processed_at = NOW() WHERE event_id = $1',
        [input.eventId],
      );
      await client.query('COMMIT');
      return {
        outcome: 'underpaid',
        slot: charge.slot,
        resumed: false,
        amountCents,
        paidAmountCents: input.paidAmountCents,
      };
    }

    // ── (6) Avanca o vencimento (mesma logica do register_payment). ─────────────
    // Le o vencimento atual DENTRO da transacao e avanca +cycleMonths. Se nao havia
    // next_due_date, parte de hoje (UTC). Calculo deterministico via advanceDueDate.
    const billingRes = await client.query<{ next_due_date: string | null }>(
      `SELECT to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date
         FROM client_billing WHERE slot = $1 FOR UPDATE`,
      [charge.slot],
    );
    const base = billingRes.rows[0]?.next_due_date ?? new Date().toISOString().slice(0, 10);
    const newDue = advanceDueDate(base, cycleMonths);

    await client.query(
      `INSERT INTO client_billing (slot, next_due_date, status, last_payment_at, created_at, updated_at)
       VALUES ($1, $2, 'active', NOW(), NOW(), NOW())
       ON CONFLICT (slot) DO UPDATE SET
         next_due_date   = $2,
         status          = 'active',
         last_payment_at = NOW(),
         updated_at      = NOW()`,
      [charge.slot, newDue],
    );

    // ── (7) Auto-resume (C1): SO se suspenso por billing. ───────────────────────
    // UPDATE condicional: flow_enabled=false E suspended_kind='billing'. Qualquer
    // outro kind (owner_request/manual_other/abuse) ou NULL nao casa o WHERE — 0
    // linhas, nenhuma reativacao. Anti-falso-resume na propria query (sem string-match).
    const resumeRes = await client.query<{ slot: string }>(
      `UPDATE flow_clones
          SET flow_enabled     = true,
              suspended_reason = NULL,
              suspended_at     = NULL,
              suspended_kind   = NULL,
              updated_at       = NOW()
        WHERE slot = $1
          AND flow_enabled = false
          AND suspended_kind = 'billing'
        RETURNING slot`,
      [charge.slot],
    );
    const resumed = (resumeRes.rowCount ?? 0) > 0;

    if (resumed) {
      await client.query(
        `INSERT INTO flow_suspension_log (slot, action, reason, actor)
         VALUES ($1, 'resume', 'pagamento PIX confirmado', $2)`,
        [charge.slot, actor],
      );
    }

    await client.query(
      'UPDATE billing_webhook_events SET processed_at = NOW() WHERE event_id = $1',
      [input.eventId],
    );

    await client.query('COMMIT');
    return {
      outcome: 'applied',
      slot: charge.slot,
      resumed,
      amountCents,
      paidAmountCents: input.paidAmountCents,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Le um evento de webhook ja processado (auditoria/testes). null se nao existe. */
export async function getWebhookEvent(eventId: string): Promise<BillingWebhookEventRow | null> {
  const r = await query<BillingWebhookEventRow>(
    `SELECT event_id, event, charge_id::text AS charge_id, received_at, processed_at, payload
       FROM billing_webhook_events WHERE event_id = $1`,
    [eventId],
  );
  return r.rows[0] ?? null;
}
