/**
 * billing_webhook_events + processamento transacional do PAID (ADR 0013, F2).
 *
 * Este modulo concentra os controles de seguranca do threat-model que dependem do
 * BANCO (C1, C2, C4). O handler HTTP (apps/api) faz a validacao de assinatura (C3/C6)
 * e a redacao de PII (C5), e chama applyPaidWebhook() — que roda TUDO numa transacao:
 *
 *   1. Descobre o slot candidato SEM row lock; essa leitura nunca autoriza credito.
 *   2. Adquire o advisory transaction lock `billing:<slot>` (ADR 0037).
 *   3. INSERT billing_webhook_events ON CONFLICT (event_id) DO NOTHING  (C4 dedupe)
 *      -> 0 linhas = replay -> retorna { outcome:'duplicate' } e sai (sem reprocessar).
 *   4. Repete SELECT da cobranca FOR UPDATE e revalida slot/status sob o advisory
 *      -> nao achou = orfao -> { outcome:'orphan' }.
 *   5. Se charge.status='paid' ja -> { outcome:'already_paid' } (idempotente).
 *   6. Reconciliacao de valor (C2): se paidAmountCents < charge.amount_cents (SNAPSHOT)
 *      -> marca pago, NAO avanca vencimento, NAO reativa -> { outcome:'underpaid' }.
 *      NOTA: no caso PIX o paidAmountCents pode chegar DERIVADO de `amount` (o gateway
 *      omite paidAmount no transparent.completed do PIX/simulate; o parser faz fallback
 *      fail-closed so pra PIX — ver integrations/abacatepay/webhook.ts). A reconciliacao
 *      aqui e INALTERADA: continua comparando o valor recebido contra o snapshot
 *      amount_cents; pago a menos -> underpaid, independentemente da origem do valor.
 *   7. UPDATE billing_charges SET status='paid', paid_at, paid_amount_cents.
 *   8. Chama o mesmo nucleo in-transaction do pagamento manual: avanca billing a partir
 *      de max(vencimento, hoje) e faz auto-resume (C1) SO para kind='billing'
 *      -> flow_enabled=true, limpa suspended_reason/at/kind, loga resume.
 *      NUNCA reativa outros suspended_kind nem NULL.
 *
 * Tudo na MESMA transacao; advisory, dedupe e transicao de status preservam atomicidade
 * e idempotencia sob retry. `slot` vem SEMPRE do registro de billing_charges casado,
 * nunca de campo livre do payload (anti-spoof do slot).
 */
import { logger } from '@startap/core/logger';
import type { PoolClient } from 'pg';
import { pool, query } from '../client.js';
import {
  acquireBillingSlotAdvisoryLock,
  applyPaymentTransitionInTransaction,
} from './billing-payments.js';
import type { ClientBillingRow } from './client-billing.js';
import { type OperationalSnapshot, getOperationalSnapshotBySlot } from './operational-state.js';

const log = logger.child({ module: 'billing-webhook-events' });

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
  /**
   * true SO no PRIMEIRO pagamento do slot (cliente novo virou pagante): derivado
   * de client_billing.last_payment_at == NULL ANTES deste webhook, lido dentro da
   * mesma transacao (race-free). Renovacao mensal (last_payment_at ja preenchido)
   * vem false. So faz sentido com outcome='applied'; nos demais outcomes e false.
   * Consumido pelo alerta de "cliente NOVO pagou" (NAO alerta renovacao).
   */
  firstPayment: boolean;
  /** Releitura final da transição aplicada; null/ausente nos outcomes sem avanço. */
  billing?: ClientBillingRow | null;
  operational?: OperationalSnapshot | null;
}

export interface ApplyPaidWebhookInput {
  /** envelope.id do evento (dedupe — C4). */
  eventId: string;
  /** tipo do evento (ex 'transparent.completed'). */
  event: string;
  /** id da cobranca no gateway ('pix_char_*') — casa com billing_charges.abacate_charge_id. */
  abacateChargeId: string;
  /**
   * external_id do evento ("{slot}-{ciclo}", estavel entre reemissoes). FALLBACK de
   * casamento (SCRUM-139): usado SO quando o match primario por abacate_charge_id nao
   * acha linha — ex.: uma reemissao (reissueGatewayDataById) sobrescreveu o
   * abacate_charge_id e o cliente pagou o QR VELHO, cujo id ja nao existe no banco.
   * Opcional: ausente/null -> nenhum fallback, mantem o comportamento orphan atual.
   */
  externalId?: string | null;
  /** valor efetivamente pago, em centavos (do payload). */
  paidAmountCents: number;
  /** payload JA REDIGIDO (C5) pelo handler — sem CPF/email/telefone/brCode. */
  redactedPayload: unknown;
  /** quem agiu, pro flow_suspension_log do auto-resume. */
  actor?: string;
  /** meses a avancar (default 1). */
  cycleMonths?: number;
  /** @deprecated Mantido apenas por compatibilidade de caller; ADR 0037 usa sempre max(due, hoje). */
  dueDateModel?: boolean;
}

type ChargeRow = { id: string; slot: string; amount_cents: number; status: string };

async function discoverChargeSlot(
  client: PoolClient,
  input: Pick<ApplyPaidWebhookInput, 'abacateChargeId' | 'externalId'>,
): Promise<string | null> {
  const primary = await client.query<{ slot: string }>(
    'SELECT slot FROM billing_charges WHERE abacate_charge_id = $1 LIMIT 1',
    [input.abacateChargeId],
  );
  if (primary.rows[0]) return primary.rows[0].slot;
  if (!input.externalId) return null;
  const fallback = await client.query<{ slot: string }>(
    `SELECT slot
       FROM billing_charges
      WHERE external_id = $1 AND status = 'pending'
      ORDER BY id DESC
      LIMIT 1`,
    [input.externalId],
  );
  return fallback.rows[0]?.slot ?? null;
}

async function revalidateCharge(
  client: PoolClient,
  input: Pick<ApplyPaidWebhookInput, 'abacateChargeId' | 'externalId'>,
): Promise<ChargeRow | null> {
  const primary = await client.query<ChargeRow>(
    `SELECT id::text AS id, slot, amount_cents, status
       FROM billing_charges
      WHERE abacate_charge_id = $1
      FOR UPDATE`,
    [input.abacateChargeId],
  );
  if (primary.rows[0]) return primary.rows[0];
  if (!input.externalId) return null;
  const fallback = await client.query<ChargeRow>(
    `SELECT id::text AS id, slot, amount_cents, status
       FROM billing_charges
      WHERE external_id = $1
        AND status = 'pending'
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE`,
    [input.externalId],
  );
  return fallback.rows[0] ?? null;
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

    // Descoberta sem row lock: serve SOMENTE para obter a chave do advisory. Toda decisão
    // de crédito usa a releitura FOR UPDATE feita depois do lock.
    const discoveredSlot = await discoverChargeSlot(client, input);
    if (discoveredSlot) {
      await acquireBillingSlotAdvisoryLock(client, discoveredSlot);
    }

    // ── (1) Dedupe atomico (C4). Fica depois do advisory quando há slot conhecido,
    // preservando uma ordem global de locks entre manual/webhook/owner resume.
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
        firstPayment: false,
      };
    }

    // ── (2) Revalida a cobrança sob advisory + FOR UPDATE (C4 race). ─────────────
    const charge = discoveredSlot ? await revalidateCharge(client, input) : null;
    if (charge && charge.slot !== discoveredSlot) {
      throw new Error('billing charge slot changed during revalidation');
    }

    if (!charge) {
      // Orfao: evento sem cobranca casada. Registra (ja inserido) com charge_id NULL
      // e marca processado pra nao reprocessar. 200 no handler (evita retry infinito).
      //
      // WARN, nao info (SCRUM-173/ADR 0039 — condicao do security pra aceitar o risco
      // residual do outbox): se o cliente pagar os DOIS QR codes gerados por uma corrida
      // rara (timeout ambiguo + processo morto antes do timeout de seguranca reabrir a
      // linha), o segundo pagamento cai aqui como orphan e, sem este log, some do nosso
      // lado sem ninguem saber (o canal de alertas pode estar indisponivel). paidAmountCents
      // ajuda a priorizar a revisao manual; SEM PII, SEM br_code, SEM QR — so o valor e o
      // evento (ja redigido pelo handler antes de chegar aqui).
      log.warn(
        {
          alert: 'billing-webhook-orphan',
          event: input.event,
          eventId: input.eventId,
          paidAmountCents: input.paidAmountCents,
        },
        'webhook PIX sem cobranca casada (orphan) — revisar manualmente se houve pagamento duplicado',
      );
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
        firstPayment: false,
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
        firstPayment: false,
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
      const operational = await getOperationalSnapshotBySlot(charge.slot, client);
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
        firstPayment: false,
        operational,
      };
    }

    // ── (6-7) Núcleo compartilhado: max(due, hoje), billing ativo, resume só billing,
    // log condicional e releitura final na mesma transação.
    const transition = await applyPaymentTransitionInTransaction(client, {
      slot: charge.slot,
      actor,
      cycleMonths,
      resumeReason: 'pagamento PIX confirmado',
    });
    if (!transition) throw new Error('paid charge references missing flow clone');

    await client.query(
      'UPDATE billing_webhook_events SET processed_at = NOW() WHERE event_id = $1',
      [input.eventId],
    );

    await client.query('COMMIT');
    return {
      outcome: 'applied',
      slot: charge.slot,
      resumed: transition.resumed,
      amountCents,
      paidAmountCents: input.paidAmountCents,
      firstPayment: transition.firstPayment,
      billing: transition.billing,
      operational: transition.operational,
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
