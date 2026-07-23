/**
 * cartao-catalog — ALLOWLIST FECHADA de emojis do cartão de confirmação (SCRUM-92 inc.2 /
 * ADR 0032, decisão do security).
 *
 * REGRA DE SEGURANÇA (crítica): o dono NUNCA digita emoji livre. Ele ESCOLHE de um catálogo
 * FECHADO por chave (marca/dia/horario/servico/valor/confirma/profissional). O PUT do endpoint
 * SÓ aceita um valor que está no catálogo daquela chave; qualquer outra coisa = 400.
 *
 * COMO A VALIDAÇÃO É FEITA (e por que NÃO por "categoria/grapheme"):
 *   validar "é um emoji?" por categoria Unicode/grapheme FURA — um emoji base seguido de
 *   TAG CHARS (U+E0000..U+E007F, usados em sequências de bandeira de subdivisão) passaria no
 *   teste de grapheme e injetaria bytes invisíveis no systemPrompt. Aqui a validação é
 *   COMPARAÇÃO DA SEQUÊNCIA INTEIRA (após NFC) contra o Set do catálogo: `✂️` + tag chars
 *   NÃO é igual a `✂️`, então é rejeitado. Set membership exato = allowlist fechada de verdade.
 *
 * O CATÁLOGO: base = TODO emoji default por área (allAreaDefaultEmojiSets — garante que o
 * default de qualquer área é sempre válido) UNIÃO um conjunto CURADO por chave (EXTRA) que
 * espelha o picker da UI (feat/scrum92-cartao-config-ui). O resultado é o contrato COMPARTILHADO
 * com a UI: a UI oferece exatamente esses emojis e derruba (sanitizeEmojis) qualquer coisa fora.
 *
 * Tudo NFC-normalizado no build E na validação. Puro/determinístico, sem I/O.
 */
import {
  CARTAO_EMOJI_KEYS,
  type CartaoEmojiKey,
  type CartaoTemplate,
  allAreaDefaultEmojiSets,
  resolveDefaultCartaoEmojis,
} from './bloco-estrutural.js';

const NFC = (s: string): string => s.normalize('NFC');

/**
 * Conjunto CURADO de emojis extras por chave (além dos defaults por área). Espelha o picker
 * da UI (EMOJI_CATALOG em apps/portal-web/src/lib/cartao-config.ts). Mantido explícito de
 * propósito: um humano decide o que entra na allowlist (nunca uma heurística). Se a UI mudar,
 * este set muda junto (contrato compartilhado; teste trava a paridade).
 */
const EXTRA: Record<CartaoEmojiKey, string[]> = {
  // 🌻 (marca) e 📝 (servico) = emojis da Ingrid (clone migrado à mão). Entram na allowlist
  // para o PUT do portal aceitar a config dela e o picker oferecer os mesmos ícones (SCRUM-92).
  marca: ['✂️', '🌻'],
  dia: ['🗓️', '📆'],
  horario: ['⌚'],
  servico: ['💇', '📝'],
  valor: ['💵', '💲', '🪙'],
  confirma: ['☑️', '👍'],
  profissional: ['🧑‍🔧', '💇‍♂️'],
};

/**
 * Catálogo FECHADO por chave, como Set<string> NFC-normalizado. Construído 1x no load:
 *   base (union de todos os defaults por área, incl. 🕐 do estabelecimento) ∪ EXTRA.
 * Cada chave vira um Set pra membership O(1) exata.
 */
const CATALOG: Record<CartaoEmojiKey, ReadonlySet<string>> = (() => {
  const acc: Record<CartaoEmojiKey, Set<string>> = {
    marca: new Set(),
    dia: new Set(),
    horario: new Set(),
    servico: new Set(),
    valor: new Set(),
    confirma: new Set(),
    profissional: new Set(),
  };
  // Base: todo default por área (agenda + estabelecimento) → garante default sempre válido.
  for (const set of allAreaDefaultEmojiSets()) {
    for (const k of CARTAO_EMOJI_KEYS) acc[k].add(NFC(set[k]));
  }
  // Extra curado (paridade com o picker da UI).
  for (const k of CARTAO_EMOJI_KEYS) {
    for (const e of EXTRA[k]) acc[k].add(NFC(e));
  }
  return acc;
})();

/** O emoji está na allowlist FECHADA daquela chave? (NFC + sequência inteira.) */
export function isEmojiAllowed(key: CartaoEmojiKey, emoji: unknown): boolean {
  if (typeof emoji !== 'string') return false;
  return CATALOG[key].has(NFC(emoji));
}

/** Catálogo por chave como arrays (ordem: defaults primeiro, na ordem das áreas; depois extra).
 *  Exposto pra teste/paridade e, se um dia a UI quiser consumir do backend, pro contrato. */
export function emojiCatalog(): Record<CartaoEmojiKey, string[]> {
  const out = {} as Record<CartaoEmojiKey, string[]>;
  for (const k of CARTAO_EMOJI_KEYS) out[k] = [...CATALOG[k]];
  return out;
}

/** Templates válidos (enum fechado). */
export const CARTAO_TEMPLATES: readonly CartaoTemplate[] = ['padrao', 'compacto', 'detalhado'];

export function isTemplateAllowed(v: unknown): v is CartaoTemplate {
  return v === 'padrao' || v === 'compacto' || v === 'detalhado';
}

/** Resultado da validação do body de emojis do PUT. */
export type EmojiValidation =
  | { ok: true; emojis: Partial<Record<CartaoEmojiKey, string>> }
  | { ok: false; invalidKey: string };

/**
 * Valida o mapa de emojis do PUT contra a allowlist FECHADA. Aceita SÓ as 7 chaves conhecidas;
 * cada valor tem que estar no catálogo daquela chave (NFC + sequência inteira). Chave
 * desconhecida OU valor fora do catálogo → { ok:false, invalidKey } (o endpoint devolve 400).
 * Chave ausente = simplesmente não entra (override parcial). Os valores aceitos são
 * RE-NORMALIZADOS (NFC) antes de gravar — o banco guarda a forma canônica.
 */
export function validateCartaoEmojis(raw: unknown): EmojiValidation {
  if (raw == null) return { ok: true, emojis: {} };
  if (typeof raw !== 'object') return { ok: false, invalidKey: '<emojis>' };
  const src = raw as Record<string, unknown>;
  const out: Partial<Record<CartaoEmojiKey, string>> = {};
  const allowed = new Set<string>(CARTAO_EMOJI_KEYS);
  for (const key of Object.keys(src)) {
    if (!allowed.has(key)) return { ok: false, invalidKey: key };
    const k = key as CartaoEmojiKey;
    const v = src[k];
    if (v === undefined) continue;
    if (!isEmojiAllowed(k, v)) return { ok: false, invalidKey: k };
    out[k] = NFC(v as string);
  }
  return { ok: true, emojis: out };
}

/**
 * Extrai emojis-SEED de um cartão capturado VERBATIM (pra pré-preencher o picker de um clone
 * MIGRADO — refinamento Bruno 23/07). Por chave, na ordem em que a chave é rotulada no texto
 * (DIA/HORARIO/SERVICO/VALOR/PROFISSIONAL) ou, na falta de rótulo, o 1º emoji do catálogo
 * daquela chave que aparecer no texto. Só devolve emojis que estão na allowlist (o picker é
 * fechado). Ausência → não seta a chave (o app cai no default da área). Puro/best-effort:
 * NUNCA lança; um cartão exótico simplesmente rende poucos seeds (o dono ajusta na tela).
 */
export function extractSeedEmojis(cartaoText: unknown): Partial<Record<CartaoEmojiKey, string>> {
  const out: Partial<Record<CartaoEmojiKey, string>> = {};
  if (typeof cartaoText !== 'string' || cartaoText.trim() === '') return out;
  const text = NFC(cartaoText);
  for (const k of CARTAO_EMOJI_KEYS) {
    for (const cand of CATALOG[k]) {
      if (text.includes(cand)) {
        out[k] = cand;
        break;
      }
    }
  }
  return out;
}

// Re-export leve pros callers do endpoint não precisarem importar de 2 módulos.
export { CARTAO_EMOJI_KEYS, resolveDefaultCartaoEmojis };
export type { CartaoEmojiKey, CartaoTemplate };
