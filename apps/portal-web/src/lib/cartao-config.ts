'use client';

/**
 * Cliente + lógica pura da "Cartão de confirmação" (SCRUM-92, increment 2 / ADR 0032) —
 * a seção de "Meu atendente" onde o dono escolhe o TEMPLATE e os EMOJIS do cartão de
 * agendamento que o bot manda ANTES de marcar.
 *
 * ── CONTRATO (refinamento Bruno 23/07, endpoint #475/#476; emoji livre = PR 1 backend) ──
 * A tela aparece pra TODO cliente elegível, já preenchida com o cartão ATUAL dele (seed).
 * Salvar flipa SÓ aquele cliente pra runtime com a escolha dele; quem não mexe segue
 * idêntico. O endpoint decide se o clone é editável ou travado:
 *
 *   GET/PUT /portal/cartao-config ->
 *     { mode:'baked'|'runtime',
 *       editable: boolean,
 *       locked_reason: 'prompt_custom' | 'requer_revisao' | null,
 *       config: { template, emojis } | null,   // seed do picker (só quando editable)
 *       defaults: { template, emojis },
 *       canDisable: false,
 *       preview: string | null,                // bloco INTERNO do runtime — NÃO exibir cru
 *       previews: { padrao, compacto, detalhado },        // prévia FIEL, string (SCRUM-99)
 *       previewsSegmentados: { padrao, compacto, detalhado } } // MESMO conteúdo, em segmentos
 *
 * 4 estados que a UI renderiza (função pura `normalizeCartaoResponse`):
 *   1. editable  (editable:true)              -> formulário completo, picker seedado de `config`
 *   2. locked    (locked_reason:'prompt_custom')    -> read-only + nota "personalizado pela equipe"
 *   3. locked    (locked_reason:'requer_revisao')   -> read-only + nota "fale com o suporte"
 *   4. hidden    (404/flag OFF/erro/resposta inválida) -> a seção SOME (degradação graciosa)
 *
 * PREVIEW: o `preview` do endpoint é o BLOCO ESTRUTURAL do runtime (system-prompt cru, com
 * "REGRA CRITICA" e placeholders `<dia>`) — jamais mostrado ao dono. A prévia amigável (estilo
 * bolha de WhatsApp) é montada AQUI no client por `buildCartaoPreview` (fallback client), mas o
 * caminho principal usa `previews`/`previewsSegmentados` do backend (fonte fiel).
 *
 * ── EDITOR-NA-PRÉVIA (PR 2/front) ──────────────────────────────────────────────────────
 * O seletor de template CONTINUA existindo por baixo (`CartaoTemplate`), mas o SELETOR visual
 * sai da tela (decisão do Bruno) — o template vem seedado do servidor e é reenviado como está.
 * O picker de emoji fechado por catálogo (`EMOJI_CATALOG`) também sai: agora é EMOJI LIVRE do
 * teclado do dispositivo, validado estritamente (mesma regra do backend, reimplementada aqui —
 * ver `isSingleValidEmoji` abaixo — porque `apps/portal-web` não importa `@startap/integrations`,
 * é bundle Next sem workspace dep; teste de paridade em `cartao-emoji-validation.test.ts` lê o
 * arquivo do outro pacote como TEXTO e trava a divergência, mesmo padrão de
 * `prompt-telas-citadas.test.ts`). Cada emoji vira um segmento clicável na prévia
 * (`CartaoExemploSegmento`, espelha `bloco-estrutural.ts`), com 2 ações: Editar (troca o emoji)
 * e Desabilitar (grava o sentinela `CARTAO_EMOJI_DISABLED` — a linha perde só o ícone).
 *
 * Só transporte tipado + funções puras (sem React/DOM), testáveis em node.
 */
import { ApiError, apiFetch } from './api';
import { O_ASSISTENTE } from './termos';

// ── Slots, templates e catálogo fechado ─────────────────────────────────────────

/** Campos do cartão que ganham emoji, na ordem em que aparecem na tela. Espelha
 *  CARTAO_EMOJI_KEYS do backend (marca/dia/horario/servico/valor/confirma/profissional). */
export const CARTAO_SLOTS = [
  'marca',
  'dia',
  'horario',
  'servico',
  'valor',
  'confirma',
  'profissional',
] as const;

export type CartaoSlot = (typeof CARTAO_SLOTS)[number];
export type CartaoEmojis = Record<CartaoSlot, string>;
export type CartaoTemplate = 'padrao' | 'compacto' | 'detalhado';
export type CartaoMode = 'baked' | 'runtime';
export type CartaoLockedReason = 'prompt_custom' | 'requer_revisao';

/**
 * SENTINELA de "emoji DESABILITADO" pra uma chave — duplicata INTENCIONAL de
 * `CARTAO_EMOJI_DISABLED` (`packages/integrations/src/prompt-builder/bloco-estrutural.ts`).
 * `apps/portal-web` não importa `@startap/integrations` (bundle Next sem workspace dep) — a
 * paridade do VALOR é travada por teste (`cartao-emoji-validation.test.ts`, lê o arquivo do
 * outro pacote como texto). Gravado em `emojis[slot]` no lugar de um emoji pra desabilitar só o
 * ÍCONE daquele campo — a linha continua (`💈 Barbearia X` → `Barbearia X`).
 */
export const CARTAO_EMOJI_DISABLED = '__off__' as const;

/** Default seguro se o backend não mandar defaults (1º emoji de cada slot). */
export const FALLBACK_EMOJIS: CartaoEmojis = {
  marca: '💈',
  dia: '📅',
  horario: '⏰',
  servico: '✂️',
  valor: '💰',
  confirma: '✅',
  profissional: '👤',
};
export const FALLBACK_TEMPLATE: CartaoTemplate = 'padrao';

// ── COPY (DRAFT — o PM confirma com o Bruno antes do ar) ──────────────────────────
//
// TODA string que o cliente vê mora aqui, centralizada. São RASCUNHOS: tom PME, PT-BR
// curto, mobile-first. Não gravar PII. Trocar aqui não mexe na lógica.

export const CARTAO_COPY = {
  /** Cabeçalho da seção. */
  titulo: 'Cartão de confirmação',
  subtitulo: `O cartão que ${O_ASSISTENTE} manda antes de marcar um horário. Toque em qualquer emoji abaixo para trocar ou desligar.`,

  /** Aviso fixo (só nos estados editáveis) — a confirmação em si não pode ser desativada. */
  avisoFixo:
    '⚠️ A confirmação antes de agendar não pode ser desativada — ela protege sua agenda. Aqui você muda só a aparência do cartão.',

  slotLabels: {
    marca: 'Negócio',
    dia: 'Dia',
    horario: 'Horário',
    servico: 'Serviço',
    valor: 'Valor',
    confirma: 'Confirmação',
    profissional: 'Profissional',
  } as Record<CartaoSlot, string>,

  /** Prévia / editor. */
  previaLabel: 'Prévia do cartão',
  previaRodape: 'É um exemplo. O assistente troca os dados pelo agendamento real do cliente.',
  editorAjuda: 'Toque em qualquer emoji do cartão para trocar ou desligar.',

  /** Menu de ação sobre um emoji (sheet). */
  menuEditar: 'Editar',
  menuDesabilitar: 'Desabilitar',
  menuReabilitar: 'Reabilitar',
  menuFechar: 'Fechar',
  menuTitulo: (label: string) => `Emoji do campo ${label}`,
  menuAtual: 'Emoji atual:',

  /** Régua de campos com o emoji desligado (abaixo da bolha) — permite reabilitar. */
  desligadosLabel: 'Sem emoji:',

  /** aria-label do emoji clicável dentro do cartão. */
  emojiBotaoAria: (label: string, emoji: string) =>
    `Emoji do campo ${label}: ${emoji}. Tocar para editar ou desligar.`,

  /** Campo de edição de emoji. */
  editorCampoLabel: 'Novo emoji',
  editorCampoAjuda: 'Cole ou digite um emoji do teclado do seu aparelho.',
  editorSalvar: 'Usar este emoji',
  editorCancelar: 'Cancelar',
  editorErroVazio: 'Digite um emoji.',
  editorErroInvalido: 'Isso não é um emoji único válido. Tente outro.',

  /** Botão salvar + status. */
  salvar: 'Salvar cartão',
  salvando: 'Salvando…',
  statusSujo: 'Você tem alterações não salvas.',
  statusSalvo: 'Tudo salvo. É só a aparência do cartão — você pode mudar quando quiser.',
  statusInvalido: 'Corrija o emoji destacado para salvar.',
  toastSucesso: 'Cartão atualizado',
  toastErro: 'Não foi possível salvar. Tente de novo.',

  /** Estados travados (read-only). */
  lockPreviaLabel: 'Seu cartão de confirmação',
  lockNota: {
    prompt_custom:
      'Seu cartão foi personalizado pela nossa equipe. Fale com o suporte para ajustar.',
    requer_revisao: 'Para personalizar seu cartão, fale com o suporte.',
  } as Record<CartaoLockedReason, string>,
  lockCta: 'Falar com o suporte',
} as const;

/** Amostra fictícia usada no preview ao vivo (PME genérica). Também DRAFT. */
/** Campos da amostra do preview. Tipo largo (`string`) de propósito: o `as const` da
 *  constante abaixo congela os VALORES padrão, mas o tipo não pode exigir esses literais —
 *  senão passar uma amostra customizada (`{...PREVIEW_SAMPLE, servico: 'Barba'}`) não compila. */
export type CartaoSample = Record<CartaoSlot, string>;

export const PREVIEW_SAMPLE: CartaoSample = {
  marca: 'Barbearia do Zé',
  dia: 'quinta, 24/07',
  horario: '15:00',
  servico: 'Corte',
  valor: 'R$ 65',
  confirma: 'Posso confirmar?',
  profissional: 'Léo',
} as const;

// ── Contratos crus + estado normalizado ─────────────────────────────────────────

interface RawCartaoConfig {
  template?: unknown;
  emojis?: unknown;
}
interface RawCartaoResponse {
  mode?: unknown;
  editable?: unknown;
  locked_reason?: unknown;
  config?: RawCartaoConfig | null;
  defaults?: RawCartaoConfig;
  canDisable?: unknown;
  preview?: unknown;
  previews?: unknown;
  previewsSegmentados?: unknown;
  sample?: unknown;
}

/**
 * Prévia FIEL do cartão (SCRUM-99): a STRING do cartão que o cliente RECEBE, renderizada pela
 * MESMA função do runtime no backend, pros 3 templates. É o que a seção EXIBE — o dono vê o que
 * o cliente recebe (fonte única). O antigo `buildCartaoPreview` client-side vira só FALLBACK
 * gracioso (erro/404), pra seção nunca quebrar.
 */
export interface CartaoPreviews {
  padrao: string;
  compacto: string;
  detalhado: string;
}

/**
 * SEGMENTO de um campo do cartão de exemplo — espelha `CartaoExemploSegmento`
 * (packages/integrations/src/prompt-builder/bloco-estrutural.ts). `tipo:'emoji'` é clicável
 * (abre o menu de editar/desabilitar); `tipo:'texto'` é inerte (inclui a quebra de linha `'\n'`).
 * NUNCA localizado por busca/regex na string — vem pronto do backend, na mesma ordem de
 * construção da linha (evita casar o slot errado quando 2 campos usam o mesmo emoji).
 */
export interface CartaoExemploSegmento {
  tipo: 'texto' | 'emoji';
  valor: string;
  slot?: CartaoSlot;
}

/** MESMO conteúdo de `CartaoPreviews`, como lista de segmentos por template. */
export interface CartaoPreviewsSegmentados {
  padrao: CartaoExemploSegmento[];
  compacto: CartaoExemploSegmento[];
  detalhado: CartaoExemploSegmento[];
}

/** Coage o `previews` cru em CartaoPreviews (3 strings não-vazias) ou null (fallback). */
export function normalizePreviews(raw: unknown): CartaoPreviews | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  if (ok(r.padrao) && ok(r.compacto) && ok(r.detalhado)) {
    return { padrao: r.padrao, compacto: r.compacto, detalhado: r.detalhado };
  }
  return null;
}

/** Um segmento cru é válido? (`tipo` conhecido, `valor` string, `slot` — se presente — um
 *  CartaoSlot conhecido.) Segmento inválido no meio da lista invalida o array inteiro (fail
 *  para null → fallback client), nunca renderiza lixo parcial. */
function isValidSegmento(v: unknown): v is CartaoExemploSegmento {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  if (s.tipo !== 'texto' && s.tipo !== 'emoji') return false;
  if (typeof s.valor !== 'string') return false;
  if (s.slot !== undefined && !(CARTAO_SLOTS as readonly string[]).includes(s.slot as string)) {
    return false;
  }
  return true;
}

/** Coage o `previewsSegmentados` cru em CartaoPreviewsSegmentados (3 listas válidas) ou null. */
export function normalizePreviewsSegmentados(raw: unknown): CartaoPreviewsSegmentados | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ok = (v: unknown): v is CartaoExemploSegmento[] =>
    Array.isArray(v) && v.every(isValidSegmento);
  if (ok(r.padrao) && ok(r.compacto) && ok(r.detalhado)) {
    return { padrao: r.padrao, compacto: r.compacto, detalhado: r.detalhado };
  }
  return null;
}

/** Seção editável: formulário completo, picker seedado da config do cliente. */
export interface CartaoEditableState {
  status: 'editable';
  /** Template efetivo (config.template ?? defaults.template). Reenviado como veio — o
   *  seletor visual saiu da tela, mas o valor continua fazendo parte do payload do PUT. */
  template: CartaoTemplate;
  /** Emojis efetivos (config.emojis mergeado sobre defaults.emojis). Seed do editor. */
  emojis: CartaoEmojis;
  defaults: { template: CartaoTemplate; emojis: CartaoEmojis };
  /** Prévia FIEL renderizada pelo backend (config salva). null → fallback client (SCRUM-99). */
  previews: CartaoPreviews | null;
  /** MESMA prévia, segmentada — fonte do editor-na-prévia. null → editor cai no fallback
   *  client (buildCartaoPreview), que não é clicável (degradação graciosa). */
  previewsSegmentados: CartaoPreviewsSegmentados | null;
}

/** Seção travada (read-only): cartão gerenciado pela equipe. `template/emojis` = defaults
 *  da área, só pra montar uma prévia ILUSTRATIVA (nunca o bloco interno do backend). */
export interface CartaoLockedState {
  status: 'locked';
  reason: CartaoLockedReason;
  template: CartaoTemplate;
  emojis: CartaoEmojis;
  /** Prévia FIEL do cartão atual renderizada pelo backend. null → fallback client (SCRUM-99). */
  previews: CartaoPreviews | null;
}

/**
 * Estado normalizado que a UI consome. `hidden` esconde a seção INTEIRA (degradação
 * graciosa): 404/flag OFF, erro de rede/5xx, ou resposta estranha caem aqui.
 */
export type CartaoConfigState = { status: 'hidden' } | CartaoEditableState | CartaoLockedState;

// ── Normalização pura (testável) ─────────────────────────────────────────────────

/** Coage um valor cru em CartaoTemplate válido, ou null. */
export function normalizeTemplate(v: unknown): CartaoTemplate | null {
  return v === 'padrao' || v === 'compacto' || v === 'detalhado' ? v : null;
}

/** Coage um valor cru em locked_reason válido, ou null. */
export function normalizeLockedReason(v: unknown): CartaoLockedReason | null {
  return v === 'prompt_custom' || v === 'requer_revisao' ? v : null;
}

// ── Validação de emoji LIVRE (paridade com o backend) ─────────────────────────────
//
// REIMPLEMENTAÇÃO INTENCIONAL de `isSingleValidEmoji`
// (packages/integrations/src/prompt-builder/cartao-catalog.ts): `apps/portal-web` não
// importa `@startap/integrations` (bundle Next puro, sem workspace dep — decisão de
// arquitetura anterior a esta PR). A ÚNICA fonte de verdade continua sendo o backend (2ª
// trava lá, HTTP 400 se este código divergir); esta cópia é só pra dar feedback VERMELHO
// imediato no client, sem round-trip. `cartao-emoji-validation.test.ts` lê o arquivo do
// outro pacote como TEXTO (mesmo padrão de `prompt-telas-citadas.test.ts`) e trava a
// paridade — renomear/mudar a regra lá QUEBRA a suíte daqui em vez de divergir em silêncio.
const NFC = (s: string): string => s.normalize('NFC');

/** Regex RGI_Emoji (Unicode property escape, flag `v`/unicodeSets). `new RegExp(...)` (não
 *  literal `/…/v`) porque o `target` do portal-web é ES2022 (tsconfig.json) — o TYPE-CHECKER
 *  só aceita o literal `/…/v` com `target>=ES2024` (TS1501); o runtime (V8, Node/browsers
 *  modernos) já suporta a flag desde muito antes. Espelha cartao-catalog.ts byte-a-byte. */
// biome-ignore lint/complexity/useRegexLiterals: literal /…/v exige target ES2024 no tsc (TS1501); ver comentário acima.
const RGI_EMOJI_WHOLE = new RegExp('^\\p{RGI_Emoji}$', 'v');

const GRAPHEME_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Deny-list explícita de code points suspeitos — mesma lista de cartao-catalog.ts
 *  (tag chars U+E0000–U+E007F, controle C0/C1, ZWSP/ZWNJ/LRM/RLM/separadores/BOM). */
function hasDeniedCodePoint(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp >= 0xe0000 && cp <= 0xe007f) return true;
    if (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return true;
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
 * `input` é EXATAMENTE 1 emoji (grapheme cluster único, RGI_Emoji, sem code points negados)?
 * Puro/determinístico. Espelha `isSingleValidEmoji` do backend — ver nota de paridade acima.
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

/** O valor é aceitável pra um campo do cartão: 1 emoji livre válido OU o sentinela de
 *  desabilitado. (Emoji LIVRE — a chave não restringe mais o conjunto; a assinatura por-slot
 *  é mantida por compat com os callers existentes, espelhando o backend.) */
export function isEmojiAllowed(_slot: CartaoSlot, value: string): boolean {
  return value === CARTAO_EMOJI_DISABLED || isSingleValidEmoji(value);
}

/**
 * Constrói um mapa completo de emojis a partir de um cru (parcial/sujo), caindo no
 * `fallback` por slot. Aceita emoji LIVRE válido ou o sentinela de desabilitado; qualquer
 * outra coisa (texto/vazio/2+ emojis/bytes invisíveis) é descartada (fallback daquele slot).
 */
export function sanitizeEmojis(raw: unknown, fallback: CartaoEmojis): CartaoEmojis {
  const out: CartaoEmojis = { ...fallback };
  if (raw && typeof raw === 'object') {
    for (const slot of CARTAO_SLOTS) {
      const val = (raw as Record<string, unknown>)[slot];
      if (typeof val === 'string' && isEmojiAllowed(slot, val)) out[slot] = val;
    }
  }
  return out;
}

/** Extrai o `preview` cru (string não-vazia) da resposta — usado só como sinal, NUNCA
 *  renderizado (é o bloco interno do runtime). */
export function parsePreview(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = (raw as RawCartaoResponse).preview;
  return typeof p === 'string' && p.length > 0 ? p : null;
}

/**
 * Normaliza a resposta crua do GET/PUT no estado da UI — a FUNÇÃO PURA que decide o que
 * renderiza (mapeamento dos 4 estados). Resposta inválida -> `hidden` (some).
 *
 *  - editable:true                          -> `editable` (seed do picker = config ?? defaults)
 *  - editable:false + locked_reason válido  -> `locked` (read-only)
 *  - editable:false sem reason (inesperado) -> `hidden` (defensivo)
 */
export function normalizeCartaoResponse(raw: unknown): CartaoConfigState {
  if (!raw || typeof raw !== 'object') return { status: 'hidden' };
  const r = raw as RawCartaoResponse;

  const defTemplate = normalizeTemplate(r.defaults?.template) ?? FALLBACK_TEMPLATE;
  const defEmojis = sanitizeEmojis(r.defaults?.emojis, FALLBACK_EMOJIS);
  const previews = normalizePreviews(r.previews);

  if (r.editable === true) {
    // Seed do editor a partir de `config` (o cartão atual do cliente); config ausente/null
    // cai nos defaults da área.
    const template = normalizeTemplate(r.config?.template) ?? defTemplate;
    const emojis = sanitizeEmojis(r.config?.emojis, defEmojis);
    return {
      status: 'editable',
      template,
      emojis,
      defaults: { template: defTemplate, emojis: defEmojis },
      previews,
      previewsSegmentados: normalizePreviewsSegmentados(r.previewsSegmentados),
    };
  }

  // Não-editável: só é seção se houver um motivo de trava conhecido; senão some.
  const reason = normalizeLockedReason(r.locked_reason);
  if (reason) {
    return { status: 'locked', reason, template: defTemplate, emojis: defEmojis, previews };
  }
  return { status: 'hidden' };
}

/** Type guard: a seção editável. */
export function isCartaoEditable(
  state: CartaoConfigState | undefined,
): state is CartaoEditableState {
  return state?.status === 'editable';
}

/** Type guard: a seção travada (read-only). */
export function isCartaoLocked(state: CartaoConfigState | undefined): state is CartaoLockedState {
  return state?.status === 'locked';
}

// ── Rascunho / edição (testável) ─────────────────────────────────────────────────

export interface CartaoDraft {
  template: CartaoTemplate;
  emojis: CartaoEmojis;
}

/** Rascunho editável a partir do estado editável (cópia dos emojis, sem vazar ref). */
export function toCartaoDraft(state: CartaoEditableState): CartaoDraft {
  return { template: state.template, emojis: { ...state.emojis } };
}

/** Troca o template do rascunho (imutável). */
export function setTemplate(draft: CartaoDraft, template: CartaoTemplate): CartaoDraft {
  return { ...draft, template };
}

/**
 * Troca o emoji de um slot (imutável) — EMOJI LIVRE, validado (`isSingleValidEmoji`) OU o
 * sentinela de desabilitado. Valor inválido (texto/2+ emojis/vazio/bytes invisíveis) é
 * IGNORADO (retorna o rascunho intacto) — a 2ª trava, espelhando o backend; a UI vermelha
 * (borda + mensagem + salvar desabilitado) é responsabilidade do componente, que valida o
 * INPUT bruto do campo antes de chamar isto (`isEmojiAllowed`/`isSingleValidEmoji`).
 */
export function setEmoji(draft: CartaoDraft, slot: CartaoSlot, emoji: string): CartaoDraft {
  if (!isEmojiAllowed(slot, emoji)) return draft;
  return { ...draft, emojis: { ...draft.emojis, [slot]: emoji } };
}

/** Desabilita o emoji de um slot (imutável) — grava o sentinela `CARTAO_EMOJI_DISABLED`. */
export function disableEmoji(draft: CartaoDraft, slot: CartaoSlot): CartaoDraft {
  return { ...draft, emojis: { ...draft.emojis, [slot]: CARTAO_EMOJI_DISABLED } };
}

/** O emoji deste slot está desabilitado (sentinela)? */
export function isEmojiDisabled(emojis: CartaoEmojis, slot: CartaoSlot): boolean {
  return emojis[slot] === CARTAO_EMOJI_DISABLED;
}

/** Há diferença entre dois rascunhos (template ou qualquer emoji)? */
export function isCartaoDirty(a: CartaoDraft, b: CartaoDraft): boolean {
  if (a.template !== b.template) return true;
  return CARTAO_SLOTS.some((s) => a.emojis[s] !== b.emojis[s]);
}

/** Payload do PUT (cópia dos emojis pra não vazar a referência do rascunho). */
export function toCartaoPayload(draft: CartaoDraft): {
  template: CartaoTemplate;
  emojis: CartaoEmojis;
} {
  return { template: draft.template, emojis: { ...draft.emojis } };
}

// ── Preview do cartão (montado no client a partir da config) ─────────────────────

/** Emoji "de exibição" de um slot: '' quando desabilitado (sentinela), senão o valor cru. */
function displayEmoji(emojis: CartaoEmojis, slot: CartaoSlot): string {
  return isEmojiDisabled(emojis, slot) ? '' : emojis[slot];
}

/** Junta partes não-vazias com `sep`, pulando as vazias (emoji desabilitado) sem deixar
 *  separador/espaço órfão. Espelha `joinCampo` de bloco-estrutural.ts (fonte única do "desabilitar
 *  tira só o ícone, a linha fica"). */
function joinCampo(sep: string, ...partes: string[]): string {
  return partes.filter((p) => p !== '').join(sep);
}

/**
 * Renderiza o texto AMIGÁVEL do cartão (estilo bolha de WhatsApp) a partir do template +
 * emojis + amostra. Função PURA: é o que a UI mostra ao vivo (e o que os testes fixam).
 * NÃO é o `preview` do servidor (aquele é o bloco interno do runtime, nunca exibido). Emoji
 * desabilitado (sentinela) vira '' — a linha perde só o ícone, nunca some (mesma regra do
 * backend, `joinCampo`/`campoRotulado` em bloco-estrutural.ts).
 */
export function buildCartaoPreview(
  template: CartaoTemplate,
  emojis: CartaoEmojis,
  sample: CartaoSample = PREVIEW_SAMPLE,
): string {
  const e: CartaoEmojis = { ...emojis };
  for (const slot of CARTAO_SLOTS) e[slot] = displayEmoji(emojis, slot);
  const s = sample;
  if (template === 'compacto') {
    return [
      joinCampo(' ', e.marca, `*${s.marca}*`),
      `${joinCampo(' ', e.dia, s.dia)} · ${joinCampo(' ', e.horario, s.horario)}`,
      `${joinCampo(' ', e.servico, s.servico)} · ${joinCampo(' ', e.valor, s.valor)} · ${joinCampo(' ', e.profissional, s.profissional)}`,
      joinCampo(' ', e.confirma, s.confirma),
    ].join('\n');
  }
  if (template === 'detalhado') {
    return [
      joinCampo(' ', e.marca, `*${s.marca}*`),
      'Vamos confirmar seu agendamento:',
      '',
      joinCampo(' ', e.dia, `Dia: ${s.dia}`),
      joinCampo(' ', e.horario, `Horário: ${s.horario}`),
      joinCampo(' ', e.servico, `Serviço: ${s.servico}`),
      joinCampo(' ', e.profissional, `Profissional: ${s.profissional}`),
      joinCampo(' ', e.valor, `Valor: ${s.valor}`),
      '',
      joinCampo(' ', e.confirma, s.confirma),
    ].join('\n');
  }
  // padrao
  return [
    joinCampo(' ', e.marca, `*${s.marca}*`),
    '',
    joinCampo(' ', e.dia, `Dia: ${s.dia}`),
    joinCampo(' ', e.horario, `Horário: ${s.horario}`),
    joinCampo(' ', e.servico, `Serviço: ${s.servico}`),
    joinCampo(' ', e.profissional, `Profissional: ${s.profissional}`),
    joinCampo(' ', e.valor, `Valor: ${s.valor}`),
    '',
    joinCampo(' ', e.confirma, s.confirma),
  ].join('\n');
}

/** Linhas não-vazias do preview (pra mini-preview do seletor de template). */
export function previewLines(preview: string): string[] {
  return preview.split('\n').filter((l) => l.trim().length > 0);
}

// ── Transporte HTTP ──────────────────────────────────────────────────────────────

/**
 * GET /portal/cartao-config. DEGRADAÇÃO GRACIOSA: NUNCA lança — qualquer falha (404 do flag
 * OFF, rede, 5xx, resposta estranha) vira `hidden` e a seção some. Editável/travado vêm do
 * `normalizeCartaoResponse` (contrato: editable + locked_reason).
 */
export async function fetchCartaoConfig(signal?: AbortSignal): Promise<CartaoConfigState> {
  try {
    const raw = await apiFetch<unknown>('/portal/cartao-config', { signal });
    return normalizeCartaoResponse(raw);
  } catch {
    return { status: 'hidden' };
  }
}

/** Prévia ao vivo (string + segmentada), devolvida junta por `fetchCartaoPreview`. */
export interface CartaoPreviewLive {
  previews: CartaoPreviews | null;
  previewsSegmentados: CartaoPreviewsSegmentados | null;
}

/**
 * GET /portal/cartao-config/preview — prévia AO VIVO (SCRUM-99): renderiza o EXEMPLO fiel do
 * cartão (a MESMA função do runtime, no backend) pros 3 templates com os emojis que o dono está
 * escolhendo, incluindo os SEGMENTOS (editor-na-prévia). Read-only, sem gravar nada. DEGRADAÇÃO
 * GRACIOSA: NUNCA lança — qualquer falha (404/rede/resposta estranha) → tudo null, e a UI cai
 * no fallback client (buildCartaoPreview, não-clicável). Os emojis vão como query params por
 * chave (incl. o sentinela de desabilitado); o backend ignora o que for inválido.
 */
export async function fetchCartaoPreview(
  emojis: CartaoEmojis,
  signal?: AbortSignal,
): Promise<CartaoPreviewLive> {
  const qs = new URLSearchParams();
  for (const slot of CARTAO_SLOTS) {
    if (emojis[slot]) qs.set(slot, emojis[slot]);
  }
  try {
    const raw = await apiFetch<unknown>(`/portal/cartao-config/preview?${qs.toString()}`, {
      signal,
    });
    const r = raw as { previews?: unknown; previewsSegmentados?: unknown } | null;
    return {
      previews: normalizePreviews(r?.previews),
      previewsSegmentados: normalizePreviewsSegmentados(r?.previewsSegmentados),
    };
  } catch {
    return { previews: null, previewsSegmentados: null };
  }
}

export interface SaveCartaoResult {
  state: CartaoEditableState;
}

/**
 * PUT /portal/cartao-config. Devolve o estado editável já com a config aplicada (o clone
 * vira runtime editável após o flip). Lança (ApiError) em falha real OU se o servidor
 * responder algo que não seja editável (409 prompt_custom / 422 requer_revisao / 404) — a
 * UI reverte o otimista, mostra erro e re-sincroniza (pode ter virado travado por corrida).
 */
export async function putCartaoConfig(payload: {
  template: CartaoTemplate;
  emojis: CartaoEmojis;
}): Promise<SaveCartaoResult> {
  const raw = await apiFetch<unknown>('/portal/cartao-config', { method: 'PUT', body: payload });
  const state = normalizeCartaoResponse(raw);
  if (state.status !== 'editable') {
    throw new ApiError(0, 'resposta inválida do servidor', raw);
  }
  return { state };
}
