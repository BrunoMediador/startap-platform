'use client';

/**
 * Cliente + lógica pura da "Customização do cartão de confirmação" (SCRUM-92,
 * increment 2 / ADR 0032) — a seção de "Meu negócio" onde o dono escolhe o
 * TEMPLATE e os EMOJIS do cartão de agendamento que o bot manda antes de marcar.
 *
 * O backend AINDA NÃO tem esse endpoint — este módulo é escrito CONTRA o contrato
 * abaixo, com DORMÊNCIA por padrão (a seção só aparece quando o backend responder
 * `mode:'runtime'`; qualquer falha do GET a esconde). Assim a PR pode mergear sem
 * UI morta pra cliente nenhum.
 *
 * Contrato:
 *   GET  /portal/cartao-config
 *     -> { mode:'baked'|'runtime',
 *          config: { template, emojis } | null,
 *          defaults: { template, emojis },
 *          canDisable: false }
 *   PUT  /portal/cartao-config  body { template, emojis }
 *     -> mesmo shape + `preview` (string do cartão renderizado no servidor).
 *
 * Regra de ouro do picker: o dono ESCOLHE de um catálogo FECHADO por slot — nunca
 * digita emoji livre (espelha a allowlist que o backend vai enforçar; campo aberto =
 * risco de injeção). Qualquer emoji fora do catálogo é ignorado aqui também.
 *
 * Só transporte tipado + funções puras (sem React/DOM), testáveis em node.
 */
import { ApiError, apiFetch } from './api';

// ── Slots, templates e catálogo fechado ─────────────────────────────────────────

/** Campos do cartão que ganham emoji, na ordem em que aparecem na tela. */
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

/**
 * Catálogo FECHADO de emojis por slot (picker; NUNCA campo aberto). O 1º de cada
 * lista é o default seguro daquele slot. Espelha a allowlist do backend — se o
 * backend restringir mais, o `sanitizeEmojis` derruba o que sair daqui.
 */
export const EMOJI_CATALOG: Record<CartaoSlot, readonly string[]> = {
  marca: ['💈', '💇', '💅', '💆', '✂️', '📅'],
  dia: ['📅', '🗓️', '📆'],
  horario: ['⏰', '🕐', '⌚'],
  servico: ['✂️', '💇', '💅', '✨', '📋'],
  valor: ['💰', '💵', '💲', '🪙'],
  confirma: ['✅', '☑️', '👍'],
  profissional: ['👤', '🧑‍🔧', '💇‍♂️'],
};

/** Rótulo curto de cada slot (PT-BR, tom PME). */
export const SLOT_LABELS: Record<CartaoSlot, string> = {
  marca: 'Negócio',
  dia: 'Dia',
  horario: 'Horário',
  servico: 'Serviço',
  valor: 'Valor',
  confirma: 'Confirmação',
  profissional: 'Profissional',
};

/** Opções do seletor de template (rótulo + dica curta). */
export const TEMPLATE_OPCOES: { value: CartaoTemplate; label: string; hint: string }[] = [
  { value: 'padrao', label: 'Padrão', hint: 'Uma linha por informação.' },
  { value: 'compacto', label: 'Compacto', hint: 'Tudo em poucas linhas.' },
  { value: 'detalhado', label: 'Detalhado', hint: 'Com uma frase de abertura.' },
];

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

// ── Contratos crus + estado normalizado ─────────────────────────────────────────

interface RawCartaoConfig {
  template?: unknown;
  emojis?: unknown;
}
interface RawCartaoResponse {
  mode?: unknown;
  config?: RawCartaoConfig | null;
  defaults?: RawCartaoConfig;
  canDisable?: unknown;
  preview?: unknown;
}

/**
 * Estado normalizado que a UI consome. `indisponivel` esconde a seção INTEIRA
 * (dormência): backend sem o endpoint, `mode!=='runtime'` (clone baked) ou qualquer
 * resposta estranha caem aqui. `runtime` traz a config efetiva + os defaults.
 */
export interface CartaoRuntimeState {
  status: 'runtime';
  /** Template efetivo (config.template ?? defaults.template). */
  template: CartaoTemplate;
  /** Emojis efetivos (config.emojis mergeado sobre defaults.emojis). */
  emojis: CartaoEmojis;
  defaults: { template: CartaoTemplate; emojis: CartaoEmojis };
  /** Contrato fixa `false` — a confirmação nunca pode ser desligada. */
  canDisable: boolean;
}
export type CartaoConfigState = { status: 'indisponivel' } | CartaoRuntimeState;

// ── Normalização pura (testável) ─────────────────────────────────────────────────

/** Coage um valor cru em CartaoTemplate válido, ou null. */
export function normalizeTemplate(v: unknown): CartaoTemplate | null {
  return v === 'padrao' || v === 'compacto' || v === 'detalhado' ? v : null;
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

/**
 * Normaliza a resposta crua do GET/PUT no estado da UI. `mode!=='runtime'` (ou
 * resposta inválida) => `indisponivel` (some a seção). Em runtime, a config efetiva é
 * o merge de `config` sobre `defaults` (e defaults sobre o fallback do catálogo).
 */
export function normalizeCartaoResponse(raw: unknown): CartaoConfigState {
  if (!raw || typeof raw !== 'object') return { status: 'indisponivel' };
  const r = raw as RawCartaoResponse;
  if (r.mode !== 'runtime') return { status: 'indisponivel' };

  const defTemplate = normalizeTemplate(r.defaults?.template) ?? FALLBACK_TEMPLATE;
  const defEmojis = sanitizeEmojis(r.defaults?.emojis, FALLBACK_EMOJIS);
  const template = normalizeTemplate(r.config?.template) ?? defTemplate;
  const emojis = sanitizeEmojis(r.config?.emojis, defEmojis);

  return {
    status: 'runtime',
    template,
    emojis,
    defaults: { template: defTemplate, emojis: defEmojis },
    canDisable: r.canDisable === true, // contrato = false; coação defensiva
  };
}

/** Type guard: a seção só aparece quando o estado é `runtime`. */
export function isCartaoVisible(state: CartaoConfigState | undefined): state is CartaoRuntimeState {
  return state?.status === 'runtime';
}

/** Extrai o `preview` do servidor (PUT), se veio como string não-vazia. */
export function parsePreview(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = (raw as RawCartaoResponse).preview;
  return typeof p === 'string' && p.length > 0 ? p : null;
}

// ── Rascunho / edição (testável) ─────────────────────────────────────────────────

export interface CartaoDraft {
  template: CartaoTemplate;
  emojis: CartaoEmojis;
}

/** Rascunho editável a partir do estado runtime (cópia dos emojis, sem vazar ref). */
export function toCartaoDraft(state: CartaoRuntimeState): CartaoDraft {
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

export interface CartaoSample {
  marca: string;
  dia: string;
  horario: string;
  servico: string;
  valor: string;
  confirma: string;
  profissional: string;
}

/** Amostra fictícia usada no preview ao vivo (PME genérica). */
export const PREVIEW_SAMPLE: CartaoSample = {
  marca: 'Barbearia do Zé',
  dia: 'quinta, 24/07',
  horario: '15:00',
  servico: 'Corte',
  valor: 'R$ 65',
  confirma: 'Posso confirmar?',
  profissional: 'Léo',
};

/**
 * Renderiza o texto do cartão a partir do template + emojis + amostra. Função PURA:
 * é o que a UI mostra ao vivo (e o que os testes fixam). Quando o PUT devolve um
 * `preview` do servidor, a UI PREFERE aquele; este é o fallback local imediato.
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
 * GET /portal/cartao-config. DORMÊNCIA: NUNCA lança — qualquer falha (404 do endpoint
 * inexistente, rede, 5xx) vira `indisponivel` e a seção some. `mode!=='runtime'`
 * também some. Só aparece quando o backend responder `mode:'runtime'`.
 */
export async function fetchCartaoConfig(signal?: AbortSignal): Promise<CartaoConfigState> {
  try {
    const raw = await apiFetch<unknown>('/portal/cartao-config', { signal });
    return normalizeCartaoResponse(raw);
  } catch {
    return { status: 'indisponivel' };
  }
}

export interface SaveCartaoResult {
  state: CartaoRuntimeState;
  /** Preview renderizado pelo servidor (preferido sobre o local quando presente). */
  preview: string | null;
}

/**
 * PUT /portal/cartao-config. Devolve o estado normalizado + o `preview` do servidor.
 * Lança (ApiError) em falha real OU se o servidor responder algo que não seja runtime
 * — a UI reverte o otimista e mostra erro (não engole em silêncio).
 */
export async function putCartaoConfig(payload: {
  template: CartaoTemplate;
  emojis: CartaoEmojis;
}): Promise<SaveCartaoResult> {
  const raw = await apiFetch<unknown>('/portal/cartao-config', { method: 'PUT', body: payload });
  const state = normalizeCartaoResponse(raw);
  if (state.status !== 'runtime') {
    throw new ApiError(0, 'resposta inválida do servidor', raw);
  }
  return { state, preview: parsePreview(raw) };
}
