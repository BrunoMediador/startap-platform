import type { Pool, PoolClient } from 'pg';
import { pool } from '../client.js';
import { type ClientBillingRow, advanceFromMaxDue } from './client-billing.js';
import {
  type OperationalSnapshot,
  getOperationalSnapshotBySlot,
  getOperationalSnapshotForUpdate,
} from './operational-state.js';

export interface PaymentTransitionInput {
  slot: string;
  actor: string;
  cycleMonths?: number;
  initialDueDate?: string | null;
  amountCents?: number | null;
  notes?: string | null;
  resumeReason: string;
  now?: Date;
}

export interface PaymentTransitionResult {
  billing: ClientBillingRow;
  operational: OperationalSnapshot;
  resumed: boolean;
  firstPayment: boolean;
}

type BillingPool = Pick<Pool, 'connect'>;

/**
 * O servidor pode ter aplicado COMMIT e perdido a resposta. Nesse caso não existe
 * rollback afirmável nem retry seguro sem uma releitura autoritativa por slot.
 */
export class ManualPaymentOutcomeUncertainError extends Error {
  readonly code = 'MANUAL_PAYMENT_OUTCOME_UNCERTAIN' as const;
  readonly stage = 'commit' as const;

  constructor(cause: unknown) {
    super('resultado do pagamento manual não foi confirmado pelo banco', { cause });
    this.name = 'ManualPaymentOutcomeUncertainError';
  }
}

export function isManualPaymentOutcomeUncertainError(
  error: unknown,
): error is ManualPaymentOutcomeUncertainError {
  return error instanceof ManualPaymentOutcomeUncertainError;
}

function cycleMonths(input: number | undefined): number {
  const value = input ?? 1;
  if (!Number.isInteger(value) || value < 1 || value > 36) {
    throw new RangeError('cycleMonths deve ser inteiro entre 1 e 36');
  }
  return value;
}

/** Lock global por slot. Deve ser o primeiro lock tomado depois de BEGIN/descoberta do slot. */
export async function acquireBillingSlotAdvisoryLock(
  client: PoolClient,
  slot: string,
): Promise<void> {
  // Mesma expressão de chave usada por billingCharges.withBillingSlotLock: geração,
  // confirmação, pagamento manual e owner resume precisam compartilhar o lock lógico.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('billing:' || $1)::bigint)", [slot]);
}

/**
 * Núcleo único da transição comum a pagamento manual e webhook.
 * Precondições: transação aberta e advisory `billing:<slot>` adquirido pelo caller.
 * Não abre/fecha transação, não invalida cache e não executa efeito externo.
 */
export async function applyPaymentTransitionInTransaction(
  client: PoolClient,
  input: PaymentTransitionInput,
): Promise<PaymentTransitionResult | null> {
  const months = cycleMonths(input.cycleMonths);
  const initial = await getOperationalSnapshotForUpdate(client, input.slot);
  if (!initial) return null;

  const billingBefore = await client.query<{
    next_due_date: string | null;
    first_payment: boolean;
  }>(
    `SELECT to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date,
            (last_payment_at IS NULL) AS first_payment
       FROM client_billing
      WHERE slot = $1`,
    [input.slot],
  );
  const currentDue = billingBefore.rows[0]?.next_due_date ?? input.initialDueDate ?? null;
  const firstPayment = billingBefore.rows[0]?.first_payment ?? true;
  const newDue = advanceFromMaxDue(currentDue, input.now ?? new Date(), months);

  const billing = await client.query<ClientBillingRow>(
    `INSERT INTO client_billing
       (slot, next_due_date, amount_cents, status, notes, last_payment_at,
        created_at, updated_at, tenant_id)
     VALUES ($1, $2::date, $3, 'active', $4, NOW(), NOW(), NOW(),
       (SELECT tenant_id FROM flow_clones WHERE slot = $5))
     ON CONFLICT (slot) DO UPDATE SET
       next_due_date   = EXCLUDED.next_due_date,
       amount_cents    = COALESCE($3, client_billing.amount_cents),
       status          = 'active',
       notes           = COALESCE($4, client_billing.notes),
       last_payment_at = NOW(),
       updated_at      = NOW(),
       tenant_id       = COALESCE(client_billing.tenant_id, EXCLUDED.tenant_id)
     RETURNING slot, to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date,
               amount_cents, last_payment_at, status, notes, created_at, updated_at`,
    [input.slot, newDue, input.amountCents ?? null, input.notes ?? null, input.slot],
  );

  const resume = await client.query<{ slot: string }>(
    `UPDATE flow_clones
        SET flow_enabled     = TRUE,
            suspended_reason = NULL,
            suspended_at     = NULL,
            suspended_kind   = NULL,
            updated_at       = NOW()
      WHERE slot = $1
        AND flow_enabled = FALSE
        AND suspended_kind = 'billing'
      RETURNING slot`,
    [input.slot],
  );
  const resumed = (resume.rowCount ?? 0) > 0;
  if (resumed) {
    await client.query(
      `INSERT INTO flow_suspension_log (slot, action, reason, actor)
       VALUES ($1, 'resume', $2, $3)`,
      [input.slot, input.resumeReason, input.actor],
    );
  }

  const operational = await getOperationalSnapshotBySlot(input.slot, client);
  if (!operational || !billing.rows[0]) {
    throw new Error('payment transition final reread missing');
  }
  return { billing: billing.rows[0], operational, resumed, firstPayment };
}

/** Adaptador manual: valida existência, lock, transição e releitura na mesma transação. */
export async function registerManualPayment(
  input: PaymentTransitionInput,
  dbPool: BillingPool = pool,
): Promise<PaymentTransitionResult | null> {
  const client = await dbPool.connect();
  let discardClient = false;
  let commitAttempted = false;
  try {
    await client.query('BEGIN');
    await acquireBillingSlotAdvisoryLock(client, input.slot);
    const result = await applyPaymentTransitionInTransaction(client, input);
    commitAttempted = true;
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discardClient = true;
    }
    if (commitAttempted) {
      // Mesmo que o ROLLBACK subsequente responda, ele não prova que o COMMIT anterior
      // deixou de ser aplicado (a confirmação pode ter se perdido na rede). Nunca
      // devolvemos essa conexão de protocolo incerto ao pool.
      discardClient = true;
      throw new ManualPaymentOutcomeUncertainError(error);
    }
    throw error;
  } finally {
    client.release(discardClient);
  }
}
