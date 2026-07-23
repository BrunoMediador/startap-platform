/**
 * cartao-extract — extração VERBATIM do cartão de confirmação BAKED de um bot_prompt, pro
 * script de migração (SCRUM-92 inc.2 / ADR 0032, refinamento Bruno 23/07).
 *
 * OBJETIVO: migrar um clone existente pra cartao_mode='runtime' com ZERO mudança visível — o
 * cartão que ele JÁ tem sai do bot_prompt (baked) e é reproduzido LITERALMENTE em runtime
 * (buildCartaoRuntimeBlock via cartao_config.verbatim). Pra isso a extração tem que:
 *   1. localizar o bloco do cartão com FRONTEIRAS CLARAS (marcador estrutural OU seção
 *      [CARTAO DE CONFIRMACAO]);
 *   2. exigir que o cartão seja o bloco TRAILING do prompt (nada relevante depois dele) — só
 *      assim removê-lo do bot_prompt não estilhaça o texto no meio da persona;
 *   3. devolver o cartão VERBATIM + a persona-only (sem o cartão).
 *
 * Se NÃO houver fronteira clara OU o cartão estiver no MEIO (interwoven, refs espalhadas) →
 * `found:false`: o clone NÃO é migrável e o script o mantém BAKED (fallback seguro > mudar o
 * cartão de um pagante). PURO/determinístico — o script decide o que fazer com o resultado.
 *
 * Trabalha por linha ('\n'); reconstrói o cartão byte-a-byte (join('\n') do intervalo original).
 */
import { BLOCO_ESTRUTURAL_MARKER } from './bloco-estrutural.js';

export type CartaoExtract =
  | {
      found: true;
      /** bot_prompt SEM o cartão (persona-only), blanks finais aparados. */
      personaOnly: string;
      /** o cartão capturado LITERALMENTE (vira cartao_config.verbatim). */
      cartao: string;
      /** como foi encontrado: 'bloco' = marcador estrutural (persona gerada); 'template' =
       *  seção [CARTAO DE CONFIRMACAO] (template Cirilo/Samuel). */
      strategy: 'bloco' | 'template';
    }
  | { found: false; reason: 'sem_cartao' | 'cartao_nao_trailing' };

/** Linha é um cabeçalho de seção do tipo `[ALGO]` no início da linha. */
function isSectionHeader(line: string): boolean {
  return /^\[[^\]]+\]/.test(line);
}

/** Linha é o rodapé de régua `====...====` do bloco estrutural. */
function isFooterRule(line: string): boolean {
  const t = line.trim();
  return /^=+$/.test(t) && t.length >= 10;
}

/** Apara linhas em branco do FINAL de um array (sem tocar o miolo). */
function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  return lines.slice(0, end);
}

/** As linhas de `from` até o fim são todas em branco? (cartão é trailing.) */
function restIsBlank(lines: string[], from: number): boolean {
  for (let i = from; i < lines.length; i++) {
    if (lines[i].trim() !== '') return false;
  }
  return true;
}

/**
 * Extrai o cartão baked de um bot_prompt. Preferência: bloco estrutural (marcador) > seção
 * [CARTAO DE CONFIRMACAO]. Exige TRAILING nos dois casos. Sem cartão / não-trailing → found:false.
 */
export function extractBakedCartao(botPrompt: string): CartaoExtract {
  if (typeof botPrompt !== 'string' || botPrompt.trim() === '') {
    return { found: false, reason: 'sem_cartao' };
  }
  const lines = botPrompt.split('\n');

  // ── Estratégia 'bloco' (persona gerada pelo builder): HEADER ... rodapé ===== ─────────────
  const markerIdx = lines.findIndex((l) => l === BLOCO_ESTRUTURAL_MARKER);
  if (markerIdx >= 0) {
    const footerIdx = lines.findIndex((l, i) => i > markerIdx && isFooterRule(l));
    if (footerIdx > markerIdx) {
      if (!restIsBlank(lines, footerIdx + 1)) {
        return { found: false, reason: 'cartao_nao_trailing' };
      }
      const cartao = lines.slice(markerIdx, footerIdx + 1).join('\n');
      const personaOnly = trimTrailingBlank(lines.slice(0, markerIdx)).join('\n');
      return { found: true, personaOnly, cartao, strategy: 'bloco' };
    }
  }

  // ── Estratégia 'template': seção [CARTAO DE CONFIRMACAO ...] até a PRÓXIMA seção/EOF ───────
  const cartaoHeaderIdx = lines.findIndex((l) => /^\[CARTAO DE CONFIRMACAO/i.test(l));
  if (cartaoHeaderIdx >= 0) {
    let sectionEnd = lines.length;
    for (let i = cartaoHeaderIdx + 1; i < lines.length; i++) {
      if (isSectionHeader(lines[i])) {
        sectionEnd = i;
        break;
      }
    }
    if (!restIsBlank(lines, sectionEnd)) {
      // Há OUTRA seção depois do cartão → cartão não é trailing → não migrável (fica baked).
      return { found: false, reason: 'cartao_nao_trailing' };
    }
    const cartao = trimTrailingBlank(lines.slice(cartaoHeaderIdx, sectionEnd)).join('\n');
    const personaOnly = trimTrailingBlank(lines.slice(0, cartaoHeaderIdx)).join('\n');
    return { found: true, personaOnly, cartao, strategy: 'template' };
  }

  return { found: false, reason: 'sem_cartao' };
}
