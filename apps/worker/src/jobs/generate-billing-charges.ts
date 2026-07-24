/**
 * Job F4 — geracao automatica + reconciliacao + expiracao de cobrancas PIX (ADR 0014, §G).
 *
 * ATRAS DA FLAG `BILLING_DUE_DATE_MODEL`. Com a flag OFF (default), o job e NO-OP: nao le
 * billing, nao instancia gateway, nao toca o banco. Liga so quando o modelo por data esta ON.
 *
 * Roda HORARIO (registrado no worker.ts, BILLING_CRON default '0 * * * *'). Era 1x/dia
 * as 08:00, o que abria um buraco deterministico de ~24h sem PIX pagavel (SCRUM-124):
 * a cobranca vencia e a proxima so nascia no cron do dia seguinte. SEM aviso ao cliente
 * (decisao do Bruno — Fase 4, ainda nao). Conforme ADR 0010: croner over BullMQ.
 *
 * Tres responsabilidades por execucao (idempotente; lock por slot via withBillingSlotLock):
 *
 *  1. GERACAO (com REEMISSAO ANTECIPADA — SCRUM-124): para cada slot cujo estado
 *     (computeBillingState, janela 7) e `a_vencer`/`vencido` -> ensurePixChargeForSlot com
 *     `reissueAheadMs` (= BILLING_REISSUE_AHEAD_MIN). Uma pending cujo expires_at cai DENTRO
 *     da proxima janela de execucao ja e REEMITIDA agora (mesma linha), pra proxima cobranca
 *     nascer ANTES da atual expirar — sem gap. Valor = snapshot client_billing.amount_cents;
 *     pula slot sem amount_cents (loga skip); NAO gera para `em_dia`/`sem_config`. A
 *     idempotencia (1 pending/slot, reusa/reemite a MESMA linha — NUNCA 2a cobranca) vive no
 *     proprio ensurePixChargeForSlot (advisory lock + recheck) — o cron e a tela compartilham
 *     o caminho, sem duplicar. So o cron passa reissueAheadMs>0; o portal mantem 0 (legado).
 *
 *  2. RECONCILIACAO (rede de seguranca p/ webhook perdido): para cada `pending` com
 *     abacate_charge_id, consulta client.getChargeStatus; se o gateway diz PAID e o banco
 *     ainda `pending` -> aplica o MESMO efeito do webhook via applyPaidWebhook (preserva
 *     C1/C2/C4). event_id sintetico DETERMINISTICO `recon:{abacate_charge_id}` -> dedupe
 *     impede efeito duplo se o webhook tambem chegar (ou em reruns do cron).
 *
 *  3. EXPIRACAO: `pending` com expires_at no passado -> marca `expired` (sem deletar; a
 *     proxima geracao reemite reusando a linha).
 *
 * IDEMPOTENCIA: 2 execucoes seguidas nao duplicam cobranca (1 pending/slot) nem efeito de
 * pagamento (dedupe por event_id sintetico estavel + transicao de status no applyPaidWebhook).
 *
 * MULTI-TENANT: `slot` e a tenant key em cada query/log; amount sempre do snapshot do slot.
 * SEGREDO: ABACATEPAY_API_KEY vem do config Zod e e injetada no client; nunca hardcoded/logada.
 */
import { logger } from '@startap/core/logger';
import { billingCharges, billingWebhookEvents, clientBilling } from '@startap/db';
import { abacatepay } from '@startap/integrations';
import { config } from '../config.js';

const log = logger.child({ job: 'generate-billing-charges' });

export interface GenerateBillingResult extends Record<string, unknown> {
  /** true quando a flag estava OFF — o job nao fez nada. */
  skipped: boolean;
  /** slots avaliados na fase de geracao. */
  slotsScanned: number;
  /** cobrancas geradas/reemitidas na janela. */
  generated: number;
  /** slots na janela pulados por nao ter amount_cents. */
  skippedNoAmount: number;
  /** pendentes reconciliadas (gateway PAID, banco estava pending -> aplicado). */
  reconciledPaid: number;
  /** pendentes marcadas expired (expires_at no passado). */
  expired: number;
  /** erros nao-fatais por slot/cobranca (job nao quebra os demais). */
  errors: number;
}

const EMPTY_RESULT: GenerateBillingResult = {
  skipped: true,
  slotsScanned: 0,
  generated: 0,
  skippedNoAmount: 0,
  reconciledPaid: 0,
  expired: 0,
  errors: 0,
};

export async function runGenerateBillingCharges(
  now: Date = new Date(),
  // Janela de reemissao antecipada (ms). Default = BILLING_REISSUE_AHEAD_MIN em ms.
  // Parametrizado pra teste deterministico (sem mexer em env).
  reissueAheadMs: number = config.BILLING_REISSUE_AHEAD_MIN * 60_000,
): Promise<GenerateBillingResult> {
  // ── FLAG OFF -> NO-OP total. Nao le billing, nao instancia gateway, nao toca banco. ──
  if (!config.BILLING_DUE_DATE_MODEL) {
    return { ...EMPTY_RESULT };
  }

  const result: GenerateBillingResult = { ...EMPTY_RESULT, skipped: false };

  // Cliente AbacatePay: instanciado UMA vez. Lanca AbacatePayNotConfiguredError se faltar a
  // chave (feature acionada sem ABACATEPAY_API_KEY) — falha alta e explicita SO aqui, no uso.
  let client: InstanceType<typeof abacatepay.AbacatePayClient>;
  try {
    client = new abacatepay.AbacatePayClient({
      apiKey: config.ABACATEPAY_API_KEY,
      baseUrl: config.ABACATEPAY_BASE_URL,
    });
  } catch (err) {
    if (err instanceof abacatepay.AbacatePayNotConfiguredError) {
      log.error('billing F4 acionado com a flag ON mas SEM ABACATEPAY_API_KEY — abortando job');
      return { ...result, errors: result.errors + 1 };
    }
    throw err;
  }

  // ── (1) GERACAO — itera os slots com billing, gera para os que estao na janela. ──────
  const allBilling = await clientBilling.listBilling();
  result.slotsScanned = allBilling.length;

  for (const billing of allBilling) {
    const { slot } = billing;
    try {
      const { state, podeGerarPix } = clientBilling.computeBillingState(billing.next_due_date, now);
      // So `a_vencer`/`vencido` (dentro da janela). `em_dia`/`sem_config` -> nao gera.
      if (!podeGerarPix || !billing.next_due_date) continue;

      const amountCents = billing.amount_cents ?? 0;
      if (!amountCents || amountCents <= 0) {
        // Slot na janela mas sem valor configurado: pula e loga (operador define no gestao).
        log.warn(
          { event: 'billing-charge-skipped-no-amount', slot, state },
          'slot na janela sem amount_cents — pulado',
        );
        result.skippedNoAmount += 1;
        continue;
      }

      // ensurePixChargeForSlot ja segura o advisory lock por slot + recheck de pending
      // valida: se ja existe pending valida REUSA (idempotencia); senao gera linha nova.
      // `created` cobre geracao nova E reemissao de PIX expirado (mesma linha).
      const { charge, created, reissued } = await abacatepay.ensurePixChargeForSlot(
        client,
        { slot, duePeriod: billing.next_due_date, amountCents, reissueAheadMs },
        now,
      );
      if (created) {
        result.generated += 1;
        log.info(
          { slot, state, chargeId: charge.id, reissued },
          'cobranca PIX gerada/reemitida pelo cron F4',
        );
      }
    } catch (err) {
      result.errors += 1;
      log.error(
        { slot, err: err instanceof Error ? err.message : 'erro' },
        'falha ao gerar cobranca no cron F4 (slot pulado, demais seguem)',
      );
    }
  }

  // ── (2) RECONCILIACAO + (3) EXPIRACAO — varre as pendentes com gateway. ──────────────
  const pendings = await billingCharges.listPendingChargesWithGateway();
  for (const charge of pendings) {
    const { slot } = charge;
    const abacateChargeId = charge.abacate_charge_id;
    if (!abacateChargeId) continue; // defensivo: query ja filtra NOT NULL

    // (3) Expiracao: pending com validade no passado -> expired (sem deletar). Antes da
    // reconciliacao: se ja expirou no gateway tambem, getChargeStatus nao dira PAID.
    if (charge.expires_at && charge.expires_at.getTime() < now.getTime()) {
      try {
        const expiredRow = await billingCharges.markChargeExpired(charge.id, now);
        if (expiredRow) {
          result.expired += 1;
          log.info(
            { slot, chargeId: charge.id },
            'cobranca pending expirada marcada expired (cron F4)',
          );
        }
      } catch (err) {
        result.errors += 1;
        log.error(
          { slot, chargeId: charge.id, err: err instanceof Error ? err.message : 'erro' },
          'falha ao expirar cobranca (cron F4)',
        );
      }
      // Expirada: nao tenta reconciliar (gateway nao paga PIX expirado).
      continue;
    }

    // (2) Reconciliacao: consulta o status no gateway; se PAID e banco ainda pending ->
    // aplica o efeito do webhook (idempotente por event_id sintetico determinístico).
    try {
      const status = await client.getChargeStatus(abacateChargeId);
      if (status.status !== 'paid') continue; // ainda pendente no gateway -> nada a fazer

      // paidAmountCents pode vir null do check (PIX); fallback fail-closed pro snapshot da
      // linha — a reconciliacao de valor (C2) no applyPaidWebhook compara contra o snapshot.
      const paidAmountCents = status.paidAmountCents ?? charge.amount_cents;

      const applied = await billingWebhookEvents.applyPaidWebhook({
        // event_id SINTETICO e ESTAVEL: dedupe impede efeito duplo se o webhook real chegar
        // depois (ou em reruns do cron). Mesmo abacate_charge_id -> mesmo event_id.
        eventId: `recon:${abacateChargeId}`,
        event: 'reconciliation.poll',
        abacateChargeId,
        paidAmountCents,
        // Payload minimo SEM PII (so ids/origem) — coerente com a redacao C5 do webhook.
        redactedPayload: { source: 'cron-f4-reconciliation', abacateChargeId },
        actor: 'cron-f4-reconciliation',
        cycleMonths: 1,
        dueDateModel: true, // flag ON neste caminho -> avanco max(due, hoje)
      });

      if (applied.outcome === 'applied' || applied.outcome === 'underpaid') {
        result.reconciledPaid += 1;
        log.info(
          { slot, chargeId: charge.id, outcome: applied.outcome, resumed: applied.resumed },
          'webhook perdido reconciliado pelo cron F4',
        );
      }
    } catch (err) {
      result.errors += 1;
      log.error(
        { slot, chargeId: charge.id, err: err instanceof Error ? err.message : 'erro' },
        'falha na reconciliacao de cobranca (cron F4, demais seguem)',
      );
    }
  }

  return result;
}
