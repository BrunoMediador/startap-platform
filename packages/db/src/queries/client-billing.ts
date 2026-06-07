/**
 * client-billing — billing/vencimento por slot (ADR 0012, Decisao 3).
 *
 * 1 linha por slot. Bruno gerencia pelo painel-admin (PUT /api/billing/:slot).
 * O portal SO LE (next_due_date / status / dias restantes).
 *
 * IMPORTANTE: status aqui e INFORMATIVO. NAO silencia o bot — isso continua sendo
 * flow_clones.flow_enabled (feature 30/05). Conceitos desacoplados de proposito.
 */
import { query } from '../client.js';

export type BillingStatus = 'active' | 'overdue' | 'suspended';

export interface ClientBillingRow {
  slot: string;
  next_due_date: string | null; // 'YYYY-MM-DD' (DATE)
  amount_cents: number | null;
  last_payment_at: Date | null;
  status: BillingStatus;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Avanca uma data 'YYYY-MM-DD' em N meses, preservando o dia quando possivel.
 * Pura e deterministica — base dos testes de avanco de vencimento.
 *
 * Trata overflow de fim de mes: 31/jan + 1 mes => 28/29 fev (ultimo dia do mes),
 * nunca "vaza" para mar/01 (comportamento esperado em ciclos mensais).
 */
export function advanceDueDate(dateStr: string, months = 1): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) throw new Error(`advanceDueDate: data invalida "${dateStr}" (esperado YYYY-MM-DD)`);
  const year = Number(m[1]);
  const month = Number(m[2]); // 1-12
  const day = Number(m[3]);

  // Indice 0-based de mes alvo a partir de jan do ano base.
  const totalMonths = (year - 1) * 12 + (month - 1) + months;
  const targetYear = Math.floor(totalMonths / 12) + 1;
  const targetMonth = (totalMonths % 12) + 1; // 1-12

  // Ultimo dia do mes alvo (mes 0-based para Date: targetMonth aponta o proximo
  // mes; dia 0 => ultimo dia do mes anterior = mes alvo).
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);

  const pad = (n: number) => String(n).padStart(2, '0');
  return `${targetYear}-${pad(targetMonth)}-${pad(targetDay)}`;
}

/** Le o billing de um slot (null se nao existe linha). */
export async function getBillingBySlot(slot: string): Promise<ClientBillingRow | null> {
  const r = await query<ClientBillingRow>(
    `SELECT slot,
            to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date,
            amount_cents, last_payment_at, status, notes, created_at, updated_at
     FROM client_billing WHERE slot = $1`,
    [slot],
  );
  return r.rows[0] ?? null;
}

/** Lista o billing de todos os slots (usado pelo painel-admin). */
export async function listBilling(): Promise<ClientBillingRow[]> {
  const r = await query<ClientBillingRow>(
    `SELECT slot,
            to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date,
            amount_cents, last_payment_at, status, notes, created_at, updated_at
     FROM client_billing
     ORDER BY next_due_date NULLS LAST, slot`,
  );
  return r.rows;
}

/**
 * Upsert do billing de um slot (painel-admin). Campos undefined nao sao tocados;
 * em INSERT inicial usam o default. Nao registra pagamento (use registerPayment).
 */
export async function upsertBilling(input: {
  slot: string;
  nextDueDate?: string | null;
  amountCents?: number | null;
  status?: BillingStatus;
  notes?: string | null;
}): Promise<ClientBillingRow> {
  const r = await query<ClientBillingRow>(
    `INSERT INTO client_billing (slot, next_due_date, amount_cents, status, notes, created_at, updated_at)
     VALUES ($1, $2, $3, COALESCE($4, 'active'), $5, NOW(), NOW())
     ON CONFLICT (slot) DO UPDATE SET
       next_due_date = COALESCE($2, client_billing.next_due_date),
       amount_cents  = COALESCE($3, client_billing.amount_cents),
       status        = COALESCE($4, client_billing.status),
       notes         = COALESCE($5, client_billing.notes),
       updated_at    = NOW()
     RETURNING slot,
               to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date,
               amount_cents, last_payment_at, status, notes, created_at, updated_at`,
    [
      input.slot,
      input.nextDueDate ?? null,
      input.amountCents ?? null,
      input.status ?? null,
      input.notes ?? null,
    ],
  );
  return r.rows[0];
}

/**
 * Registra um pagamento: grava last_payment_at = now(), marca status='active' e
 * avanca next_due_date em `cycleMonths` (default 1). Se ainda nao havia
 * next_due_date, parte de `baseDate` (default hoje em UTC) avancada.
 */
export async function registerPayment(input: {
  slot: string;
  cycleMonths?: number;
  baseDate?: string; // 'YYYY-MM-DD' — so usado quando nao ha next_due_date
}): Promise<ClientBillingRow> {
  const cycleMonths = input.cycleMonths ?? 1;
  const current = await getBillingBySlot(input.slot);

  const base = current?.next_due_date ?? input.baseDate ?? new Date().toISOString().slice(0, 10);
  const newDue = advanceDueDate(base, cycleMonths);

  const r = await query<ClientBillingRow>(
    `INSERT INTO client_billing (slot, next_due_date, status, last_payment_at, created_at, updated_at)
     VALUES ($1, $2, 'active', NOW(), NOW(), NOW())
     ON CONFLICT (slot) DO UPDATE SET
       next_due_date   = $2,
       status          = 'active',
       last_payment_at = NOW(),
       updated_at      = NOW()
     RETURNING slot,
               to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date,
               amount_cents, last_payment_at, status, notes, created_at, updated_at`,
    [input.slot, newDue],
  );
  return r.rows[0];
}

/**
 * Calcula dias restantes ate o vencimento a partir de hoje (UTC, meia-noite).
 * Negativo = vencido. Null se nao ha next_due_date. Pura/testavel.
 */
export function daysUntilDue(nextDueDate: string | null, today = new Date()): number | null {
  if (!nextDueDate) return null;
  const due = Date.parse(`${nextDueDate}T00:00:00Z`);
  if (Number.isNaN(due)) return null;
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((due - todayUtc) / 86_400_000);
}
