/**
 * Rotas de mensalidade/pagamento PIX do Portal do Cliente (ADR 0013, F3; ADR 0014).
 *
 * TODAS as rotas passam por withTenant e usam SO requireTenant(req).slot. Nenhuma
 * aceita slot/cycle/chargeId de body/query/params — o cliente nao consegue nem
 * nomear outra cobranca (anti-IDOR, controle C8 do threat-model; regra de ouro 5).
 *
 * GET  /portal/mensalidade          — valor/vencimento (client_billing) + cobranca.
 * POST /portal/mensalidade/pix      — gera (idempotente) a cobranca PIX.
 * POST /portal/mensalidade/simular  — Dev-only: dispara simulate-payment no gateway.
 *
 * DOIS MODELOS atras da flag config.BILLING_DUE_DATE_MODEL (ADR 0014):
 *   - OFF (default, PRODUCAO): cobranca por ciclo de mes (cicloAtual). GET retorna a
 *     cobranca do mes; POST sempre gera/reusa. Comportamento ATUAL intacto.
 *   - ON: cobranca por DATA DE VENCIMENTO. GET retorna `state` (computeBillingState) +
 *     a cobranca ATIVA do slot; so gera/exibe PIX na JANELA (a_vencer/vencido). Em dia
 *     -> charge=null, state='em_dia'. POST fora da janela -> 409 fora_da_janela.
 *
 * O valor (amount_cents) vem SEMPRE de client_billing (snapshot do banco), nunca de
 * input. O efeito de marcar pago/renovar e responsabilidade do WEBHOOK async (F2).
 */
import { logger } from '@startap/core/logger';
import { type BillingChargeRow, billingCharges, clientBilling } from '@startap/db';
import { abacatepay } from '@startap/integrations';
import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { requireTenant, withTenant } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'billing' });

/**
 * Ciclo corrente 'YYYY-MM' no fuso America/Sao_Paulo. Determina a virada de mes pelo
 * horario do Brasil (nao UTC) — alinhado com a convencao de geracao do cron (D2).
 */
export function cicloAtual(now = new Date()): string {
  // pt-BR + timeZone garante ano/mes no fuso local; formatamos como YYYY-MM.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const month = parts.find((p) => p.type === 'month')?.value ?? '00';
  return `${year}-${month}`;
}

/** true se a chave configurada e Dev (abc_dev_*). Define o modo da feature (ADR 0013). */
function isDevKey(): boolean {
  return config.ABACATEPAY_API_KEY?.startsWith('abc_dev_') === true;
}

/**
 * Projeta a linha de cobranca no shape publico (sem snapshot de valor nem ids internos).
 *
 * is_expired: true SO quando a cobranca esta 'pending' e a validade ja passou (relativo a
 * `now`). Da ao front um sinal explicito de "esse QR nao vale mais" sem ele precisar
 * comparar datas no cliente (relogio do navegador). 'paid' nunca e expirada.
 */
function chargeView(charge: BillingChargeRow | null, now = new Date()) {
  if (!charge) return null;
  const isExpired =
    charge.status === 'pending' &&
    charge.expires_at != null &&
    charge.expires_at.getTime() <= now.getTime();
  return {
    cycle: charge.cycle,
    status: charge.status,
    br_code: charge.br_code,
    br_code_base64: charge.br_code_base64,
    expires_at: charge.expires_at ? charge.expires_at.toISOString() : null,
    paid_at: charge.paid_at ? charge.paid_at.toISOString() : null,
    is_expired: isExpired,
  };
}

export const portalBillingRoutes: FastifyPluginAsync = async (app) => {
  // ── Resumo da mensalidade + cobranca ─────────────────────────────────────────
  app.get('/portal/mensalidade', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);

    // ── Modelo por DATA DE VENCIMENTO (ADR 0014, flag ON) ──────────────────────
    if (config.BILLING_DUE_DATE_MODEL) {
      const billing = await clientBilling.getBillingBySlot(slot);
      const { state, diasRestantes, podeGerarPix } = clientBilling.computeBillingState(
        billing?.next_due_date ?? null,
      );
      // Cobranca ATIVA do slot = pending nao-expirada mais recente. So expomos a cobranca
      // quando estamos na janela (a_vencer/vencido); em dia/sem_config -> charge=null.
      const charge = podeGerarPix ? await billingCharges.getActivePendingCharge(slot) : null;

      return reply.code(200).send({
        model: 'due_date',
        state,
        amount_cents: billing?.amount_cents ?? null,
        next_due_date: billing?.next_due_date ?? null,
        dias_restantes: diasRestantes,
        billing_status: billing?.status ?? null,
        pode_gerar_pix: podeGerarPix,
        charge: chargeView(charge),
        dev_mode: isDevKey(),
      });
    }

    // ── Modelo legado por ciclo de mes (flag OFF, PRODUCAO) ────────────────────
    const cycle = cicloAtual();
    const [billing, charge] = await Promise.all([
      clientBilling.getBillingBySlot(slot),
      billingCharges.getCharge(slot, cycle),
    ]);

    return reply.code(200).send({
      amount_cents: billing?.amount_cents ?? null,
      next_due_date: billing?.next_due_date ?? null,
      dias_restantes: billing ? clientBilling.daysUntilDue(billing.next_due_date) : null,
      billing_status: billing?.status ?? null,
      charge: chargeView(charge),
      dev_mode: isDevKey(),
    });
  });

  // ── Gera (ou reusa, idempotente) a cobranca PIX ──────────────────────────────
  app.post('/portal/mensalidade/pix', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);

    // Valor vem SO do banco (snapshot). Sem amount configurado -> nao gera PIX.
    const billing = await clientBilling.getBillingBySlot(slot);
    const amountCents = billing?.amount_cents ?? 0;
    if (!amountCents || amountCents <= 0) {
      return reply.code(409).send({ error: 'sem_valor_configurado' });
    }

    // ── Modelo por DATA DE VENCIMENTO (ADR 0014, flag ON) ──────────────────────
    if (config.BILLING_DUE_DATE_MODEL) {
      // 1) Checa a JANELA. Fora dela (em dia / sem vencimento) -> NAO gera (sem
      // antecipacao na v1). 409 fora_da_janela: a tela trata como "em dia, sem PIX".
      const { state, podeGerarPix } = clientBilling.computeBillingState(
        billing?.next_due_date ?? null,
      );
      if (!podeGerarPix || !billing?.next_due_date) {
        return reply.code(409).send({ error: 'fora_da_janela', state });
      }

      let client: InstanceType<typeof abacatepay.AbacatePayClient>;
      try {
        client = new abacatepay.AbacatePayClient({
          apiKey: config.ABACATEPAY_API_KEY,
          baseUrl: config.ABACATEPAY_BASE_URL,
        });
      } catch (err) {
        if (err instanceof abacatepay.AbacatePayNotConfiguredError) {
          log.warn({ slot }, 'pagamento acionado sem ABACATEPAY_API_KEY configurada');
          return reply.code(503).send({ error: 'pagamento_indisponivel' });
        }
        throw err;
      }

      try {
        // duePeriod = next_due_date vigente. Re-cobranca (data movida pro passado) cai
        // aqui na janela e, como a `paid` antiga nao colide mais (sem UNIQUE), gera linha
        // nova. Advisory lock + recheck garante 1 pending por slot (duas abas/cliques).
        const { charge } = await abacatepay.ensurePixChargeForSlot(client, {
          slot,
          duePeriod: billing.next_due_date,
          amountCents,
        });
        return reply.code(200).send(chargeView(charge));
      } catch (err) {
        log.error(
          { slot, err: err instanceof Error ? err.message : 'erro' },
          'falha ao gerar cobranca PIX (modelo por data)',
        );
        return reply.code(502).send({ error: 'falha_gateway' });
      }
    }

    // ── Modelo legado por ciclo de mes (flag OFF, PRODUCAO) ────────────────────
    const cycle = cicloAtual();

    let client: InstanceType<typeof abacatepay.AbacatePayClient>;
    try {
      client = new abacatepay.AbacatePayClient({
        apiKey: config.ABACATEPAY_API_KEY,
        baseUrl: config.ABACATEPAY_BASE_URL,
      });
    } catch (err) {
      if (err instanceof abacatepay.AbacatePayNotConfiguredError) {
        log.warn({ slot }, 'pagamento acionado sem ABACATEPAY_API_KEY configurada');
        return reply.code(503).send({ error: 'pagamento_indisponivel' });
      }
      throw err;
    }

    try {
      // reissueIfExpired: garante que o cliente sempre receba um PIX pagavel. Se a cobranca
      // do ciclo ja existe mas expirou, reemite REUSANDO a mesma linha (slot, cycle) — sem
      // duplicar cobranca no gateway. Cobranca paga e devolvida como esta (front mostra "pago").
      const { charge } = await abacatepay.ensurePixChargeForCycle(client, {
        slot,
        cycle,
        amountCents,
        reissueIfExpired: true,
      });
      return reply.code(200).send(chargeView(charge));
    } catch (err) {
      log.error(
        { slot, cycle, err: err instanceof Error ? err.message : 'erro' },
        'falha ao gerar cobranca PIX',
      );
      return reply.code(502).send({ error: 'falha_gateway' });
    }
  });

  // ── Dev-only: dispara simulate-payment no gateway (exercita o webhook real) ───
  app.post('/portal/mensalidade/simular', { preHandler: withTenant }, async (req, reply) => {
    // GUARD: so ambiente Dev (chave abc_dev_*). Em Prod a rota nem age.
    if (!isDevKey()) {
      return reply.code(403).send({ error: 'simulacao_indisponivel' });
    }

    const { slot } = requireTenant(req);

    // chargeId vem do slot da sessao, NUNCA de input. No modelo por data (ADR 0014) a
    // cobranca alvo e a ATIVA do slot; no legado, a do ciclo do mes corrente.
    const charge = config.BILLING_DUE_DATE_MODEL
      ? await billingCharges.getActivePendingCharge(slot)
      : await billingCharges.getCharge(slot, cicloAtual());
    if (!charge?.abacate_charge_id) {
      return reply.code(409).send({ error: 'sem_cobranca' });
    }

    let client: InstanceType<typeof abacatepay.AbacatePayClient>;
    try {
      client = new abacatepay.AbacatePayClient({
        apiKey: config.ABACATEPAY_API_KEY,
        baseUrl: config.ABACATEPAY_BASE_URL,
      });
    } catch (err) {
      if (err instanceof abacatepay.AbacatePayNotConfiguredError) {
        return reply.code(503).send({ error: 'pagamento_indisponivel' });
      }
      throw err;
    }

    try {
      await client.simulatePayment(charge.abacate_charge_id);
      // O efeito real (pago/renovacao) chega pelo WEBHOOK async — aqui so disparamos.
      return reply.code(200).send({ simulated: true });
    } catch (err) {
      log.error(
        { slot, cycle: charge.cycle, err: err instanceof Error ? err.message : 'erro' },
        'falha ao simular pagamento',
      );
      return reply.code(502).send({ error: 'falha_gateway' });
    }
  });
};
