// funções puras compartilhadas pelos bots de vendas (ADR 0011 — Opção C)
// handleMarker permanece isolado em cada bot (stateful, Regra de Ouro 7)
import type { BotCourseRow, BotMediaRow } from '@startap/db';

// Marcadores que a IA emite no final da resposta (última linha).
const MARKER_LISTA_CURSOS = '[LISTA_CURSOS]';
const MARKER_CURSO_RE = /^\[CURSO:([^\]]+)\]$/i;
const MARKER_VIDEO_RE = /^\[VIDEO:(\d+)\]$/i;
const MARKER_VIDEOS_CURSO = '[VIDEOS_CURSO]';

export interface ParsedMarker {
  type: 'LISTA_CURSOS' | 'CURSO' | 'VIDEO' | 'VIDEOS_CURSO' | null;
  courseSlug?: string;
  mediaId?: number;
  clean: string;
}

/** Estado conversacional extraído do histórico de memória. */
export interface ConversationState {
  cursoEscolhido: string | null;
  mediaIdsSentSet: Set<number>;
}

/** Extrai o marcador da última linha do texto e retorna texto limpo + marcador parseado. */
export function parseMarker(text: string): ParsedMarker {
  const lines = text.trimEnd().split('\n');
  const lastLine = lines[lines.length - 1].trim();
  const textWithoutLast = lines.slice(0, -1).join('\n').trimEnd();

  if (lastLine === MARKER_LISTA_CURSOS) {
    return { type: 'LISTA_CURSOS', clean: textWithoutLast };
  }
  if (lastLine === MARKER_VIDEOS_CURSO) {
    return { type: 'VIDEOS_CURSO', clean: textWithoutLast };
  }
  const cursoMatch = lastLine.match(MARKER_CURSO_RE);
  if (cursoMatch) {
    return { type: 'CURSO', courseSlug: cursoMatch[1], clean: textWithoutLast };
  }
  const videoMatch = lastLine.match(MARKER_VIDEO_RE);
  if (videoMatch) {
    return { type: 'VIDEO', mediaId: Number(videoMatch[1]), clean: textWithoutLast };
  }
  return { type: null, clean: text.trim() };
}

export function parseConversationState(
  history: Array<{ role: string; content: string }>,
): ConversationState {
  let cursoEscolhido: string | null = null;
  const mediaIdsSentSet = new Set<number>();

  for (const turn of history) {
    if (turn.role === 'system') {
      const cursoMatch = turn.content.match(/\[STATE:CURSO_ESCOLHIDO:([^\]]+)\]/);
      if (cursoMatch) cursoEscolhido = cursoMatch[1] === 'null' ? null : cursoMatch[1];

      const videoMatch = turn.content.match(/\[STATE:VIDEO_SENT:(\d+)\]/g);
      if (videoMatch) {
        for (const m of videoMatch) {
          const id = m.match(/\[STATE:VIDEO_SENT:(\d+)\]/)?.[1];
          if (id) mediaIdsSentSet.add(Number(id));
        }
      }
    }
  }
  return { cursoEscolhido, mediaIdsSentSet };
}

export function formatPrice(centavos: number): string {
  return `R$${(centavos / 100).toFixed(2).replace('.', ',')}`;
}

export function formatCoursesForPrompt(courses: BotCourseRow[]): string {
  const enabled = courses.filter((c) => c.enabled);
  if (!enabled.length) return '(nenhum curso cadastrado)';
  return enabled
    .map((c) => {
      const priceStr = c.price ? ` (${formatPrice(c.price)})` : '';
      const durStr = c.duration ? ` ${c.duration}` : '';
      const header = `• ${c.name}${priceStr}${durStr}`;
      const slug = `  Slug: ${c.course_slug}`;
      if (c.details_for_llm && c.details_for_llm.trim() !== '') {
        const indented = c.details_for_llm.trim().split('\n').join('\n  ');
        return `${header}\n${slug}\n  Detalhes:\n  ${indented}`;
      }
      return `${header}\n${slug}`;
    })
    .join('\n\n');
}

export function formatMediaForPrompt(medias: BotMediaRow[]): string {
  const enabled = medias.filter((m) => m.enabled);
  if (!enabled.length) return '(nenhuma midia cadastrada)';
  return enabled
    .map((m) => {
      const context = m.context || m.caption || '(sem descricao)';
      if (m.course_slug) {
        const role = m.is_course_intro ? 'intro' : 'secundario';
        return `- ID ${m.id} (${m.media_type}, curso: ${m.course_slug}, ${role}): ${context}`;
      }
      return `- ID ${m.id} (${m.media_type}, contexto livre): ${context}`;
    })
    .join('\n');
}

export function sanitizar(text: string): string {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (t === '') return true;
      if (/^to=functions\./i.test(t)) return false;
      if (/^\{.*\}$/.test(t)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

// delay explícito: garante que WAHA processe o texto antes de enviar mídia.
// await no lugar de setTimeout fire-and-forget — erro agora é capturável (ADR 0010 Opção A).
export const delay = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
