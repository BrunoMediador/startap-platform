/**
 * silence-gate.ts — GATE ÚNICO de silêncio total por-clone (ordem do Bruno, fix pós-SCRUM-155).
 *
 * Contexto: o router tinha DOIS ramos de entrada (fromMe / cliente-final) e só o ramo
 * cliente-final aplicava o gate de suspensão/inadimplência (ADR 0016). O ramo `fromMe`
 * (comando manual do dono, human-reply-pause, modo atendente) rodava 100% ANTES de
 * qualquer checagem — um clone suspenso ou vencido além da carência continuava gravando
 * `flow_pauses` (source=human_reply / manual) e respondendo ao PRÓPRIO dono. O job
 * `antibot` também era cego a isso.
 *
 * Decisão do Bruno (literal): "se esta inadimplente ou parado nao deveria nem pausar
 * sozinho, se esta inadimplente nao deveria processar nada". SILÊNCIO TOTAL, SEM EXCEÇÃO:
 * nenhum efeito colateral roda pra um clone suspenso/vencido, nem o comando manual do
 * dono pelo WhatsApp. O portal continua sendo o canal de controle (não é afetado).
 *
 * Este módulo é PURO (sem I/O, sem process.env, sem cache): dado o CloneRow já carregado
 * (getCloneBySlot/getCloneBySession) + os flags/config do caller, decide silenciar ou não.
 * Fonte ÚNICA — router (2 ramos) e worker/antibot chamam a MESMA função, sem duplicar lógica.
 *
 * IMPORTANTE (regra dura): isto é sempre um `return` de LEITURA. NUNCA escreve
 * flow_enabled/next_due_date, nunca apaga dado. Pagar ou reativar pelo portal volta o
 * bot a funcionar no PRÓXIMO turno, sem nenhuma ação aqui.
 */

/** Recorte mínimo do CloneRow que este gate precisa — evita import circular com @startap/db. */
export interface SilenceGateCloneInput {
  flow_enabled: boolean;
  next_due_date: string | null;
  billing_amount_cents: number | null;
}

export interface SilenceGateDeps {
  /** Carência em dias além do vencimento antes de silenciar (clientBilling.GRACE_DAYS). */
  graceDays: number;
  /** Dias restantes até o vencimento (clientBilling.daysUntilDue(nextDueDate)). Negativo = vencido. */
  daysUntilDue: (nextDueDate: string | null) => number | null;
  /** BILLING_OVERDUE_SILENCE — default OFF preserva o comportamento legado do eixo (b). */
  billingOverdueSilenceOn: boolean;
}

export type SilenceGateReason = 'flow-suspended' | 'billing-overdue';

export type SilenceGateResult =
  | { silenced: false }
  | {
      silenced: true;
      reason: SilenceGateReason;
      diasRestantes: number | null;
    };

/**
 * Decide se um clone deve ficar em SILÊNCIO TOTAL agora. Dois eixos em OR:
 *  (a) suspensão MANUAL: flow_enabled === false (toggle do gestão / pausa self-service);
 *  (b) VENCIDO além da carência: daysUntilDue(next_due_date) < -graceDays, só quando há
 *      billing configurado (next_due_date E amount_cents>0), atrás de billingOverdueSilenceOn.
 *
 * Suspensão manual tem precedência no motivo retornado (eixo explícito do operador).
 */
export function resolveSilenceGate(
  clone: SilenceGateCloneInput,
  deps: SilenceGateDeps,
): SilenceGateResult {
  const suspensaoManual = clone.flow_enabled === false;
  if (suspensaoManual) {
    return { silenced: true, reason: 'flow-suspended', diasRestantes: null };
  }

  const temBilling = clone.next_due_date != null && (clone.billing_amount_cents ?? 0) > 0;
  const diasRestantes = temBilling ? deps.daysUntilDue(clone.next_due_date) : null;
  const vencidoComCarencia =
    deps.billingOverdueSilenceOn &&
    temBilling &&
    diasRestantes != null &&
    diasRestantes < -deps.graceDays;

  if (vencidoComCarencia) {
    return { silenced: true, reason: 'billing-overdue', diasRestantes };
  }

  return { silenced: false };
}
