/**
 * Servico de geracao/obtencao idempotente de cobranca PIX por (slot, ciclo).
 *
 * ADR 0013 / F1. Reune o cliente AbacatePay (@startap/integrations) com a persistencia
 * (@startap/db billing_charges). NAO expoe endpoint publico — e chamavel internamente
 * (F4 cron, scripts de smoke, testes). O portal do cliente e F3.
 *
 * Idempotencia (controle do threat-model):
 *   - UNIQUE (slot, cycle) no banco barra duplicacao de geracao.
 *   - "Cria se nao existe": 2a chamada do mesmo (slot, cycle) retorna a cobranca
 *     existente, sem chamar o gateway de novo.
 *
 * Snapshot do valor: amountCents vem de client_billing.amount_cents NO MOMENTO da
 * geracao e e congelado em billing_charges.amount_cents. Pagamento (F2) confere
 * contra o snapshot, nunca contra client_billing em tempo de pagamento.
 */
import { logger } from '@startap/core/logger';
import { type BillingChargeRow, billingCharges } from '@startap/db';
import type { AbacatePayClient } from './client.js';

const log = logger.child({ module: 'abacatepay-service' });

/** Validade default do PIX: 3 dias (em segundos). Ajustavel pelo chamador. */
const DEFAULT_EXPIRES_IN_SEC = 3 * 24 * 60 * 60;
/** AbacatePay limita description (v1: 37 chars). Mantemos curto e seguro. */
const DESCRIPTION_MAX = 37;

export interface EnsureChargeInput {
  slot: string;
  cycle: string; // 'YYYY-MM'
  /** Snapshot do valor do ciclo, em CENTAVOS. Vem de client_billing.amount_cents. */
  amountCents: number;
  /** Texto curto exibido no PIX. Default 'Mensalidade {cycle}'. */
  description?: string;
  expiresInSec?: number;
}

export interface EnsureChargeResult {
  charge: BillingChargeRow;
  /** true se gerou no gateway agora; false se ja existia (idempotencia). */
  created: boolean;
}

/**
 * Garante UMA cobranca PIX por (slot, ciclo). Cria no AbacatePay e persiste se ainda
 * nao existir; se ja existir, retorna a existente sem chamar o gateway.
 *
 * Caso de borda tratado: a linha pode existir 'pending' SEM dados do gateway (uma
 * geracao anterior inseriu mas falhou na chamada externa). Nesse caso completa a
 * chamada ao gateway agora — idempotente, sem duplicar a linha.
 */
export async function ensurePixChargeForCycle(
  abacate: AbacatePayClient,
  input: EnsureChargeInput,
): Promise<EnsureChargeResult> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error(
      `ensurePixChargeForCycle: amountCents invalido (${input.amountCents}) — esperado inteiro > 0`,
    );
  }

  const externalId = `${input.slot}-${input.cycle}`;

  // 1) Reserva a linha (idempotencia de banco via UNIQUE slot,cycle).
  const { row, created } = await billingCharges.insertPendingChargeIfAbsent({
    slot: input.slot,
    cycle: input.cycle,
    externalId,
    amountCents: input.amountCents,
  });

  // Ja existe E ja tem cobranca no gateway -> retorna como esta (nao duplica).
  if (!created && row.abacate_charge_id) {
    log.info({ slot: input.slot, cycle: input.cycle }, 'cobranca ja existente — reuso');
    return { charge: row, created: false };
  }

  // Linha existe mas sem dados do gateway (nova, ou geracao anterior falhou na API):
  // completa a chamada ao AbacatePay agora.
  const description = (input.description ?? `Mensalidade ${input.cycle}`).slice(0, DESCRIPTION_MAX);

  const pix = await abacate.createPixCharge({
    slot: input.slot,
    cycle: input.cycle,
    // Usa o SNAPSHOT ja gravado na linha — nunca re-le client_billing aqui.
    amountCents: row.amount_cents,
    description,
    expiresInSec: input.expiresInSec ?? DEFAULT_EXPIRES_IN_SEC,
  });

  const updated = await billingCharges.attachGatewayData({
    slot: input.slot,
    cycle: input.cycle,
    abacateChargeId: pix.id,
    brCode: pix.brCode,
    brCodeBase64: pix.brCodeBase64,
    expiresAt: pix.expiresAt ? new Date(pix.expiresAt) : null,
  });

  log.info(
    { slot: input.slot, cycle: input.cycle, abacateChargeId: pix.id },
    'cobranca PIX gerada no gateway',
  );

  return { charge: updated ?? row, created: true };
}
