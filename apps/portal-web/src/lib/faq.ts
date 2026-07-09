/**
 * Lógica pura da seção "Perguntas frequentes" (FAQ personalizado, SCRUM-65) da tela
 * Meu negócio. Sem React/DOM — testável.
 *
 * O dono cadastra ATÉ 10 pares pergunta/resposta com respostas "oficiais" do negócio
 * (ex.: "Vocês têm estacionamento?" / "Sim, estacionamento próprio e gratuito na
 * lateral"). Cada par vira uma linha P:/R: no bloco [PERGUNTAS FREQUENTES DO NEGOCIO]
 * do contexto do bot — a assistente passa a responder aquele assunto com o texto do dono.
 *
 * CONTRATO (backend em paralelo — NÃO mudar; se divergir, PARAR e reportar):
 *   GET /portal/perfil -> { perfil: { faq_personalizado?: FaqItem[] }, features?: { faq_personalizado } }
 *   PUT /portal/perfil body { perfil: { faq_personalizado: FaqItem[] } }  (lista completa = replace-set)
 *   Regras (validação DURA server-side): máx 10 pares; pergunta 1..120 e resposta 1..300
 *   chars (após trim); par com pergunta OU resposta vazia é DESCARTADO no preprocess (não
 *   é erro); 400 { error } quando o que sobra viola. Gate: features.faq_personalizado
 *   (por-clone via FAQ_PERSONALIZADO_SLOTS — NÃO flag global). PUT recusa a chave (404/400)
 *   quando o gate está OFF pro clone.
 *
 * A validação daqui ESPELHA a do backend só pra dar feedback imediato — o backend é a
 * autoridade (a UI trava o Salvar em estado inválido; o 400 é a rede de proteção).
 */
import { ApiError } from './api';
import type { FaqItem } from './api-types';

/** Teto de pares (dado do Bruno; espelha o .max(10) do backend). */
export const FAQ_MAX = 10;
/** Limite de caracteres da pergunta (após trim). Título de assunto — 120 é folgado. */
export const PERGUNTA_MAX = 120;
/** Limite de caracteres da resposta (após trim). 2-3 frases pontuais. */
export const RESPOSTA_MAX = 300;

/** Linha do rascunho de UI: um par + id só de cliente (React key + edição). */
export interface FaqDraft {
  /** id LOCAL (a lista é replace-set; o backend não guarda id). */
  id: number;
  pergunta: string;
  resposta: string;
}

/**
 * Feature OFF (defesa em profundidade): 404/400 no PUT quando o gate está desligado pro
 * clone. Na prática a seção nem renderiza sem features.faq_personalizado, então isto só
 * cobre uma corrida rara (feature desligada entre o load e o save).
 */
export function isFaqFeatureOff(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 400);
}

/** 400: o backend recusou a lista (regra de negócio) — rede de proteção. */
export function isFaqRejeitada(err: unknown): boolean {
  return err instanceof ApiError && err.status === 400;
}

/** Coage um valor cru pro par {pergunta,resposta} (strings; qualquer coisa fora vira ''). */
function toItem(v: unknown): FaqItem {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    pergunta: typeof o.pergunta === 'string' ? o.pergunta : '',
    resposta: typeof o.resposta === 'string' ? o.resposta : '',
  };
}

/** Resposta do backend -> rascunho de UI (id local por índice — determinístico). */
export function toFaqDraft(itens: readonly FaqItem[] | null | undefined): FaqDraft[] {
  if (!Array.isArray(itens)) return [];
  return itens.map((raw, i) => {
    const it = toItem(raw);
    return { id: i + 1, pergunta: it.pergunta, resposta: it.resposta };
  });
}

/** Próximo id local livre (max + 1) pra uma linha nova sem colidir com as existentes. */
export function newFaqId(drafts: readonly FaqDraft[]): number {
  return drafts.reduce((max, d) => Math.max(max, d.id), 0) + 1;
}

/** True quando já bateu o teto de pares (trava o "Adicionar"). */
export function atMaxFaq(drafts: readonly FaqDraft[]): boolean {
  return drafts.length >= FAQ_MAX;
}

/** Adiciona uma linha vazia. No-op se já no teto. */
export function addFaq(drafts: readonly FaqDraft[]): FaqDraft[] {
  if (atMaxFaq(drafts)) return [...drafts];
  return [...drafts, { id: newFaqId(drafts), pergunta: '', resposta: '' }];
}

export function removeFaq(drafts: readonly FaqDraft[], id: number): FaqDraft[] {
  return drafts.filter((d) => d.id !== id);
}

export function setFaqPergunta(
  drafts: readonly FaqDraft[],
  id: number,
  pergunta: string,
): FaqDraft[] {
  return drafts.map((d) => (d.id === id ? { ...d, pergunta } : d));
}

export function setFaqResposta(
  drafts: readonly FaqDraft[],
  id: number,
  resposta: string,
): FaqDraft[] {
  return drafts.map((d) => (d.id === id ? { ...d, resposta } : d));
}

/** Linha totalmente em branco (após trim) — ignorada no save, não é erro (slot livre). */
export function isRowEmpty(d: FaqDraft): boolean {
  return d.pergunta.trim() === '' && d.resposta.trim() === '';
}

/** Linha completa: pergunta E resposta preenchidas (após trim). */
export function isRowComplete(d: FaqDraft): boolean {
  return d.pergunta.trim() !== '' && d.resposta.trim() !== '';
}

export type FaqError = 'incompleto' | 'pergunta_longa' | 'resposta_longa';

/** Microcopy de cada erro de linha (público leigo). */
export const FAQ_ERROR_MSG: Record<FaqError, string> = {
  incompleto: 'Preencha a pergunta e a resposta, ou remova este item.',
  pergunta_longa: `Pergunta muito longa. Máximo de ${PERGUNTA_MAX} caracteres.`,
  resposta_longa: `Resposta muito longa. Máximo de ${RESPOSTA_MAX} caracteres.`,
};

/**
 * Valida todas as linhas. Devolve um mapa id->erro (só das inválidas). Regras (espelham
 * o backend, na ordem que dá o feedback mais acionável):
 *  - linha totalmente vazia -> IGNORADA (não bloqueia, será descartada no save);
 *  - pergunta > 120 -> 'pergunta_longa';
 *  - resposta > 300 -> 'resposta_longa';
 *  - só um dos dois preenchido -> 'incompleto' (o backend descartaria em silêncio; aqui
 *    avisamos pra não perder o que o dono digitou).
 */
export function validateFaq(drafts: readonly FaqDraft[]): Map<number, FaqError> {
  const errors = new Map<number, FaqError>();
  for (const d of drafts) {
    if (isRowEmpty(d)) continue;
    if (d.pergunta.trim().length > PERGUNTA_MAX) {
      errors.set(d.id, 'pergunta_longa');
      continue;
    }
    if (d.resposta.trim().length > RESPOSTA_MAX) {
      errors.set(d.id, 'resposta_longa');
      continue;
    }
    if (!isRowComplete(d)) {
      errors.set(d.id, 'incompleto');
    }
  }
  return errors;
}

/** Pares que de fato vão pro backend (completos, após trim) — base do contador de teto. */
export function faqCompletos(drafts: readonly FaqDraft[]): FaqDraft[] {
  return drafts.filter(isRowComplete);
}

/** Pronto pra salvar? Sem erros de linha E dentro do teto de pares completos. */
export function isFaqValido(drafts: readonly FaqDraft[]): boolean {
  return validateFaq(drafts).size === 0 && faqCompletos(drafts).length <= FAQ_MAX;
}

/**
 * Draft mudou em relação ao salvo? Comparação POSICIONAL só das linhas COMPLETAS por
 * conteúdo aparado (pergunta + resposta) — id local é ignorado; linhas em branco/incompletas
 * não contam (não vão pro backend), então adicionar uma linha vazia não marca "não salvo".
 */
export function isFaqDirty(a: readonly FaqDraft[], b: readonly FaqDraft[]): boolean {
  const ca = faqCompletos(a);
  const cb = faqCompletos(b);
  if (ca.length !== cb.length) return true;
  return ca.some((x, i) => {
    const y = cb[i];
    return x.pergunta.trim() !== y.pergunta.trim() || x.resposta.trim() !== y.resposta.trim();
  });
}

/**
 * Rascunho -> body do PUT (replace-set). Descarta linhas vazias/incompletas e envia
 * pergunta/resposta já trimadas (mesmo preprocess do backend), capadas no teto por
 * segurança. Chamado só em estado válido (a UI trava o Salvar antes).
 */
export function toFaqPayload(drafts: readonly FaqDraft[]): FaqItem[] {
  return faqCompletos(drafts)
    .slice(0, FAQ_MAX)
    .map((d) => ({ pergunta: d.pergunta.trim(), resposta: d.resposta.trim() }));
}
