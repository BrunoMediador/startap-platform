/**
 * Normalização CANÔNICA de frase de pausa/retomada (flow_pause_keywords.keyword_norm).
 *
 * FONTE ÚNICA da normalização usada tanto:
 *  - pelo MATCHER do bot (apps/api/src/lib/manual-pause.ts:normalizeManualPauseCommand), que
 *    casa `mensagem.includes(keyword_norm)` no ramo fromMe; quanto
 *  - pela ESCRITA das frases no portal (apps/portal-api PUT /portal/frases-pausa), que grava
 *    keyword_norm.
 *
 * Se as duas divergirem, o dono cadastra uma frase que o bot NUNCA casa (bug silencioso).
 * Por isso é UMA função só. Regra: minúsculas + remove acentos (NFD sem marcas) + remove
 * TODO espaço em branco. Ex.: "Atendente Aqui!!" -> "atendenteaqui!!".
 */
export function normalizePauseKeyword(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, '');
}
