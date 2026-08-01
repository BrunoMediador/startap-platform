/**
 * cartao-catalog — validação de EMOJI LIVRE do cartão de confirmação (decisão do Bruno,
 * substitui a allowlist fechada do SCRUM-92 inc.2 / ADR 0032). O dono digita QUALQUER emoji do
 * teclado do dispositivo; o backend valida que é EXATAMENTE 1 emoji (nunca texto/letra/dígito/
 * múltiplos emojis/bytes invisíveis) antes de interpolar no systemPrompt do bot.
 *
 * ISTO É SEGURANÇA, NÃO COSMÉTICO: o valor validado aqui é colado dentro do system prompt (ver
 * bloco-estrutural.ts). Bytes invisíveis = vetor de prompt injection / poluição do prompt.
 *
 * COMO A VALIDAÇÃO É FEITA (e por que NÃO confiar só em grapheme/regex de emoji):
 *   1. `Intl.Segmenter` (granularity 'grapheme') EXIGE exatamente 1 cluster — barra de cara
 *      qualquer string com 2+ caracteres visuais, múltiplos emojis, ou emoji+texto colado.
 *   2. O cluster inteiro precisa casar `/^\p{RGI_Emoji}$/v` (Unicode property escape RGI —
 *      "Recommended for General Interchange": só sequências de emoji REGISTRADAS no padrão
 *      Unicode passam, incluindo ZWJ legítimo tipo 👨‍👩‍👧 e variation selector tipo ✂️). Isso
 *      sozinho já rejeita letra/dígito/pontuação/espaço/string vazia.
 *   3. ⚠️ FURO CONHECIDO do passo 2 sozinho: bandeiras de SUBDIVISÃO (ex. 🏴󠁧󠁢󠁳󠁣󠁴󠁿, Escócia) são
 *      RGI_Emoji válidas e usam TAG CHARS (U+E0000..U+E007F) por design — então "é RGI_Emoji"
 *      NÃO implica "não tem tag chars". Fechamos esse buraco com um DENY-LIST EXPLÍCITO de tag
 *      chars por cima (passo 4), aplicado ANTES do teste de RGI_Emoji — não dependemos de
 *      nenhuma engine tratar tag-char-sobre-emoji-comum como inválido por acidente.
 *   4. Deny-list explícito de ranges invisíveis/de controle, testado code-point a code-point:
 *      tag chars (U+E0000–U+E007F), variation selectors soltos fora de um par válido não é
 *      alcançável pelo passo 2 (RGI_Emoji já garante VS só em sequência reconhecida), ZWJ
 *      (U+200D) sozinho, ZWSP (U+200B), caracteres de controle C0/C1 (inclui \n, \t), etc.
 *      Esta checagem roda SEMPRE, mesmo que o passo 2 mude de engine/versão Unicode no futuro.
 *
 * Ordem de checagem: grapheme count === 1 → deny-list de code points suspeitos → RGI_Emoji.
 * Falha em qualquer etapa = rejeitado. Tudo NFC-normalizado antes de validar/gravar.
 */
import type { CartaoEmojiKey, CartaoTemplate } from './bloco-estrutural.js';
import {
  CARTAO_EMOJI_DISABLED,
  CARTAO_EMOJI_KEYS,
  resolveDefaultCartaoEmojis,
} from './bloco-estrutural.js';

const NFC = (s: string): string => s.normalize('NFC');

/** Regex RGI_Emoji (Unicode property escape, flag `v`/unicodeSets): só sequências de emoji
 *  REGISTRADAS no padrão Unicode (base, ZWJ sequences, variation selector, flags, keycaps...).
 *  Ancorada (^...$) contra a STRING INTEIRA — não usamos com `g`/`test` em substring.
 *
 *  Construída via `new RegExp(...)` (não literal `/.../v`) de propósito: a flag `v`/unicodeSets
 *  é suportada em RUNTIME desde Node 20 (engine V8, independente de `lib`), mas o TYPE-CHECKER
 *  do TS só aceita o LITERAL `/…/v` quando `target >= ES2024` — e este pacote roda ES2022
 *  (tsconfig.base.json do monorepo; subir o target é decisão de arquitetura, fora do escopo
 *  desta PR). `new RegExp` com a flag como string passa pelo runtime sem o gate do compilador. */
// biome-ignore lint/complexity/useRegexLiterals: literal /…/v exige target ES2024 no tsc (TS1501); ver comentário acima.
const RGI_EMOJI_WHOLE = new RegExp('^\\p{RGI_Emoji}$', 'v');

/** Segmentador de grapheme cluster — usado só pra CONTAR clusters visuais (1 e só 1). A escolha
 *  do emoji em si é validada pelo RGI_Emoji + deny-list abaixo, nunca só pelo grapheme (um
 *  grapheme cluster pode "engolir" tag chars coladas — ver furo documentado acima). */
const GRAPHEME_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * Deny-list EXPLÍCITA de code points que nunca podem aparecer, mesmo dentro de um cluster que o
 * RGI_Emoji aceitaria (defesa em profundidade — não depende de o passo RGI_Emoji continuar
 * rejeitando esses casos numa versão futura do Unicode/engine).
 */
function hasDeniedCodePoint(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    // Tag chars (U+E0000–U+E007F) — o vetor de injeção que motivou esta validação inteira.
    // NUNCA legítimo aqui: mesmo quando parte de uma bandeira de subdivisão RGI válida
    // (ex. 🏴 Inglaterra/Escócia), o domínio do produto não usa essas bandeiras — rejeitamos
    // por cima do RGI_Emoji de propósito (defesa em profundidade, ver cabeçalho do arquivo).
    if (cp >= 0xe0000 && cp <= 0xe007f) return true;
    // Controle C0 (inclui \n \t \r) e DEL, e controle C1 (U+0080–U+009F). Nunca legítimo.
    if (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return true;
    // Espaços/formatação invisíveis que NUNCA fazem parte de uma sequência RGI_Emoji válida:
    // ZWSP, ZWNJ, LRM/RLM, separadores de linha/parágrafo Unicode, BOM/ZWNBSP.
    // ⚠️ ZWJ (U+200D) e variation selectors (U+FE0F/U+FE0E) NÃO entram aqui de propósito: eles
    // SÃO legítimos dentro de sequências RGI reconhecidas (👨‍👩‍👧 usa ZWJ; ✂️ usa VS16) — é
    // exatamente o papel do RGI_Emoji (passo seguinte) decidir se a sequência COMPLETA é válida.
    // Um ZWJ/VS "solto" (sem base emoji válida ao redor) já reprova sozinho no teste RGI_Emoji,
    // porque a sequência inteira não casa nenhum padrão RGI — não precisamos negá-lo aqui.
    if (
      cp === 0x200b || // ZWSP
      cp === 0x200c || // ZWNJ
      cp === 0x200e || // LRM
      cp === 0x200f || // RLM
      cp === 0x2028 || // LINE SEPARATOR
      cp === 0x2029 || // PARAGRAPH SEPARATOR
      cp === 0xfeff // ZERO WIDTH NO-BREAK SPACE / BOM
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Valida que `input` é EXATAMENTE 1 emoji (grapheme cluster único, RGI_Emoji, sem code points
 * negados). Puro/determinístico, sem I/O. Usado tanto pelo PUT do endpoint quanto por qualquer
 * outro caller que precise validar um emoji livre.
 */
export function isSingleValidEmoji(input: unknown): input is string {
  if (typeof input !== 'string' || input.length === 0) return false;
  const s = NFC(input);
  if (s.length === 0) return false;
  if (hasDeniedCodePoint(s)) return false;
  const clusters = [...GRAPHEME_SEGMENTER.segment(s)].map((seg) => seg.segment);
  if (clusters.length !== 1) return false;
  return RGI_EMOJI_WHOLE.test(s);
}

/**
 * O emoji é um valor ACEITÁVEL pra esta chave? (emoji livre — a chave não restringe mais o
 * conjunto, mantida na assinatura por compat com os callers existentes e pra abrir espaço a
 * uma futura regra por-chave sem quebrar contrato.) Delega inteiramente pra isSingleValidEmoji.
 */
export function isEmojiAllowed(_key: CartaoEmojiKey, emoji: unknown): boolean {
  return isSingleValidEmoji(emoji);
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
 * Valida o mapa de emojis do PUT: EMOJI LIVRE (isSingleValidEmoji) OU o sentinela
 * CARTAO_EMOJI_DISABLED (desabilita o ícone daquela chave — ver bloco-estrutural.ts). Aceita SÓ
 * as 7 chaves conhecidas; qualquer outro valor → { ok:false, invalidKey } (o endpoint devolve
 * 400). Chave ausente = simplesmente não entra (override parcial — herda o default da área, não
 * confundir com o sentinela). Emojis livres são RE-NORMALIZADOS (NFC) antes de gravar; o
 * sentinela passa direto (não é um emoji, NFC não o altera, mas evita a chamada desnecessária).
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
    if (v === CARTAO_EMOJI_DISABLED) {
      out[k] = CARTAO_EMOJI_DISABLED;
      continue;
    }
    if (!isEmojiAllowed(k, v)) return { ok: false, invalidKey: k };
    out[k] = NFC(v as string);
  }
  return { ok: true, emojis: out };
}

/**
 * Rótulos textuais que aparecem nos templates conhecidos (padrao/compacto/detalhado, ver
 * bloco-estrutural.ts) IMEDIATAMENTE depois do emoji daquela chave — usados só pra achar a
 * POSIÇÃO do emoji no texto (nunca pra decidir se um emoji é válido; isso é isSingleValidEmoji).
 * `marca` e `confirma` não têm rótulo textual: `marca` é sempre o 1º emoji da 1ª linha do
 * cartão; `confirma` é o emoji ao FINAL da linha "Responda SIM"/"pedindo:"/"peça:".
 */
const LABELED_KEYS: readonly Exclude<CartaoEmojiKey, 'marca' | 'confirma'>[] = [
  'profissional',
  'dia',
  'horario',
  'servico',
  'valor',
];
const LABEL_TEXT: Record<(typeof LABELED_KEYS)[number], string> = {
  profissional: 'PROFISSIONAL',
  dia: 'DIA',
  horario: 'HORARIO',
  servico: 'SERVICO',
  valor: 'VALOR',
};

/** 1º grapheme cluster de `s` que passa isSingleValidEmoji. undefined se nenhum grapheme
 *  validar como emoji único. Usado pra `marca`/`confirma` (linha isolada, só 1 emoji esperado). */
function firstValidEmojiIn(s: string): string | undefined {
  for (const { segment } of GRAPHEME_SEGMENTER.segment(s)) {
    if (isSingleValidEmoji(segment)) return segment;
  }
  return undefined;
}

/** ÚLTIMO grapheme cluster de `s` que passa isSingleValidEmoji — o mais PRÓXIMO à direita (ex.:
 *  imediatamente antes de um rótulo). Necessário quando `s` pode conter emojis de OUTROS campos
 *  antes do que interessa (layout padrao junta DIA/HORARIO/SERVICO/VALOR na mesma linha,
 *  separados por " / " — pegar o 1º emoji da linha inteira pegaria sempre o de DIA). */
function lastValidEmojiIn(s: string): string | undefined {
  let found: string | undefined;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(s)) {
    if (isSingleValidEmoji(segment)) found = segment;
  }
  return found;
}

/**
 * Extrai emojis-SEED de um cartão capturado VERBATIM (pra pré-preencher o picker de um clone
 * MIGRADO/legado — refinamento Bruno 23/07; adaptado pra emoji LIVRE). Com a allowlist aberta,
 * não dá mais pra "achar um emoji conhecido no texto" (CATALOG não existe mais) — em vez disso
 * extrai por POSIÇÃO/RÓTULO: pra cada chave rotulada (DIA/HORARIO/SERVICO/VALOR/PROFISSIONAL),
 * pega o emoji que aparece na MESMA LINHA do rótulo, ANTES dele (layout `<emoji> RÓTULO: valor`
 * dos templates padrao/detalhado, ou `<emoji> valor` no compacto — o rótulo pode estar ausente
 * no compacto, então cai no fallback abaixo). `marca` = 1º emoji da 1ª linha não-vazia do
 * cartão. `confirma` = emoji da linha que contém "Responda SIM" (ou "peça:"/"pedindo:").
 *
 * CRÍTICO (Samuel tem marca E servico = ✂️): por isso NÃO buscamos "qual chave esse emoji
 * pertence" — buscamos "qual emoji está na vizinhança de QUAL RÓTULO", que é posicional e não
 * confunde duas chaves com o mesmo emoji.
 *
 * Puro/best-effort: NUNCA lança; um cartão exótico/sem rótulos simplesmente rende poucos ou
 * nenhum seed (o dono ajusta/escolhe na tela). Ausência → não seta a chave (app cai no default).
 */
export function extractSeedEmojis(cartaoText: unknown): Partial<Record<CartaoEmojiKey, string>> {
  const out: Partial<Record<CartaoEmojiKey, string>> = {};
  if (typeof cartaoText !== 'string' || cartaoText.trim() === '') return out;
  const text = NFC(cartaoText);
  const linhas = text.split('\n');

  // marca: 1º emoji válido na 1ª linha não-vazia do cartão.
  const primeiraLinha = linhas.find((l) => l.trim() !== '');
  if (primeiraLinha) {
    const m = firstValidEmojiIn(primeiraLinha);
    if (m) out.marca = m;
  }

  // confirma: emoji na linha de fechamento ("Responda SIM"/"peça:"/"pedindo:").
  const linhaConfirma = linhas.find((l) => /Responda SIM|pe[çc]a:|pedindo:/i.test(l));
  if (linhaConfirma) {
    const c = firstValidEmojiIn(linhaConfirma);
    if (c) out.confirma = c;
  }

  // chaves rotuladas: emoji IMEDIATAMENTE antes do rótulo (padrao/detalhado). O template
  // 'padrao' junta DIA/HORARIO/SERVICO/VALOR na MESMA linha (" / " entre eles) — por isso
  // pegamos o ÚLTIMO emoji válido antes do rótulo (o mais PRÓXIMO à esquerda), nunca o 1º da
  // linha inteira, senão HORARIO/SERVICO/VALOR roubariam o emoji de DIA (o campo anterior).
  // No compacto o rótulo textual some → a chave simplesmente não é semeada (best-effort).
  for (const k of LABELED_KEYS) {
    const label = LABEL_TEXT[k];
    const linha = linhas.find((l) => l.includes(label));
    if (!linha) continue;
    const idxLabel = linha.indexOf(label);
    const antesDoLabel = linha.slice(0, idxLabel);
    const emoji = lastValidEmojiIn(antesDoLabel);
    if (emoji) out[k] = emoji;
  }

  return out;
}

// Re-export leve pros callers do endpoint não precisarem importar de 2 módulos.
export { CARTAO_EMOJI_KEYS, resolveDefaultCartaoEmojis };
export type { CartaoEmojiKey, CartaoTemplate };
