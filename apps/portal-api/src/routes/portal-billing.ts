/**
 * Rotas de mensalidade/pagamento PIX do Portal do Cliente (ADR 0013, F3).
 *
 * TODAS as rotas passam por withTenant e usam SO requireTenant(req).slot. Nenhuma
 * aceita slot/cycle/chargeId de body/query/params — o cliente nao consegue nem
 * nomear outra cobranca (anti-IDOR, controle C8 do threat-model; regra de ouro 5).
 *
 * GET  /portal/mensalidade          — valor/vencimento (client_billing) + cobranca do ciclo atual.
 * POST /portal/mensalidade/pix      — gera (idempotente) a cobranca PIX do ciclo atual.
 * POST /portal/mensalidade/simular  — Dev-only: dispara simulate-payment no gateway.
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

/** Projeta a linha de cobranca no shape publico (sem snapshot de valor nem ids internos). */
function chargeView(charge: BillingChargeRow | null) {
  if (!charge) return null;
  return {
    cycle: charge.cycle,
    status: charge.status,
    br_code: charge.br_code,
    br_code_base64: charge.br_code_base64,
    expires_at: charge.expires_at ? charge.expires_at.toISOString() : null,
    paid_at: charge.paid_at ? charge.paid_at.toISOString() : null,
  };
}

export const portalBillingRoutes: FastifyPluginAsync = async (app) => {
  // ── Resumo da mensalidade + cobranca do ciclo atual ──────────────────────────
  app.get('/portal/mensalidade', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
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

  // ── Gera (ou reusa, idempotente) a cobranca PIX do ciclo atual ───────────────
  app.post('/portal/mensalidade/pix', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
    const cycle = cicloAtual();

    // Valor vem SO do banco (snapshot). Sem amount configurado -> nao gera PIX.
    const billing = await clientBilling.getBillingBySlot(slot);
    const amountCents = billing?.amount_cents ?? 0;
    if (!amountCents || amountCents <= 0) {
      return reply.code(409).send({ error: 'sem_valor_configurado' });
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
      const { charge } = await abacatepay.ensurePixChargeForCycle(client, {
        slot,
        cycle,
        amountCents,
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
    const cycle = cicloAtual();

    // chargeId vem do slot da sessao (cobranca do ciclo atual), NUNCA de input.
    const charge = await billingCharges.getCharge(slot, cycle);
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
        { slot, cycle, err: err instanceof Error ? err.message : 'erro' },
        'falha ao simular pagamento',
      );
      return reply.code(502).send({ error: 'falha_gateway' });
    }
  });
};
