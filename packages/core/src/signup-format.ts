/**
 * signup-format.ts — mapeia as 2 perguntas de formato do signup (ADR 0030 D2) pra
 * config de provisioning dos 4 combos: individual/estabelecimento × agenda/atendente.
 *
 * Pergunta 1: "Você atende sozinho ou tem uma equipe?"  → tipo_atendimento
 * Pergunta 2: "A IA marca sozinha na sua agenda, ou só atende e encaminha?" → modo_ia
 *
 * VOCABULÁRIO (contrato com o front — SCRUM-68 Onda 3): o front envia
 *   - tipo_atendimento ∈ {'individual','estabelecimento'} (default 'individual')
 *   - modo_ia          ∈ {'agenda','atendente'}          (default 'agenda')
 * O back ACEITA o que o front manda. `'atende'` é aceito como SINÔNIMO de `'atendente'`
 * (a spec do PM cita `'atende'`; o front manda `'atendente'`) — ambos = modo atendente.
 *
 * Helper PURO (sem I/O): a validação Zod acontece no app (portal-signup); aqui só
 * traduz as respostas JÁ validadas → colunas/flags/preço. Reusável pelo wizard do
 * gestão (paridade ADR 0030 D2).
 *
 * REGRESSÃO ZERO (funil vivo): o combo `individual + agenda` = o signup ATUAL. O default
 * do schema (individual+agenda quando os campos vêm ausentes) reproduz o PROVISIONAMENTO
 * de hoje byte-a-byte (product_type='individual', sem carimbar agenda_automatica no
 * personalizacao). O PREÇO desse combo passa a seguir a grade oficial (R$147; ADR 0030 D2)
 * — mudança de tabela INTENCIONAL, não regressão de comportamento.
 */

export type TipoAtendimento = 'individual' | 'estabelecimento';
// 'atende' e 'atendente' são sinônimos (modo atendente). Front manda 'atendente'.
export type ModoIa = 'agenda' | 'atende' | 'atendente';
export type SignupProductType = 'individual' | 'estabelecimento';

/**
 * Teto de colaboradores PLACEHOLDER pro estabelecimento novo do signup (editável no
 * gestão depois). 5 espelha o clone de teste dragon. Enforcement do teto vive no app
 * (ADR 0023), não no banco.
 */
export const DEFAULT_ESTABELECIMENTO_SEAT_CAP = 5;

/**
 * Grade de PREÇO por formato, em CENTAVOS (ADR 0030 D2; editável no gestão depois via
 * client_billing.amount_cents). Os 4 combos têm preço FIXO de tabela — individual+agenda
 * NÃO depende mais de env (PORTAL_SIGNUP_AMOUNT_CENTS): é R$147 pela grade oficial do PM.
 */
export const SIGNUP_AMOUNT_CENTS_BY_FORMAT = {
  individual_atendente: 9700, // R$97,00
  individual_agenda: 14700, // R$147,00
  estabelecimento_atendente: 19700, // R$197,00
  estabelecimento_agenda: 29700, // R$297,00
} as const;

export interface SignupFormatProvisioning {
  /** Coluna flow_clones.product_type. */
  productType: SignupProductType;
  /** Coluna flow_clones.seat_cap (NULL para individual). */
  seatCap: number | null;
  /**
   * Intenção de agenda (vai pra personalizacao.agenda_automatica). true = a IA marca
   * sozinha; false = modo atendente. É a INTENÇÃO gravada — o degrade elegante (D3)
   * deriva o efetivo em runtime com o estado do gcal, sem tocar este valor.
   */
  agendaAutomatica: boolean;
  /** Coluna flow_clones.modo_atendente_enabled (gate por-clone, migration 072). */
  modoAtendenteEnabled: boolean;
  /** Coluna flow_clones.billing_from_agenda_enabled (gate por-clone, migration 072). */
  billingFromAgendaEnabled: boolean;
  /** client_billing.amount_cents inicial (placeholder por formato). */
  amountCents: number;
}

/**
 * Mapeia (tipo_atendimento, modo_ia) → config de provisioning dos 4 combos.
 *
 * @param tipo  resposta 1 (individual|estabelecimento) → product_type.
 * @param modo  resposta 2 (agenda|atende|atendente)    → agenda_automatica.
 *
 * Mapa das colunas (migration 072 / ADR 0030 D2):
 *  - modo_atendente_enabled      = (agenda_automatica == false)  → liga o ramo atendente do bot.
 *  - billing_from_agenda_enabled = (agenda_automatica == true)   → segue a fórmula do ADR 0027
 *      (agenda ⇒ billing-da-agenda) pra TODO formato de agenda, INCLUSIVE individual+agenda: o
 *      clone novo ganha o /billing derivado da agenda. É MELHORIA (não regressão) — o
 *      "byte-idêntico" do funil vivo se refere ao provisioning do clone, não a esta coluna nova.
 */
export function mapSignupFormat(tipo: TipoAtendimento, modo: ModoIa): SignupFormatProvisioning {
  const productType: SignupProductType =
    tipo === 'estabelecimento' ? 'estabelecimento' : 'individual';
  const agendaAutomatica = modo === 'agenda';
  const seatCap = productType === 'estabelecimento' ? DEFAULT_ESTABELECIMENTO_SEAT_CAP : null;
  const modoAtendenteEnabled = !agendaAutomatica;
  // ADR 0027: agenda ⇒ billing-da-agenda. Vale pra individual+agenda também (formato novo
  // ganha o /billing bom; env-gated por-clone segue controlando o rollout efetivo).
  const billingFromAgendaEnabled = agendaAutomatica;

  let amountCents: number;
  if (productType === 'individual') {
    amountCents = agendaAutomatica
      ? SIGNUP_AMOUNT_CENTS_BY_FORMAT.individual_agenda
      : SIGNUP_AMOUNT_CENTS_BY_FORMAT.individual_atendente;
  } else {
    amountCents = agendaAutomatica
      ? SIGNUP_AMOUNT_CENTS_BY_FORMAT.estabelecimento_agenda
      : SIGNUP_AMOUNT_CENTS_BY_FORMAT.estabelecimento_atendente;
  }

  return {
    productType,
    seatCap,
    agendaAutomatica,
    modoAtendenteEnabled,
    billingFromAgendaEnabled,
    amountCents,
  };
}
