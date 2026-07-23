/**
 * Copy do card de conexao do WhatsApp na tela /conectar, decidida por UM sinal:
 * o clone JA pareou alguma vez?
 *
 *   - PRIMEIRA conexao (nunca pareou): onboarding POSITIVO — "Falta so conectar...".
 *     Antes o dono NOVO, no momento no1 do onboarding, lia "Seu WhatsApp se
 *     desconectou / Reconectar" e achava que ja tinha quebrado (SCRUM-95).
 *   - RECONEXAO (ja pareou e caiu): copy vigente, INTOCADA (byte-identica).
 *
 * FONTE DO SINAL (contrato BE->FE): o backend ja tem o dado durvel —
 * flow_clones.first_connected_at (migration 062: NULL = nunca pareou; carimba
 * NOW() na 1a conexao e NUNCA volta a NULL). Falta EXPO-LO no GET /portal/conexao
 * como o boolean opcional `ever_connected` (ConexaoResponse.ever_connected).
 *
 * DEGRADACAO SEGURA: enquanto o backend NAO expoe o campo (`undefined`), assumimos
 * RECONEXAO. Isso mantem a producao byte-a-byte como hoje e nunca chama um cliente
 * real de "primeira vez" por engano. So `ever_connected === false` vira a copy nova.
 *
 * O caminho/acao NAO muda entre os dois casos (restart -> pareamento por codigo/QR):
 * so a moldura verbal muda. Modulo PURO (sem React/DOM) — testado no harness
 * pure-fn do portal (sem jsdom).
 */

/** Textos do card de conexao (fase `desconectado` da maquina de /conectar). */
export interface ConexaoCardCopy {
  /** Titulo do card (h2). */
  title: string;
  /** Rotulo do CTA primario quando livre (sem cooldown). */
  cta: string;
  /** Rotulo do CTA enquanto a acao roda (loading do botao). */
  ctaLoading: string;
  /** Microcopy abaixo do botao. */
  hint: string;
}

/**
 * RECONEXAO — copy VIGENTE em producao. NAO ALTERAR: e o caso byte-identico do
 * SCRUM-95 (cliente que ja conectou e caiu le exatamente o que lia antes).
 */
export const COPY_RECONEXAO: ConexaoCardCopy = {
  title: 'Seu WhatsApp se desconectou. Vamos reconectar.',
  cta: 'Reconectar WhatsApp',
  ctaLoading: 'Reconectando…',
  hint: 'Vai levar alguns segundos. Deixe essa tela aberta.',
};

/**
 * PRIMEIRA CONEXAO — onboarding positivo (clone que nunca pareou). Sem
 * "desconectou/reconectar": o dono novo esta CONECTANDO pela 1a vez, nada quebrou.
 */
export const COPY_PRIMEIRA_CONEXAO: ConexaoCardCopy = {
  title: 'Falta só conectar seu WhatsApp pra ativar o assistente.',
  cta: 'Conectar WhatsApp',
  ctaLoading: 'Conectando…',
  hint: 'Vai levar alguns segundos. Deixe essa tela aberta.',
};

/**
 * Escolhe a copy do card pela historia de pareamento do clone.
 *
 * @param everConnected `ConexaoResponse.ever_connected` — `false` = nunca pareou
 *   (primeira conexao); `true` = ja pareou antes (reconexao); `undefined` = backend
 *   ainda nao expoe o campo -> assume reconexao (default seguro, byte-identico).
 */
export function resolveConexaoCardCopy(everConnected: boolean | undefined): ConexaoCardCopy {
  return everConnected === false ? COPY_PRIMEIRA_CONEXAO : COPY_RECONEXAO;
}

/**
 * `true` sse e a PRIMEIRA conexao (nunca pareou) — atalho para a moldura visual do
 * card (tom neutro/marca no lugar do vermelho de "desconectou"). Mesma regra do
 * default seguro: so `false` explicito conta como primeira vez.
 */
export function isPrimeiraConexao(everConnected: boolean | undefined): boolean {
  return everConnected === false;
}
