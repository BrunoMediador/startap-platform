/**
 * Helpers puros da comissão (tela Billing). Vivem fora do React pra serem testáveis
 * sem jsdom (convenção do portal). Cobre a formatação da % de comissão, que é
 * nullable no contrato (profissional sem comissão configurada -> "—" em vez de
 * renderizar null/0% cru — não repetir o bug de tipo do #344).
 */

/**
 * "%" da comissão de um profissional. `null` (não configurada) -> "—". Inteiro
 * vira "10%", fração vira "12,5%" (vírgula pt-BR, sem zeros à toa). Negativo/NaN
 * caem em "—" defensivamente.
 */
export function formatPctComissao(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct) || pct < 0) return '—';
  // Arredonda a 2 casas e tira zeros decimais sobrando: 10 -> "10", 12.5 -> "12,5".
  const rounded = Math.round(pct * 100) / 100;
  const str = String(rounded).replace('.', ',');
  return `${str}%`;
}
