/**
 * client-billing — billing/vencimento por slot (ADR 0012, Decisao 3).
 *
 * 1 linha por slot. Bruno gerencia pelo painel-admin (PUT /api/billing/:slot).
 * O portal SO LE (next_due_date / status / dias restantes).
 *
 * IMPORTANTE: a coluna `status` aqui continua INFORMATIVA (nunca dirige o gate).
 * Desde o ADR 0016, porem, o SILENCIO do bot deriva TAMBEM do vencimento: o gate
 * (apps/api/src/router.ts, passo billing) cala quando vencido alem da carencia
 * (daysUntilDue < -GRACE_DAYS), atras da flag BILLING_OVERDUE_SILENCE. O eixo manual
 * (flow_clones.flow_enabled) segue valendo em OR. Vencimento NUNCA escreve flow_enabled
 * (derivado puro) — perdao = data pro futuro volta o bot sem nenhum UPDATE.
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
  // Dual-write tenant_id (ADR 0018, Fase 2): subselect inline em flow_clones —
  // resolve NULL sozinho p/ slot sem clone, nunca derruba o upsert. Não-quente.
  // Slot do subselect é parâmetro SEPARADO ($6) — não reusa $1 (evita
  // "inconsistent types deduced for parameter $1" entre os varchars de slot).
  const r = await query<ClientBillingRow>(
    `INSERT INTO client_billing (slot, next_due_date, amount_cents, status, notes, created_at, updated_at, tenant_id)
     VALUES ($1, $2, $3, COALESCE($4, 'active'), $5, NOW(), NOW(),
       (SELECT tenant_id FROM flow_clones WHERE slot = $6))
     ON CONFLICT (slot) DO UPDATE SET
       next_due_date = COALESCE($2, client_billing.next_due_date),
       amount_cents  = COALESCE($3, client_billing.amount_cents),
       status        = COALESCE($4, client_billing.status),
       notes         = COALESCE($5, client_billing.notes),
       updated_at    = NOW(),
       tenant_id     = COALESCE(client_billing.tenant_id, EXCLUDED.tenant_id)
     RETURNING slot,
               to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date,
               amount_cents, last_payment_at, status, notes, created_at, updated_at`,
    [
      input.slot,
      input.nextDueDate ?? null,
      input.amountCents ?? null,
      input.status ?? null,
      input.notes ?? null,
      input.slot, // $6: slot do subselect tenant_id (contexto de tipo separado de $1)
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

  // Dual-write tenant_id (ADR 0018, Fase 2): subselect inline em flow_clones —
  // resolve NULL sozinho p/ slot sem clone, nunca derruba o upsert. Não-quente.
  // Slot do subselect é parâmetro SEPARADO ($3) — não reusa $1 (evita
  // "inconsistent types deduced for parameter $1" entre os varchars de slot).
  const r = await query<ClientBillingRow>(
    `INSERT INTO client_billing (slot, next_due_date, status, last_payment_at, created_at, updated_at, tenant_id)
     VALUES ($1, $2, 'active', NOW(), NOW(), NOW(),
       (SELECT tenant_id FROM flow_clones WHERE slot = $3))
     ON CONFLICT (slot) DO UPDATE SET
       next_due_date   = $2,
       status          = 'active',
       last_payment_at = NOW(),
       updated_at      = NOW(),
       tenant_id       = COALESCE(client_billing.tenant_id, EXCLUDED.tenant_id)
     RETURNING slot,
               to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date,
               amount_cents, last_payment_at, status, notes, created_at, updated_at`,
    [input.slot, newDue, input.slot],
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

// ─── Modelo por DATA DE VENCIMENTO (ADR 0014) ──────────────────────────────────

/** Janela de pagamento default: 7 dias antes do vencimento (decisao do Bruno, ADR 0014). */
export const BILLING_WINDOW_DAYS = 7;

/**
 * Carencia de inadimplencia antes de silenciar o bot (ADR 0016).
 *
 * O bot so cala a partir do 4o dia de atraso: daysUntilDue < -GRACE_DAYS.
 * Vencido ha 0/1/2/3 dias => AINDA RESPONDE (carencia). Vencido ha 4+ dias => CALA.
 * Promover a env (BILLING_GRACE_DAYS) so se Bruno quiser ajustar sem deploy.
 */
export const GRACE_DAYS = 3;

/** Estado de cobranca derivado da data — FONTE UNICA DE VERDADE (tela E card consomem). */
export type BillingState = 'em_dia' | 'a_vencer' | 'vencido' | 'sem_config';

export interface BillingStateResult {
  state: BillingState;
  /** Dias ate o vencimento (negativo = vencido; null se sem_config). */
  diasRestantes: number | null;
  /** a_vencer || vencido — slot esta dentro da janela de pagamento. */
  dentroDaJanela: boolean;
  /** dentroDaJanela — derivado puro da data (o "tem valor?" e checado no ponto de uso). */
  podeGerarPix: boolean;
}

/**
 * Estado de cobranca a partir de next_due_date e hoje (ADR 0014, fonte unica).
 *
 * - `sem_config`: sem next_due_date (sem valor e tratado no ponto de uso, nao aqui).
 * - `em_dia`   : d > windowDays  -> NAO gera/exibe PIX (cliente em dia).
 * - `a_vencer` : 1 <= d <= windowDays -> dentro da janela, gera PIX.
 * - `vencido`  : d <= 0          -> dentro da janela, gera PIX.
 *
 * Pura/deterministica. Reusa daysUntilDue (mesma referencia de "hoje" em UTC meia-noite).
 */
export function computeBillingState(
  nextDueDate: string | null,
  today = new Date(),
  windowDays = BILLING_WINDOW_DAYS,
): BillingStateResult {
  const dias = daysUntilDue(nextDueDate, today);
  if (dias == null) {
    return { state: 'sem_config', diasRestantes: null, dentroDaJanela: false, podeGerarPix: false };
  }
  if (dias > windowDays) {
    return { state: 'em_dia', diasRestantes: dias, dentroDaJanela: false, podeGerarPix: false };
  }
  const state: BillingState = dias <= 0 ? 'vencido' : 'a_vencer';
  return { state, diasRestantes: dias, dentroDaJanela: true, podeGerarPix: true };
}

/**
 * Data 'YYYY-MM-DD' de HOJE no fuso UTC (meia-noite). Base para o avanco com max(...).
 * Alinhado com daysUntilDue, que tambem ancora "hoje" em UTC meia-noite.
 */
export function todayUtcDateStr(today = new Date()): string {
  const y = today.getUTCFullYear();
  const m = String(today.getUTCMonth() + 1).padStart(2, '0');
  const d = String(today.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Avanco do vencimento no modelo por data (ADR 0014, decisao do Bruno):
 *   novo = max(next_due_date, hoje) + cycleMonths meses.
 *
 * - Em dia (due > hoje): parte de `due` (nao perde tempo pago).
 * - Vencido / re-cobranca (due no passado): parte de `hoje` -> NUNCA renova pro passado.
 *
 * `currentDue` null => parte de hoje. Pura/deterministica (usa advanceDueDate).
 */
export function advanceFromMaxDue(
  currentDue: string | null,
  today = new Date(),
  cycleMonths = 1,
): string {
  const todayStr = todayUtcDateStr(today);
  // max(due, hoje): compara as strings 'YYYY-MM-DD' (ordenacao lexicografica == cronologica).
  const base = currentDue && currentDue > todayStr ? currentDue : todayStr;
  return advanceDueDate(base, cycleMonths);
}
