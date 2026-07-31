/**
 * silence-gate.ts — GATE ÚNICO de silêncio total por-clone (ordem do Bruno, fix pós-SCRUM-155;
 * CORRIGIDO 31/07 — a v1 confundia "suspenso pela Startap" com "pausado pelo PRÓPRIO dono").
 *
 * Contexto: o router tinha DOIS ramos de entrada (fromMe / cliente-final) e só o ramo
 * cliente-final aplicava o gate de suspensão/inadimplência (ADR 0016). O ramo `fromMe`
 * (comando manual do dono, human-reply-pause, modo atendente) rodava 100% ANTES de
 * qualquer checagem — um clone suspenso ou vencido além da carência continuava gravando
 * `flow_pauses` (source=human_reply / manual) e respondendo ao PRÓPRIO dono. O job
 * `antibot` também era cego a isso.
 *
 * ERRO DA v1 (meu, não do Bruno): eu tratei `flow_enabled === false` como sinônimo de
 * "suspensão que exige silêncio total". Mas essa MESMA coluna também é ligada quando o
 * PRÓPRIO DONO pausa o bot pelo portal (`suspended_kind = OWNER_PAUSE_KIND`, ver
 * apps/portal-api/src/routes/portal-conexao.ts). Dono que pausou o bot continua sendo
 * cliente ATIVO — ele espera que pausas manuais em contatos específicos (human_reply)
 * continuem sendo gravadas enquanto ele configura o clone, senão ao reativar o bot
 * atende quem ele queria excluir (quebra o onboarding: "cliente entra novo não tem
 * nada configurado, ele vai deixar pausado até configurar tudo e pausar o que tem que
 * pausar antes de reativar" — Bruno, 31/07, literal).
 *
 * Decisão do Bruno (corrigida 2x, 31/07 — a 2ª correção é a que vale): os DOIS eixos são
 * INDEPENDENTES e COEXISTEM, não um OR onde a pausa do dono "blinda" o outro eixo:
 *
 *   "ele pausou por ele mesmo, mas depois caiu a inadimplência, então enquanto está
 *   pausado pelo usuário o comportamento é um, mas se ainda está pausado pelo usuário
 *   mais cai em inadimplência é outro, só que se ele paga sai do inadimplente mas ainda
 *   sim está pausado por ele muda o comportamento pq fica parado mas o pause funciona"
 *
 * Modelo mental: inadimplência/suspensão-Startap suspende o PROCESSAMENTO inteiro; a
 * pausa do dono (`owner_request`) suspende só a RESPOSTA do bot (decisão do CALLER,
 * fora deste gate) — são camadas diferentes. Consequência: pagar remove a camada de
 * inadimplência SEM mexer na pausa do dono — o cliente volta a ter `human_reply`/antibot
 * gravados normalmente, mas o bot segue mudo até ELE mesmo religar pelo portal.
 *
 * Matriz (ver silence-gate.test.ts para os 5 casos + 3 casos reais medidos em prod):
 *   owner_request + em dia            -> silenced:false (PROCESSA, bot só não responde)
 *   owner_request + vencido>carência  -> silenced:true  (SILÊNCIO TOTAL)
 *   sem pausa      + vencido>carência -> silenced:true  (SILÊNCIO TOTAL)
 *   suspenso pela Startap (qualquer billing) -> silenced:true (SILÊNCIO TOTAL)
 *
 * Este módulo é PURO (sem I/O, sem process.env, sem cache): dado o CloneRow já carregado
 * (getCloneBySlot) + os flags/config do caller, decide silenciar ou não.
 * Fonte ÚNICA — router (2 ramos) e worker/antibot chamam a MESMA função, sem duplicar lógica.
 *
 * IMPORTANTE (regra dura): isto é sempre um `return` de LEITURA. NUNCA escreve
 * flow_enabled/next_due_date, nunca apaga dado. Pagar ou reativar pelo portal volta o
 * bot a funcionar no PRÓXIMO turno, sem nenhuma ação aqui.
 */

/**
 * Espelho de `OWNER_PAUSE_KIND` (packages/db/src/queries/flow-clones.ts) — @startap/core NÃO
 * pode importar @startap/db (é o contrário: db depende de core; importar aqui criaria ciclo,
 * mesmo precedente documentado em atendente-prompt.ts). O valor é um literal estável de schema
 * (`suspended_kind='owner_request'`), não lógica — replicar é seguro DESDE que um teste garanta
 * que as duas constantes nunca divergem (ver silence-gate.test.ts).
 */
export const OWNER_PAUSE_KIND_MIRROR = 'owner_request' as const;

/** Recorte mínimo do CloneRow que este gate precisa — evita import circular com @startap/db. */
export interface SilenceGateCloneInput {
  flow_enabled: boolean;
  /**
   * Motivo da suspensão manual (mesma coluna que `flow_enabled=false` acompanha). `null`/
   * ausente com flow_enabled=false é tratado como PAUSA DO DONO (fail-safe: calar cliente
   * ativo por engano é pior que gravar uma pausa a mais) — ver resolveSilenceGate.
   */
  suspended_kind: string | null;
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
 * Decide se um clone deve ficar em SILÊNCIO TOTAL agora. Dois eixos INDEPENDENTES em OR
 * — a pausa do dono NÃO blinda contra o eixo (b), e vice-versa (ver header do módulo):
 *  (a) suspensão NÃO-DO-DONO: flow_enabled === false E suspended_kind !== 'owner_request'
 *      (suspensão da Startap: billing/manual_other/abuse/etc). `suspended_kind` nulo/ausente
 *      NÃO entra neste eixo — ver fail-safe abaixo;
 *  (b) VENCIDO além da carência: daysUntilDue(next_due_date) < -graceDays, só quando há
 *      billing configurado (next_due_date E amount_cents>0), atrás de billingOverdueSilenceOn.
 *      Roda MESMO quando o clone está com `owner_request` — é assim que "pausado pelo
 *      dono + inadimplente" vira silêncio total, e "pausado pelo dono + pagou" volta a
 *      processar (o CALLER decide se o bot RESPONDE olhando flow_enabled à parte).
 *
 * Fail-safe do eixo (a): `suspended_kind` ausente/null com flow_enabled=false é tratado
 * como PAUSA DO DONO (não entra no eixo a) — calar um cliente ativo por engano
 * (falso-positivo) é pior que gravar uma pausa a mais (falso-negativo, no pior caso vira
 * ruído no /pausas). Isso cobre linhas antigas/paths que ainda não populam a coluna. O
 * eixo (b) continua rodando normalmente neste caso.
 *
 * Suspensão não-do-dono tem precedência no motivo retornado sobre vencimento quando os
 * dois são true ao mesmo tempo (eixo explícito do operador/Startap).
 */
export function resolveSilenceGate(
  clone: SilenceGateCloneInput,
  deps: SilenceGateDeps,
): SilenceGateResult {
  // Fail-safe: só silencia quando o motivo é CONHECIDO e diferente de owner_request.
  // suspended_kind null/ausente NÃO entra aqui — cai no fail-safe (não silencia por este eixo).
  const suspensaoNaoDoDono =
    clone.flow_enabled === false &&
    clone.suspended_kind != null &&
    clone.suspended_kind !== OWNER_PAUSE_KIND_MIRROR;
  if (suspensaoNaoDoDono) {
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
