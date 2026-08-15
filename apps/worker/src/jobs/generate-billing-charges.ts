/**
 * Job F4 — geracao automatica + reconciliacao + expiracao de cobrancas PIX (ADR 0014, §G).
 *
 * ATRAS DA FLAG `BILLING_DUE_DATE_MODEL`. Com a flag OFF (default), o job e NO-OP: nao le
 * billing, nao instancia gateway, nao toca o banco. Liga so quando o modelo por data esta ON.
 *
 * Roda HORARIO (registrado no worker.ts, BILLING_CRON default '0 * * * *'). Era 1x/dia
 * as 08:00, o que abria um buraco deterministico de ~24h sem PIX pagavel (SCRUM-124):
 * a cobranca vencia e a proxima so nascia no cron do dia seguinte. A CADENCIA horaria
 * sozinha ja corta o buraco pra <=1h (a proxima cobranca nasce no cron seguinte a
 * expiracao), com ZERO risco novo. SEM aviso ao cliente (decisao do Bruno — Fase 4, ainda
 * nao). Conforme ADR 0010: croner over BullMQ.
 *
 * Tres responsabilidades por execucao (idempotente; lock por slot via withBillingSlotLock):
 *
 *  1. GERACAO: para cada slot cujo estado (computeBillingState, janela 7) e `a_vencer`/
 *     `vencido` -> ensurePixChargeForSlot. Valor = snapshot client_billing.amount_cents;
 *     pula slot sem amount_cents (loga skip); NAO gera para `em_dia`/`sem_config`. A
 *     idempotencia (1 pending/slot, reusa/reemite a MESMA linha — NUNCA 2a cobranca) vive no
 *     proprio ensurePixChargeForSlot (advisory lock + recheck) — o cron e a tela compartilham
 *     o caminho, sem duplicar.
 *     REEMISSAO ANTECIPADA (reissueAheadMs = BILLING_REISSUE_AHEAD_MIN): fecha a ultima <=1h
 *     reemitindo a pending que expira dentro da proxima janela ANTES do vencimento. A
 *     reemissao abandona o abacate_charge_id antigo (QR velho segue pagavel) — o vetor de
 *     pagamento orfao no QR velho JA ESTA FECHADO pelo FALLBACK por external_id no webhook
 *     (SCRUM-139, PR #497 — casa a linha 'pending' mais recente por external_id, sem orfao
 *     nem duplo-credito). Com a dependencia atendida, o cron liga: BILLING_REISSUE_AHEAD_MIN
 *     default 120 (min). Kill-switch: =0 volta ao legado (so reemite ja expirada). So o cron
 *     passa reissueAheadMs>0; o portal (geracao sob demanda) mantem 0.
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
  /**
   * QRs VELHOS abandonados por reemissao antecipada que sairam PAID no gateway e foram
   * creditados via fallback por external_id (SCRUM-141 — caso "QR velho pago + webhook
   * perdido", invisivel pra reconciliacao normal que so olha o abacate_charge_id vigente).
   */
  recoveredSuperseded: number;
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
  recoveredSuperseded: 0,
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
      // Outbox em voo (SCRUM-173): outra tentativa recente ainda pode confirmar no
      // gateway — nao e erro, e o mecanismo de anti-duplicacao funcionando. Loga em
      // nivel mais baixo e NAO conta como erro operacional (a proxima execucao horaria
      // resolve sozinha).
      if (err instanceof billingCharges.PixChargeGatewayInFlightError) {
        log.info({ slot }, 'chamada ao gateway em voo (outbox) — pulado nesta execucao');
        continue;
      }
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

    // (2a) RECUPERACAO DE QR VELHO (SCRUM-141) — ANTES de expirar/reconciliar o vigente.
    // A reemissao antecipada abandona o abacate_charge_id antigo (QR velho segue pagavel);
    // a reconciliacao normal so olha o VIGENTE, entao um "QR velho pago + webhook perdido"
    // fica invisivel. Aqui pollamos cada id abandonado no gateway; se algum saiu PAID,
    // creditamos via applyPaidWebhook usando o external_id como FALLBACK (casa a linha
    // 'pending' vigente — mesma trava anti-duplo-credito do webhook, SCRUM-139). Dedupe por
    // event_id 'recon:<id>'. Feito primeiro: se creditar de fato (outcome 'applied'), a linha
    // vira 'paid' e nao deve mais expirar nem reconciliar o QR vigente -> `continue`.
    //
    // FIX (security review #517, 25/07): `underpaid` NAO pode dar `continue`. underpaid marca
    // a linha 'paid' mas NAO avanca next_due_date/reativa (C2, ver applyPaidWebhook) — e o QR
    // VIGENTE pode ter sido pago integralmente em paralelo. Se pularmos a reconciliacao do
    // vigente aqui, a linha ja esta 'paid' e listPendingChargesWithGateway (filtra
    // status='pending') NUNCA MAIS a recupera: o pagamento do vigente some do nosso lado, sem
    // alerta, e o gate de silencio cala o bot sem ninguem entender por que. So `applied`
    // encerra o loop; `underpaid` segue pra reconciliacao do vigente (pode aplicar outro
    // credito, inclusive avancando o vencimento que o underpaid do velho nao avancou).
    const supersededIds = charge.superseded_charge_ids ?? [];
    let recovered = false;
    for (const oldId of supersededIds) {
      try {
        const oldStatus = await client.getChargeStatus(oldId);
        if (oldStatus.status !== 'paid') continue;
        const paidAmountCents = oldStatus.paidAmountCents ?? charge.amount_cents;
        const applied = await billingWebhookEvents.applyPaidWebhook({
          // event_id determinístico por id ABANDONADO — nao colide com o recon do vigente
          // nem com o webhook real; dedupe impede efeito duplo em reruns.
          eventId: `recon:${oldId}`,
          event: 'reconciliation.poll.superseded',
          abacateChargeId: oldId,
          // FALLBACK: o oldId nao esta mais em abacate_charge_id (foi sobrescrito). O
          // external_id ("{slot}-{ciclo}", estavel) casa a linha 'pending' vigente.
          externalId: charge.external_id,
          paidAmountCents,
          redactedPayload: { source: 'cron-f4-superseded-recovery', abacateChargeId: oldId },
          actor: 'cron-f4-superseded-recovery',
          cycleMonths: 1,
          dueDateModel: true,
        });
        if (applied.outcome === 'underpaid') {
          // C2: pago a MENOS que o snapshot. Marcou pago mas NAO avancou/reativou. Mesmo
          // alerta do handler HTTP (apps/api/src/routes/webhook-abacatepay.ts) — paridade:
          // o cron tambem credita pagamento e o operador precisa saber pra tratar manual.
          result.recoveredSuperseded += 1;
          log.error(
            {
              alert: 'billing-underpaid',
              slot,
              chargeId: charge.id,
              oldChargeId: oldId,
              expectedCents: applied.amountCents,
              paidCents: applied.paidAmountCents,
              eventId: `recon:${oldId}`,
            },
            'PAGAMENTO PIX ABAIXO DO VALOR (QR velho, cron F4) — vencimento NAO avancado, fluxo NAO reativado. Revisar manual.',
          );
          // NAO break/continue: o vigente pode ter sido pago integralmente — segue avaliando.
        } else if (applied.outcome === 'applied') {
          result.recoveredSuperseded += 1;
          recovered = true;
          log.info(
            { slot, chargeId: charge.id, oldChargeId: oldId, outcome: applied.outcome },
            'QR velho (reemissao antecipada) pago + webhook perdido recuperado pelo cron F4',
          );
          break; // linha ja creditada (e avancada) — nao polla os demais ids abandonados
        }
      } catch (err) {
        result.errors += 1;
        log.error(
          { slot, chargeId: charge.id, err: err instanceof Error ? err.message : 'erro' },
          'falha ao recuperar QR velho superseded (cron F4, demais seguem)',
        );
      }
    }
    // Creditado pelo QR velho: a linha nao e mais pending -> nao expira nem reconcilia.
    if (recovered) continue;

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

      if (applied.outcome === 'underpaid') {
        // Paridade com o handler HTTP (webhook-abacatepay.ts): mesmo alerta, mesmo
        // outcome — o cron tambem credita pagamento abaixo do valor, e sem isto o
        // operador nunca saberia que o vencimento NAO avancou por este caminho.
        result.reconciledPaid += 1;
        log.error(
          {
            alert: 'billing-underpaid',
            slot,
            chargeId: charge.id,
            expectedCents: applied.amountCents,
            paidCents: applied.paidAmountCents,
            eventId: `recon:${abacateChargeId}`,
          },
          'PAGAMENTO PIX ABAIXO DO VALOR (reconciliacao, cron F4) — vencimento NAO avancado, fluxo NAO reativado. Revisar manual.',
        );
      } else if (applied.outcome === 'applied') {
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
