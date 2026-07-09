/**
 * Lógica pura da seção "Frases de comando" (modo atendente, SCRUM-59) da tela Pausas.
 * Sem React/DOM — testável.
 *
 * Contexto: quando a IA e o atendente humano dividem o MESMO número de WhatsApp, a
 * recepção digita uma "frase de pausa" no próprio chat pra assumir a conversa (o
 * assistente para de responder aquele cliente); uma "frase de retomada" devolve o
 * atendimento pro assistente. Como a frase aparece na conversa (o cliente final vê),
 * o dono personaliza o texto com a cara da marca dele.
 *
 * CONTRATO (backend em paralelo — NÃO mudar; se divergir, PARAR e reportar):
 *   GET /portal/frases-pausa -> { frases: FrasePausa[] }        (404 = feature off)
 *   PUT /portal/frases-pausa body { frases: FrasePausa[] }      (lista completa = replace-set)
 *   Regras: máx 10 frases; keyword 2..80 chars; sem duplicata por (command, keyword
 *   normalizada); 400 { error } na violação.
 *   Gate: features.modo_atendente (do GET /portal/perfil).
 *
 * Toda a validação daqui ESPELHA a do backend só pra dar feedback imediato — o backend
 * é a autoridade (a UI trava o Salvar em estado inválido, o 400 é a rede de proteção).
 */
import { ApiError } from './api';
import type { FrasePausa } from './api-types';

export const MAX_FRASES = 10;
export const KEYWORD_MIN = 2;
export const KEYWORD_MAX = 80;

export type FraseCommand = 'pause' | 'resume';

/** Rótulo curto do tipo de frase (na UI, público leigo). */
export const COMMAND_LABEL: Record<FraseCommand, string> = {
  pause: 'Pausar',
  resume: 'Retomar',
};

/** Rótulo do CAMPO de texto por tipo (a11y — o input é sr-only na UI). */
export const COMMAND_FIELD_LABEL: Record<FraseCommand, string> = {
  pause: 'Frase para você assumir a conversa',
  resume: 'Frase para devolver ao assistente',
};

/** Placeholder (exemplo concreto) por tipo — a frase aparece na conversa. */
export const COMMAND_PLACEHOLDER: Record<FraseCommand, string> = {
  pause: 'Ex.: Oi! Aqui é a equipe Meduzza 👋',
  resume: 'Ex.: Vou te deixar com nosso atendente, qualquer coisa é só chamar 🙌',
};

/**
 * Helper sob cada campo. IMPORTANTE (fato do backend, manual-pause.ts): o match NÃO é
 * exato — é SUBSTRING sobre texto normalizado (minúsculas, sem acentos, sem espaços),
 * então a frase pode vir DENTRO de uma mensagem maior. NÃO dizer "digite exatamente".
 */
export const COMMAND_MATCH_HELP: Record<FraseCommand, string> = {
  pause: 'Pode digitar a frase dentro de uma mensagem maior — maiúsculas e acentos não importam.',
  resume: 'Pode digitar a frase dentro de uma mensagem maior — maiúsculas e acentos não importam.',
};

/** Linha do rascunho de UI: uma frase + id só de cliente (React key + edição). */
export interface FrasePausaDraft {
  /** id LOCAL (a lista é replace-set; o backend não guarda id). */
  id: number;
  command: FraseCommand;
  keyword: string;
  enabled: boolean;
}

/**
 * Feature OFF: 404 no GET /portal/frases-pausa (modo atendente off pro clone). NÃO é
 * erro do cliente — a seção some (mesmo critério do lembrete #368 / atendimentos/novo).
 */
export function isFrasesFeatureOff(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/** Coage um valor cru pro tipo de comando (default 'pause'). */
function toCommand(v: unknown): FraseCommand {
  return v === 'resume' ? 'resume' : 'pause';
}

/** Resposta do backend -> rascunho de UI (id local por índice — determinístico). */
export function toFrasesDraft(frases: readonly FrasePausa[] | null | undefined): FrasePausaDraft[] {
  if (!frases) return [];
  return frases.map((f, i) => ({
    id: i + 1,
    command: toCommand(f.command),
    keyword: typeof f.keyword === 'string' ? f.keyword : '',
    enabled: f.enabled === true,
  }));
}

/** Próximo id local livre (max + 1) pra uma linha nova sem colidir com as existentes. */
export function newFraseId(drafts: readonly FrasePausaDraft[]): number {
  return drafts.reduce((max, d) => Math.max(max, d.id), 0) + 1;
}

/** True quando já bateu o limite de frases (trava o "Adicionar"). */
export function atMaxFrases(drafts: readonly FrasePausaDraft[]): boolean {
  return drafts.length >= MAX_FRASES;
}

/** Adiciona uma linha vazia (default = Pausar, ativa). No-op se já no limite. */
export function addFrase(
  drafts: readonly FrasePausaDraft[],
  command: FraseCommand = 'pause',
): FrasePausaDraft[] {
  if (atMaxFrases(drafts)) return [...drafts];
  return [...drafts, { id: newFraseId(drafts), command, keyword: '', enabled: true }];
}

export function removeFrase(drafts: readonly FrasePausaDraft[], id: number): FrasePausaDraft[] {
  return drafts.filter((d) => d.id !== id);
}

export function setFraseKeyword(
  drafts: readonly FrasePausaDraft[],
  id: number,
  keyword: string,
): FrasePausaDraft[] {
  return drafts.map((d) => (d.id === id ? { ...d, keyword } : d));
}

export function setFraseCommand(
  drafts: readonly FrasePausaDraft[],
  id: number,
  command: FraseCommand,
): FrasePausaDraft[] {
  return drafts.map((d) => (d.id === id ? { ...d, command } : d));
}

export function toggleFraseEnabled(
  drafts: readonly FrasePausaDraft[],
  id: number,
): FrasePausaDraft[] {
  return drafts.map((d) => (d.id === id ? { ...d, enabled: !d.enabled } : d));
}

/** Normaliza a keyword pra comparar duplicata: trim + lowercase + colapsa espaços. */
export function normalizeKeyword(keyword: string): string {
  return keyword.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Comprimento efetivo (após trim) da keyword. */
function keywordLen(keyword: string): number {
  return keyword.trim().length;
}

export type FraseError = 'vazia' | 'curta' | 'longa' | 'duplicada';

/** Microcopy de cada erro de linha (público leigo). */
export const FRASE_ERROR_MSG: Record<FraseError, string> = {
  vazia: 'Escreva a frase.',
  curta: `Use pelo menos ${KEYWORD_MIN} caracteres.`,
  longa: `Máximo de ${KEYWORD_MAX} caracteres.`,
  duplicada: 'Essa frase já existe para esse tipo.',
};

/**
 * Valida todas as linhas. Devolve um mapa id->erro (só das inválidas). Duplicata =
 * mesma (command, keyword normalizada) de uma linha ANTERIOR — a 1ª ocorrência fica
 * válida, as repetidas marcam 'duplicada'. Linha vazia NÃO conta como duplicata.
 */
export function validateFrases(drafts: readonly FrasePausaDraft[]): Map<number, FraseError> {
  const errors = new Map<number, FraseError>();
  const seen = new Set<string>();
  for (const d of drafts) {
    const len = keywordLen(d.keyword);
    if (len === 0) {
      errors.set(d.id, 'vazia');
      continue;
    }
    if (len < KEYWORD_MIN) {
      errors.set(d.id, 'curta');
      continue;
    }
    if (len > KEYWORD_MAX) {
      errors.set(d.id, 'longa');
      continue;
    }
    const key = `${d.command}:${normalizeKeyword(d.keyword)}`;
    if (seen.has(key)) {
      errors.set(d.id, 'duplicada');
      continue;
    }
    seen.add(key);
  }
  return errors;
}

/** Pronto pra salvar? Sem erros de linha E dentro do limite. */
export function isFrasesValidas(drafts: readonly FrasePausaDraft[]): boolean {
  return drafts.length <= MAX_FRASES && validateFrases(drafts).size === 0;
}

/**
 * Draft mudou em relação ao salvo? Comparação POSICIONAL por conteúdo (command +
 * keyword trim + enabled) — id local é ignorado; keyword compara já sem bordas.
 */
export function isFrasesDirty(
  a: readonly FrasePausaDraft[],
  b: readonly FrasePausaDraft[],
): boolean {
  if (a.length !== b.length) return true;
  return a.some((x, i) => {
    const y = b[i];
    return (
      x.command !== y.command || x.keyword.trim() !== y.keyword.trim() || x.enabled !== y.enabled
    );
  });
}

/** Rascunho -> body do PUT (replace-set). Envia a keyword já trimada. */
export function toFrasesPayload(drafts: readonly FrasePausaDraft[]): FrasePausa[] {
  return drafts.map((d) => ({
    command: d.command,
    keyword: d.keyword.trim(),
    enabled: d.enabled,
  }));
}

/**
 * 400: o backend recusou a lista (regra de negócio). A UI já trava o Salvar em estado
 * inválido, então isto é rede de proteção — mostra microcopy amigável em vez do código.
 */
export function isFrasesRejeitadas(err: unknown): boolean {
  return err instanceof ApiError && err.status === 400;
}

/**
 * Onda 1 (SCRUM-68) — DE-GATE: as frases de pausa/retomada passam a ser editáveis por
 * TODOS os formatos (o bot já honra a keyword em todos os ramos). Retorna se a busca de
 * frases deve ser ligada: assim que o /portal/perfil carrega (INDEPENDE de
 * `modo_atendente`) — clone sem perfil carregado ainda NÃO chama a rota (evita request
 * a mais no boot). O 404 do GET segue como rede de proteção na seção.
 */
export function frasesHabilitadas(cfg: { modo_atendente?: boolean } | null | undefined): boolean {
  return cfg != null;
}
