/**
 * billing_charges — ledger das cobrancas PIX geradas no gateway (ADR 0013, F1).
 *
 * 1 cobranca por (slot, ciclo). amount_cents e SNAPSHOT congelado do ciclo.
 * UNIQUE (slot, cycle) garante idempotencia de geracao no banco.
 *
 * Este modulo so persiste/le. A orquestracao (chamar AbacatePay + gravar) vive no
 * servico em @startap/integrations/abacatepay (que ja depende deste package).
 *
 * `slot` e a tenant key — entra no escopo da futura RLS (divida P0, ver migration 041).
 */
import { query } from '../client.js';

export type ChargeStatus = 'pending' | 'paid' | 'expired' | 'cancelled';

export interface BillingChargeRow {
  id: string; // BIGSERIAL — pg retorna BIGINT como string
  slot: string;
  cycle: string; // 'YYYY-MM'
  external_id: string;
  abacate_charge_id: string | null;
  amount_cents: number; // snapshot congelado
  paid_amount_cents: number | null;
  status: ChargeStatus;
  br_code: string | null;
  br_code_base64: string | null;
  expires_at: Date | null;
  paid_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id::text AS id, slot, cycle, external_id, abacate_charge_id,
  amount_cents, paid_amount_cents, status, br_code, br_code_base64,
  expires_at, paid_at, created_at, updated_at`;

/** Le a cobranca de um (slot, ciclo). null se nao existe. */
export async function getCharge(slot: string, cycle: string): Promise<BillingChargeRow | null> {
  const r = await query<BillingChargeRow>(
    `SELECT ${COLUMNS} FROM billing_charges WHERE slot = $1 AND cycle = $2`,
    [slot, cycle],
  );
  return r.rows[0] ?? null;
}

/** Lista cobrancas de um slot (mais recentes primeiro). Painel/portal nas fases seguintes. */
export async function listChargesBySlot(slot: string): Promise<BillingChargeRow[]> {
  const r = await query<BillingChargeRow>(
    `SELECT ${COLUMNS} FROM billing_charges WHERE slot = $1
     ORDER BY cycle DESC, id DESC`,
    [slot],
  );
  return r.rows;
}

/**
 * Insere a linha da cobranca em estado 'pending' SE ainda nao existir (slot, cycle).
 * Retorna { row, created }: created=false quando o UNIQUE ja barrou (idempotencia).
 *
 * amount_cents e o snapshot do ciclo (vem de client_billing.amount_cents no momento
 * da geracao). external_id = "{slot}-{cycle}".
 */
export async function insertPendingChargeIfAbsent(input: {
  slot: string;
  cycle: string;
  externalId: string;
  amountCents: number;
}): Promise<{ row: BillingChargeRow; created: boolean }> {
  const ins = await query<BillingChargeRow>(
    `INSERT INTO billing_charges (slot, cycle, external_id, amount_cents, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (slot, cycle) DO NOTHING
     RETURNING ${COLUMNS}`,
    [input.slot, input.cycle, input.externalId, input.amountCents],
  );
  if (ins.rows[0]) {
    return { row: ins.rows[0], created: true };
  }
  // Conflito: ja existe. Le e retorna a existente (idempotencia).
  const existing = await getCharge(input.slot, input.cycle);
  if (!existing) {
    // Corrida rara: foi deletada entre o INSERT e o SELECT. Trata como falha clara.
    throw new Error(
      `billing_charges: ON CONFLICT mas linha ausente para ${input.slot}/${input.cycle}`,
    );
  }
  return { row: existing, created: false };
}

/**
 * Preenche os dados retornados pelo gateway na linha ja criada (apos createPixCharge).
 * Idempotente por (slot, cycle). Nao avanca vencimento — isso e F2 (webhook PAID).
 */
export async function attachGatewayData(input: {
  slot: string;
  cycle: string;
  abacateChargeId: string;
  brCode: string;
  brCodeBase64: string;
  expiresAt: Date | null;
}): Promise<BillingChargeRow | null> {
  const r = await query<BillingChargeRow>(
    `UPDATE billing_charges
     SET abacate_charge_id = $3,
         br_code           = $4,
         br_code_base64    = $5,
         expires_at        = $6,
         updated_at        = NOW()
     WHERE slot = $1 AND cycle = $2
     RETURNING ${COLUMNS}`,
    [
      input.slot,
      input.cycle,
      input.abacateChargeId,
      input.brCode,
      input.brCodeBase64,
      input.expiresAt,
    ],
  );
  return r.rows[0] ?? null;
}

/**
 * REEMITE a cobranca PIX REUSANDO a MESMA linha (slot, cycle): sobrescreve os dados do
 * gateway (novo abacate_charge_id, br_code, validade) e volta status='pending'. Usado
 * quando o PIX anterior EXPIROU (ADR 0013, edge case "PIX expirado").
 *
 * Diferenca pra attachGatewayData: aqui FORCAMOS status='pending' (a linha pode estar
 * 'expired'/'pending' vencido) e o WHERE exige status != 'paid' — uma cobranca ja paga
 * NUNCA e reescrita por reemissao (invariante de seguranca C2). Nao avanca vencimento.
 *
 * Retorna null se a linha nao existe OU ja esta paga (nenhuma reescrita aconteceu).
 */
export async function reissueGatewayData(input: {
  slot: string;
  cycle: string;
  abacateChargeId: string;
  brCode: string;
  brCodeBase64: string;
  expiresAt: Date | null;
}): Promise<BillingChargeRow | null> {
  const r = await query<BillingChargeRow>(
    `UPDATE billing_charges
     SET abacate_charge_id = $3,
         br_code           = $4,
         br_code_base64    = $5,
         expires_at        = $6,
         status            = 'pending',
         updated_at        = NOW()
     WHERE slot = $1 AND cycle = $2 AND status <> 'paid'
     RETURNING ${COLUMNS}`,
    [
      input.slot,
      input.cycle,
      input.abacateChargeId,
      input.brCode,
      input.brCodeBase64,
      input.expiresAt,
    ],
  );
  return r.rows[0] ?? null;
}
