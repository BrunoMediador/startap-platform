/**
 * Termo canônico do bot na COPY DO PORTAL (SCRUM-97).
 *
 * Decisão do Bruno: na UI do portal (a chrome que o DONO lê — títulos, labels,
 * toasts, subtítulos) o bot é sempre chamado de "assistente" (masculino/neutro:
 * "o assistente" / "seu assistente"). Antes a copy misturava "robô", "atendente"
 * e "assistente" — este arquivo é a fonte de verdade da REDAÇÃO canônica.
 *
 * Trocar o termo no futuro = mexer aqui + um grep pela palavra na copy literal.
 *
 * USO:
 *   - Copy definida como DADO (lib/*.ts, objetos de copy): importe as constantes.
 *   - Texto literal dentro de JSX: use a palavra "assistente" direto (a redação
 *     canônica continua ancorada aqui).
 *
 * NÃO USAR para:
 *   - Identificadores / flags / chaves: `modo_atendente`, `MODO_ATENDENTE_SLOTS`,
 *     props, hooks, tipos, rotas, classes CSS.
 *   - O rótulo do MODO/FORMATO "atendente" (pré-venda que escala pra humano).
 *   - Verbos de ação: "atender", "atendimento(s)".
 *   - Persona / prompt do bot, exemplos de persona ou frases que aparecem na
 *     conversa com o CLIENTE FINAL (cada dono personaliza — NÃO se centraliza).
 */
export const TERMO_ASSISTENTE = 'assistente' as const;

/** "o assistente" — sujeito/objeto genérico em copy corrida. */
export const O_ASSISTENTE = `o ${TERMO_ASSISTENTE}` as const;

/** "seu assistente" — posse (o assistente do dono). */
export const SEU_ASSISTENTE = `seu ${TERMO_ASSISTENTE}` as const;
