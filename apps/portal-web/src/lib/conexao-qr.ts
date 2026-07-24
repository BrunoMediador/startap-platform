/**
 * Fallback esperto de pareamento (SCRUM-82, parte 2).
 *
 * O pareamento por CODIGO emite o codigo PARA o numero cadastrado do clone. Se o
 * WhatsApp na verdade esta em OUTRO numero (ex.: o dono cadastrou um fixo, ou errou
 * o numero), o codigo nunca e aceito e a tela fica presa em ciclos de "gerar novo
 * codigo" sem explicacao — foi o incidente real (cliente preso 5 ciclos em 12 min).
 *
 * O QR NAO depende do numero digitado (le a partir do proprio aparelho), entao apos
 * algumas tentativas de codigo sem chegar a WORKING a UI passa a SUGERIR ATIVAMENTE
 * o QR. Modulo PURO pra manter a decisao testavel sem DOM.
 */

/**
 * A partir de quantas tentativas de pareamento por CODIGO (cada codigo mostrado sem
 * conectar conta 1) a UI destaca o QR como caminho alternativo. N=2: a 1a tentativa
 * ainda pode ser so um deslize (codigo copiado errado, timeout); a 2a ja indica que
 * o codigo/numero nao esta fechando — hora de oferecer o QR de forma visivel.
 */
export const QR_SUGERIDO_APOS_TENTATIVAS = 2;

/** true quando ja houve tentativas de codigo suficientes pra promover o QR. */
export function deveSugerirQr(tentativas: number): boolean {
  return tentativas >= QR_SUGERIDO_APOS_TENTATIVAS;
}
