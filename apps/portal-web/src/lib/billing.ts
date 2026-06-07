/**
 * Regra de vencimento (spec D1, validada com o Bruno): o card de billing muda de
 * cor conforme os dias restantes ate o vencimento.
 *
 *   >= 6 dias  -> roxo (normal)        tom: 'brand'
 *   1..5 dias  -> ambar (atencao)      tom: 'amber'
 *   <= 0 dias  -> vermelho (vencido)   tom: 'danger'
 *
 * Quando NAO ha dados de billing (sem next_due_date), o portal nao alarma:
 * mostra "Mensalidade em dia" / fallback de suporte (spec 3.2).
 */
import type { StatusBilling } from './api-types';

export type BillingTone = 'brand' | 'amber' | 'danger' | 'neutral';

export interface BillingView {
  tone: BillingTone;
  /** true quando ha next_due_date e dias_restantes computados. */
  hasDueDate: boolean;
  diasRestantes: number | null;
  /** vencido = dias_restantes <= 0. */
  vencido: boolean;
  /** proximo = 1..5 dias (limiar ambar D1). */
  proximo: boolean;
}

export function computeBillingView(billing: StatusBilling | null): BillingView {
  if (!billing || billing.next_due_date === null || billing.dias_restantes === null) {
    return {
      tone: 'neutral',
      hasDueDate: false,
      diasRestantes: null,
      vencido: false,
      proximo: false,
    };
  }
  const dias = billing.dias_restantes;
  const vencido = dias <= 0;
  const proximo = dias >= 1 && dias <= 5;
  const tone: BillingTone = vencido ? 'danger' : proximo ? 'amber' : 'brand';
  return { tone, hasDueDate: true, diasRestantes: dias, vencido, proximo };
}
