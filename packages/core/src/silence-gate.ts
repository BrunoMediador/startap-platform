/**
 * silence-gate.ts — GATE ÚNICO de silêncio total por-clone (fix pós-SCRUM-155).
 *
 * Fonte ÚNICA de decisão: router (2 ramos: fromMe e cliente-final, incluindo o gate LEGADO
 * do ADR 0016) e worker/antibot chamam a MESMA função pura, sem duplicar lógica. Regra de
 * negócio completa (por que os 2 eixos existem e são independentes): regras-negocio.md 8-bis.
 *
 * Modelo mental resumido: inadimplência/suspensão-Startap suspende o PROCESSAMENTO inteiro;
 * a pausa do dono (`suspended_kind='owner_request'`) suspende só a RESPOSTA do bot (decisão
 * do CALLER, fora deste gate) — são camadas independentes que podem coexistir. Ver
 * silence-gate.test.ts para a matriz completa + casos reais medidos em prod.
 *
 * IMPORTANTE (regra dura): isto é sempre um `return` de LEITURA. NUNCA escreve
 * flow_enabled/next_due_date, nunca apaga dado. Pagar ou reativar pelo portal volta o
 * bot a funcionar no PRÓXIMO turno, sem nenhuma ação aqui.
 */

/**
 * kind canônico da pausa self-service do dono (NUNCA 'billing' — anti auto-resume do PIX).
 * Fonte ÚNICA (movida de packages/db/src/queries/flow-clones.ts, achado do security 31/07):
 * @startap/db JÁ depende de @startap/core (sem ciclo nessa direção) — flow-clones.ts
 * reexporta este mesmo valor em vez de declarar um literal duplicado. Elimina o risco de
 * divergência silenciosa entre os dois pacotes (um teste que comparasse 2 literais digitados
 * não pegaria a divergência — só comparar contra ESTA constante, importada, prova algo).
 */
export const OWNER_PAUSE_KIND = 'owner_request' as const;

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
  | { silenced: false; respond: boolean }
  | {
      silenced: true;
      reason: SilenceGateReason;
      diasRestantes: number | null;
    };

/**
 * Decide se um clone deve ficar em SILÊNCIO TOTAL agora, e — quando NÃO está em silêncio
 * total — se o bot deve RESPONDER ao cliente final (`respond`). Três desfechos possíveis
 * (regras-negocio.md 8-bis, matriz completa):
 *  (a) suspensão NÃO-DO-DONO: flow_enabled === false E suspended_kind !== 'owner_request'
 *      (suspensão da Startap: billing/manual_other/abuse/etc) ⇒ SILÊNCIO TOTAL.
 *      `suspended_kind` nulo/ausente NÃO entra neste eixo — ver fail-safe abaixo;
 *  (b) VENCIDO além da carência: daysUntilDue(next_due_date) < -graceDays, só quando há
 *      billing configurado (next_due_date E amount_cents>0), atrás de billingOverdueSilenceOn.
 *      Roda MESMO quando o clone está com `owner_request` ⇒ SILÊNCIO TOTAL — é assim que
 *      "pausado pelo dono + inadimplente" vira silêncio total;
 *  (c) PAUSA DO DONO em dia (flow_enabled === false, suspended_kind === 'owner_request',
 *      sem cair em (a) nem (b)) ⇒ NÃO é silêncio total: `respond: false`. O sistema
 *      PROCESSA normalmente (grava human_reply, roda antibot, upsert de contato) — só a
 *      RESPOSTA ao cliente final é suprimida, porque o dono pediu. Fora deste caso,
 *      `respond` é sempre `true` (clone ativo, nada a suprimir).
 *
 * Fail-safe do eixo (a): `suspended_kind` ausente/null com flow_enabled=false é tratado
 * como PAUSA DO DONO (não entra no eixo a) — calar um cliente ativo por engano
 * (falso-positivo) é pior que gravar uma pausa a mais (falso-negativo, no pior caso vira
 * ruído no /pausas). Isso cobre linhas antigas/paths que ainda não populam a coluna. O
 * eixo (b) continua rodando normalmente neste caso.
 *
 * Suspensão não-do-dono tem precedência no motivo retornado sobre vencimento quando os
 * dois são true ao mesmo tempo (eixo explícito do operador/Startap).
 *
 * IMPORTANTE pro CALLER: `respond: false` NÃO é `silenced` — o caller deve continuar
 * rodando todo o pipeline de estado (antibot, human_reply, contactNames) e só pular a
 * geração/envio da resposta do bot (`bot.handle`), sem dar early-return antes disso.
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
    clone.suspended_kind !== OWNER_PAUSE_KIND;
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

  // Pausa do dono em dia (não caiu em (a) nem (b)): processa, mas não responde.
  const pausadoPeloDono = clone.flow_enabled === false && clone.suspended_kind === OWNER_PAUSE_KIND;
  return { silenced: false, respond: !pausadoPeloDono };
}
