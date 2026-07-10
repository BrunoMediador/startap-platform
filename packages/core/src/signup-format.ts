/**
 * signup-format.ts — mapeia as 2 perguntas de formato do signup (ADR 0030 D2) pra
 * config de provisioning dos 4 combos: individual/estabelecimento × agenda/atendente.
 *
 * Pergunta 1: "Você atende sozinho ou tem uma equipe?"  → tipo_atendimento
 * Pergunta 2: "A IA marca sozinha na sua agenda, ou só atende e encaminha?" → modo_ia
 *
 * Helper PURO (sem I/O): a validação Zod acontece no app (portal-signup); aqui só
 * traduz as respostas JÁ validadas → colunas/flags/preço. Reusável pelo wizard do
 * gestão (paridade ADR 0030 D2).
 *
 * REGRESSÃO ZERO (funil vivo): o combo `sozinho + agenda` = o signup ATUAL. O default
 * do schema (sozinho+agenda quando os campos vêm ausentes) reproduz isso, e o mapa
 * abaixo garante que individual+agenda NÃO ganha nenhuma flag/coluna nova nem preço
 * diferente do de hoje — byte-idêntico ao clone que o signup produz hoje.
 */

export type TipoAtendimento = 'sozinho' | 'equipe';
export type ModoIa = 'agenda' | 'atende';
export type SignupProductType = 'individual' | 'estabelecimento';

/**
 * Teto de colaboradores PLACEHOLDER pro estabelecimento novo do signup (editável no
 * gestão depois). 5 espelha o clone de teste dragon. Enforcement do teto vive no app
 * (ADR 0023), não no banco.
 */
export const DEFAULT_ESTABELECIMENTO_SEAT_CAP = 5;

/**
 * Grade de PREÇO placeholder por formato, em CENTAVOS (ADR 0030 D2; editável no gestão
 * depois via client_billing.amount_cents). O combo individual+agenda NÃO aparece aqui
 * de propósito: usa `baseIndividualAgendaCents` (= config.PORTAL_SIGNUP_AMOUNT_CENTS)
 * pra ficar byte-idêntico ao funil vivo.
 */
export const SIGNUP_AMOUNT_CENTS_BY_FORMAT = {
  individual_atendente: 9700, // R$97,00
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
 * @param tipo  resposta 1 (sozinho|equipe) → product_type.
 * @param modo  resposta 2 (agenda|atende)  → agenda_automatica.
 * @param baseIndividualAgendaCents  preço do combo individual+agenda = o do funil vivo
 *   (config.PORTAL_SIGNUP_AMOUNT_CENTS) — garante byte-identidade do signup atual.
 *
 * Mapa das colunas (migration 072 / ADR 0030 D2):
 *  - modo_atendente_enabled      = (agenda_automatica == false)  → liga o ramo atendente do bot.
 *  - billing_from_agenda_enabled = (agenda_automatica == true) SÓ no estabelecimento (formato
 *      NOVO). individual+agenda = FUNIL VIVO → NÃO liga a coluna (segue byte-idêntico; billing-da-
 *      agenda permanece env-gated/flip no gestão, sem regressão). Ver campo de prova de regressão.
 */
export function mapSignupFormat(
  tipo: TipoAtendimento,
  modo: ModoIa,
  baseIndividualAgendaCents: number,
): SignupFormatProvisioning {
  const productType: SignupProductType = tipo === 'equipe' ? 'estabelecimento' : 'individual';
  const agendaAutomatica = modo === 'agenda';
  const seatCap = productType === 'estabelecimento' ? DEFAULT_ESTABELECIMENTO_SEAT_CAP : null;
  const modoAtendenteEnabled = !agendaAutomatica;
  const billingFromAgendaEnabled = agendaAutomatica && productType === 'estabelecimento';

  let amountCents: number;
  if (productType === 'individual') {
    amountCents = agendaAutomatica
      ? baseIndividualAgendaCents // combo vivo — byte-idêntico
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
