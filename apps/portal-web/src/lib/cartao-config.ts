'use client';

/**
 * Cliente + lógica pura da "Cartão de confirmação" (SCRUM-92, increment 2 / ADR 0032) —
 * a seção de "Meu negócio" onde o dono escolhe o TEMPLATE e os EMOJIS do cartão de
 * agendamento que o bot manda ANTES de marcar.
 *
 * ── CONTRATO NOVO (refinamento Bruno 23/07, endpoint #475/#476) ──────────────────────
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
 *       preview: string | null }               // bloco INTERNO do runtime — NÃO exibir cru
 *
 * 4 estados que a UI renderiza (função pura `normalizeCartaoResponse`):
 *   1. editable  (editable:true)              -> formulário completo, picker seedado de `config`
 *   2. locked    (locked_reason:'prompt_custom')    -> read-only + nota "personalizado pela equipe"
 *   3. locked    (locked_reason:'requer_revisao')   -> read-only + nota "fale com o suporte"
 *   4. hidden    (404/flag OFF/erro/resposta inválida) -> a seção SOME (degradação graciosa)
 *
 * PREVIEW: o `preview` do endpoint é o BLOCO ESTRUTURAL do runtime (system-prompt cru, com
 * "REGRA CRITICA" e placeholders `<dia>`) — jamais mostrado ao dono. A prévia amigável (estilo
 * bolha de WhatsApp) é montada AQUI no client por `buildCartaoPreview`, a partir dos emojis.
 *
 * Regra de ouro do picker: catálogo FECHADO por slot — o dono ESCOLHE, nunca digita emoji
 * livre (espelha a allowlist do backend `cartao-catalog.ts`; fora do catálogo = descartado).
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
 * Catálogo FECHADO de emojis por slot (picker; NUNCA campo aberto). O 1º de cada lista é o
 * default seguro daquele slot. Espelha a allowlist do backend (`EXTRA` ∪ defaults por área em
 * packages/integrations/src/prompt-builder/cartao-catalog.ts) — se o backend restringir mais,
 * `sanitizeEmojis` derruba o que sair daqui, e o PUT rejeita (2ª trava server-side).
 */
export const EMOJI_CATALOG: Record<CartaoSlot, readonly string[]> = {
  // 🌻 (marca) e 📝 (servico) = emojis da Ingrid (clone migrado); na allowlist do backend
  // (cartao-catalog.ts EXTRA) para o PUT aceitar e o picker oferecer os mesmos ícones (SCRUM-92).
  marca: ['💈', '💇', '💅', '💆', '✂️', '📅', '🌻'],
  dia: ['📅', '🗓️', '📆'],
  horario: ['⏰', '🕐', '⌚'],
  servico: ['✂️', '💇', '💅', '✨', '📋', '📝'],
  valor: ['💰', '💵', '💲', '🪙'],
  confirma: ['✅', '☑️', '👍'],
  profissional: ['👤', '🧑‍🔧', '💇‍♂️'],
};

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
  subtitulo: `Escolha o formato e os emojis do cartão que ${O_ASSISTENTE} manda antes de marcar um horário.`,

  /** Aviso fixo (só nos estados editáveis) — a confirmação em si não pode ser desativada. */
  avisoFixo:
    '⚠️ A confirmação antes de agendar não pode ser desativada — ela protege sua agenda. Aqui você muda só a aparência do cartão.',

  /** Seletor de template. */
  formatoLabel: 'Formato do cartão',
  templates: [
    { value: 'padrao', label: 'Padrão', hint: 'Uma linha por informação.' },
    { value: 'compacto', label: 'Compacto', hint: 'Tudo em poucas linhas.' },
    { value: 'detalhado', label: 'Detalhado', hint: 'Com uma frase de abertura.' },
  ] as { value: CartaoTemplate; label: string; hint: string }[],

  /** Editor de emojis. */
  emojisLabel: 'Emojis de cada campo',
  emojisAjuda: 'Toque para escolher. Você seleciona de uma lista pronta — é só marcar.',
  slotLabels: {
    marca: 'Negócio',
    dia: 'Dia',
    horario: 'Horário',
    servico: 'Serviço',
    valor: 'Valor',
    confirma: 'Confirmação',
    profissional: 'Profissional',
  } as Record<CartaoSlot, string>,

  /** Prévia. */
  previaLabel: 'Prévia do cartão',
  previaRodape: 'É um exemplo. O assistente troca os dados pelo agendamento real do cliente.',

  /** Botão salvar + status. */
  salvar: 'Salvar cartão',
  salvando: 'Salvando…',
  statusSujo: 'Você tem alterações não salvas.',
  statusSalvo: 'Tudo salvo. É só a aparência do cartão — você pode mudar quando quiser.',
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
export const PREVIEW_SAMPLE = {
  marca: 'Barbearia do Zé',
  dia: 'quinta, 24/07',
  horario: '15:00',
  servico: 'Corte',
  valor: 'R$ 65',
  confirma: 'Posso confirmar?',
  profissional: 'Léo',
} as const;
export type CartaoSample = typeof PREVIEW_SAMPLE;

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
}

/** Seção editável: formulário completo, picker seedado da config do cliente. */
export interface CartaoEditableState {
  status: 'editable';
  /** Template efetivo (config.template ?? defaults.template). */
  template: CartaoTemplate;
  /** Emojis efetivos (config.emojis mergeado sobre defaults.emojis). Seed do picker. */
  emojis: CartaoEmojis;
  defaults: { template: CartaoTemplate; emojis: CartaoEmojis };
}

/** Seção travada (read-only): cartão gerenciado pela equipe. `template/emojis` = defaults
 *  da área, só pra montar uma prévia ILUSTRATIVA (nunca o bloco interno do backend). */
export interface CartaoLockedState {
  status: 'locked';
  reason: CartaoLockedReason;
  template: CartaoTemplate;
  emojis: CartaoEmojis;
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

/** O emoji está no catálogo fechado daquele slot? (allowlist do picker.) */
export function isEmojiAllowed(slot: CartaoSlot, emoji: string): boolean {
  return EMOJI_CATALOG[slot].includes(emoji);
}

/**
 * Constrói um mapa completo de emojis a partir de um cru (parcial/sujo), caindo no
 * `fallback` por slot. Só aceita emoji que esteja no catálogo daquele slot — o resto
 * é descartado (defesa contra valor fora da allowlist, incl. o próprio backend).
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

  if (r.editable === true) {
    // Seed do picker a partir de `config` (o cartão atual do cliente); config ausente/null
    // cai nos defaults da área.
    const template = normalizeTemplate(r.config?.template) ?? defTemplate;
    const emojis = sanitizeEmojis(r.config?.emojis, defEmojis);
    return {
      status: 'editable',
      template,
      emojis,
      defaults: { template: defTemplate, emojis: defEmojis },
    };
  }

  // Não-editável: só é seção se houver um motivo de trava conhecido; senão some.
  const reason = normalizeLockedReason(r.locked_reason);
  if (reason) {
    return { status: 'locked', reason, template: defTemplate, emojis: defEmojis };
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
 * Troca o emoji de um slot (imutável). Picker FECHADO: emoji fora do catálogo do slot
 * é IGNORADO (retorna o rascunho intacto) — a UI nunca deixa digitar, e isto é a
 * segunda trava.
 */
export function setEmoji(draft: CartaoDraft, slot: CartaoSlot, emoji: string): CartaoDraft {
  if (!isEmojiAllowed(slot, emoji)) return draft;
  return { ...draft, emojis: { ...draft.emojis, [slot]: emoji } };
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

/**
 * Renderiza o texto AMIGÁVEL do cartão (estilo bolha de WhatsApp) a partir do template +
 * emojis + amostra. Função PURA: é o que a UI mostra ao vivo (e o que os testes fixam).
 * NÃO é o `preview` do servidor (aquele é o bloco interno do runtime, nunca exibido).
 */
export function buildCartaoPreview(
  template: CartaoTemplate,
  emojis: CartaoEmojis,
  sample: CartaoSample = PREVIEW_SAMPLE,
): string {
  const e = emojis;
  const s = sample;
  if (template === 'compacto') {
    return [
      `${e.marca} *${s.marca}*`,
      `${e.dia} ${s.dia} · ${e.horario} ${s.horario}`,
      `${e.servico} ${s.servico} · ${e.valor} ${s.valor} · ${e.profissional} ${s.profissional}`,
      `${e.confirma} ${s.confirma}`,
    ].join('\n');
  }
  if (template === 'detalhado') {
    return [
      `${e.marca} *${s.marca}*`,
      'Vamos confirmar seu agendamento:',
      '',
      `${e.dia} Dia: ${s.dia}`,
      `${e.horario} Horário: ${s.horario}`,
      `${e.servico} Serviço: ${s.servico}`,
      `${e.profissional} Profissional: ${s.profissional}`,
      `${e.valor} Valor: ${s.valor}`,
      '',
      `${e.confirma} ${s.confirma}`,
    ].join('\n');
  }
  // padrao
  return [
    `${e.marca} *${s.marca}*`,
    '',
    `${e.dia} Dia: ${s.dia}`,
    `${e.horario} Horário: ${s.horario}`,
    `${e.servico} Serviço: ${s.servico}`,
    `${e.profissional} Profissional: ${s.profissional}`,
    `${e.valor} Valor: ${s.valor}`,
    '',
    `${e.confirma} ${s.confirma}`,
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
