import type { BotContext } from '@startap/core/types';
import { botCourses, botMedia, leads } from '@startap/db';
import { waha } from '@startap/integrations';
import type { ToolDefinition } from '@startap/integrations/openai';
import { applyFlowManualCommand } from '../lib/manual-pause.js';
import { renderPrompt } from '../lib/render-prompt.js';
import { runAgentConfigured } from '../lib/run-agent.js';
import { BotBase } from './base.js';

const SLOT = 'teste_vendas';
const WORKFLOW_ID = 'dlpKXM3gvX2joC1b';
const WORKFLOW_NAME = 'teste_vendas';
const PAUSE_TABLE = 'pause_ricardo';

// Marcadores que a IA emite no final da resposta (última linha).
const MARKER_LISTA_CURSOS = '[LISTA_CURSOS]';
const MARKER_CURSO_RE = /^\[CURSO:([^\]]+)\]$/i;
const MARKER_VIDEO_RE = /^\[VIDEO:(\d+)\]$/i;
const MARKER_VIDEOS_CURSO = '[VIDEOS_CURSO]';

interface ParsedMarker {
  type: 'LISTA_CURSOS' | 'CURSO' | 'VIDEO' | 'VIDEOS_CURSO' | null;
  courseSlug?: string;
  mediaId?: number;
  clean: string;
}

/** Extrai o marcador da última linha do texto e retorna texto limpo + marcador parseado. */
function parseMarker(text: string): ParsedMarker {
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

/** Estado conversacional extraído do histórico de memória. */
interface ConversationState {
  cursoEscolhido: string | null;
  mediaIdsSentSet: Set<number>;
}

function parseConversationState(
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

function formatPrice(centavos: number): string {
  return `R$${(centavos / 100).toFixed(2).replace('.', ',')}`;
}

function formatCoursesForPrompt(
  courses: Awaited<ReturnType<typeof botCourses.listCoursesBySlot>>,
): string {
  if (!courses.length) return '(nenhum curso cadastrado)';
  return courses
    .filter((c) => c.enabled)
    .map(
      (c) =>
        `- ${c.course_slug}: ${c.name}${c.price ? ` (${formatPrice(c.price)})` : ''}${c.duration ? ` | ${c.duration}` : ''}`,
    )
    .join('\n');
}

function formatMediaForPrompt(medias: Awaited<ReturnType<typeof botMedia.listBySlot>>): string {
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

const DEFAULT_PROMPT_TPL = [
  'Voce e um assistente virtual do Curso de Barbeiro Profissional do Ricardo.',
  'Atenda os interessados com simpatia, entusiasmo e objetividade. Maximo 3 linhas por resposta.',
  '',
  '[DADOS DO CLIENTE - JA IDENTIFICADO]',
  'NOME: {nome}',
  'WHATSAPP: {telefone}',
  '',
  '[CURSOS DISPONIVEIS]',
  '{cursos_disponiveis}',
  '',
  '[SOBRE OS CURSOS]',
  'Duracao: 3 meses | 2x por semana',
  'Horarios: Manha 09h-11h | Tarde 15h-17h',
  'Inclui: Apostila completa, fardamento e suporte no grupo de WhatsApp',
  'Diploma valido em mais de 122 paises - trabalha em qualquer lugar do Brasil',
  'Curso pratico, do zero ao profissional',
  '',
  '[MIDIAS DA BIBLIOTECA]',
  '{midias_biblioteca}',
  '',
  '[ESTADO DA CONVERSA]',
  '{estado_conversa}',
  '',
  '[MARCADORES DE ACAO - REGRAS CRITICAS]',
  'Voce pode emitir UM marcador no FINAL da sua resposta (ultima linha), nunca no meio.',
  'O cliente nunca ve os marcadores — o sistema os remove antes de enviar.',
  '',
  'Marcadores disponiveis:',
  '1. [LISTA_CURSOS] — use quando o cliente pedir para ver os cursos ou demonstrar interesse generico.',
  '   Ao emitir [LISTA_CURSOS], NAO mencione nomes, precos ou descricoes dos cursos no texto da sua resposta.',
  '   Escreva apenas uma frase curta convidando o cliente a conhecer as opcoes (ex: "Temos algumas opcoes de curso — da uma olhada:").',
  '   O sistema vai enviar a lista formatada logo apos sua mensagem.',
  '',
  '2. [CURSO:<course_slug>] — use quando o cliente escolher explicitamente UM curso.',
  '   Substitua <course_slug> pelo slug do curso (ex.: [CURSO:curso-online-degrade]).',
  '   O sistema envia o video de apresentacao do curso escolhido.',
  '',
  '3. [VIDEO:<media_id>] — use quando identificar uma midia relevante na biblioteca para a pergunta do cliente.',
  '   Substitua <media_id> pelo ID numerico da midia.',
  '   NUNCA emita [VIDEO:<id>] para uma midia ja enviada nesta conversa (ver ESTADO DA CONVERSA).',
  '   Se o cliente pedir explicitamente ver de novo, voce pode emitir o marcador conscientemente.',
  '',
  '4. [VIDEOS_CURSO] — use quando o cliente pedir todos os videos do curso ("manda tudo", "envia todos").',
  '   So use se ja houver um CURSO ESCOLHIDO na conversa.',
  '',
  'REGRAS ABSOLUTAS DOS MARCADORES:',
  '- Nunca mencione os marcadores para o cliente.',
  '- Nunca emita [CURSO:<slug>] sem escolha explicita do cliente.',
  '- Nunca emita [VIDEO:<id>] se o id nao existir na biblioteca acima.',
  '- Se o cliente demonstrou interesse mas nao escolheu curso: use [LISTA_CURSOS] primeiro.',
  '',
  '[REGRAS ABSOLUTAS - VIOLACAO = FALHA CRITICA]',
  '1. PROIBIDO perguntar nome ou telefone - voce ja tem acima.',
  '2. NUNCA invente informacoes sobre o curso.',
  '3. NUNCA cite precos de outros cursos.',
  '4. Maximo 3 linhas por resposta. Uma pergunta por vez.',
  '5. Quando cliente quiser se inscrever -> use ferramenta salvar_lead.',
].join('\n');

function sanitizar(text: string): string {
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

export class TesteVendasBot extends BotBase {
  constructor(opts?: { slotOverride?: string }) {
    super({
      name: opts?.slotOverride ?? SLOT,
      projectId: SLOT,
      pauseTable: PAUSE_TABLE,
      memoryTable: 'chat_histories_ricardo',
      memoryWindow: 10,
      slotOverride: opts?.slotOverride,
    });
  }

  protected async process(ctx: BotContext): Promise<string | null> {
    const { telefone, texto, pushName, sessao, chatId } = ctx.message;
    const trimmed = texto.trim();
    if (!trimmed) return null;

    const lower = trimmed.toLowerCase();

    // Comandos manuais de pausa
    if (lower === 'ricardo aqui!!' || lower === 'startap aqui!!') {
      await applyFlowManualCommand({
        command: 'pause',
        flowId: ctx.flowId ?? WORKFLOW_ID,
        flowName: ctx.flowName ?? WORKFLOW_NAME,
        telefone,
        session: sessao,
        source: 'manual',
        reason: 'Comando manual no fluxo Ricardo',
      });
      this.log.info({ telefone }, 'Pausa manual ativada');
      return null;
    }
    if (lower === 'ricardo voltar!!' || lower === 'startap voltar!!') {
      await applyFlowManualCommand({
        command: 'resume',
        flowId: ctx.flowId ?? WORKFLOW_ID,
        flowName: ctx.flowName ?? WORKFLOW_NAME,
        telefone,
        session: sessao,
        source: 'manual',
      });
      this.log.info({ telefone }, 'Pausa manual removida');
      return null;
    }

    const fullHistory = await this.loadHistory(ctx);
    const history = fullHistory.slice(0, -1);
    const state = parseConversationState(history);

    // Carrega dados dinâmicos para o prompt
    const [courses, allMedia] = await Promise.all([
      botCourses.listCoursesBySlot(this.slot),
      botMedia.listBySlot(this.slot),
    ]);

    const estadoConversa = [
      `Curso escolhido: ${state.cursoEscolhido ?? 'nenhum ate agora'}`,
      `Midias ja enviadas: ${state.mediaIdsSentSet.size > 0 ? Array.from(state.mediaIdsSentSet).join(', ') : 'nenhuma'}`,
    ].join('\n');

    const systemPrompt = await renderPrompt({
      slot: this.slot,
      fallback: DEFAULT_PROMPT_TPL,
      vars: {
        nome: pushName || telefone,
        telefone,
        cursos_disponiveis: formatCoursesForPrompt(courses),
        midias_biblioteca: formatMediaForPrompt(allMedia),
        estado_conversa: estadoConversa,
      },
    });

    const tools: ToolDefinition[] = [
      {
        name: 'salvar_lead',
        description:
          'Salva o lead do cliente interessado no curso. Use quando o cliente demonstrar intencao de se inscrever. ' +
          'Passe o nome do cliente e uma descricao do interesse.',
        parameters: {
          type: 'object',
          properties: {
            nome: { type: 'string', description: 'Nome do cliente' },
            interesse: { type: 'string', description: 'Resumo do interesse do cliente no curso' },
          },
          required: ['nome', 'interesse'],
        },
        run: async (args: unknown) => {
          const { nome, interesse } = args as { nome: string; interesse: string };
          await leads.saveLeadRicardo({
            nome,
            telefone,
            mensagem_inicial: interesse,
            origem: 'whatsapp',
            slot: this.slot,
          });
          this.log.info({ telefone, nome }, 'Lead Ricardo salvo');
          return { ok: true };
        },
      },
    ];

    const result = await runAgentConfigured({
      slot: this.slot,
      projectId: this.slot,
      flowId: ctx.flowId,
      telefone,
      systemPrompt,
      history,
      userMessage: trimmed,
      tools,
      maxTurns: 5,
    });

    const sanitized = sanitizar(result.reply);
    const { type, courseSlug, mediaId, clean } = parseMarker(sanitized);
    const finalText = clean || sanitized;

    if (type !== null) {
      const effectiveSlot = this.slot;
      // delay explícito: garante que WAHA processe o texto antes de enviar mídia.
      // await no lugar de setTimeout fire-and-forget — erro agora é capturável (ADR 0010 Opção A).
      const delay = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
      try {
        await delay(2500);
        await this.handleMarker({
          type,
          courseSlug,
          mediaId,
          sessao,
          chatId,
          effectiveSlot,
          state,
          ctx,
        });
      } catch (e) {
        this.log.error({ err: e, type, telefone }, 'Falha ao processar marcador do bot');
      }
    }

    return finalText;
  }

  private async handleMarker(input: {
    type: ParsedMarker['type'];
    courseSlug?: string;
    mediaId?: number;
    sessao: string;
    chatId: string;
    effectiveSlot: string;
    state: ConversationState;
    ctx: BotContext;
  }): Promise<void> {
    const { type, courseSlug, mediaId, sessao, chatId, effectiveSlot, state, ctx } = input;

    switch (type) {
      case 'LISTA_CURSOS': {
        const courses = await botCourses.listCoursesBySlot(effectiveSlot);
        const enabled = courses.filter((c) => c.enabled);
        if (!enabled.length) {
          this.log.warn({ slot: effectiveSlot }, 'LISTA_CURSOS: nenhum curso habilitado');
          return;
        }
        const lista = enabled
          .map(
            (c) =>
              `• *${c.name}*${c.price ? ` — ${formatPrice(c.price)}` : ''}${c.duration ? ` | ${c.duration}` : ''}${c.description ? `\n  ${c.description}` : ''}`,
          )
          .join('\n');
        await waha.sendText({
          sessao,
          chatId,
          texto: `📚 *Cursos disponíveis:*\n\n${lista}`,
          typing: false,
        });
        break;
      }

      case 'CURSO': {
        if (!courseSlug) return;

        const allMedia = await botMedia.listBySlot(effectiveSlot);
        const introMedia = allMedia.find(
          (m) => m.course_slug === courseSlug && m.is_course_intro && m.enabled && m.url,
        );

        if (!introMedia) {
          this.log.warn(
            { slot: effectiveSlot, courseSlug },
            'CURSO: sem video intro cadastrado — enviando apenas o texto',
          );
        } else {
          await waha.sendMedia({
            type: 'video',
            sessao,
            chatId,
            url: introMedia.url!,
            caption: introMedia.caption ?? undefined,
          });
          await this.appendMemory(ctx, 'system', `[STATE:CURSO_ESCOLHIDO:${courseSlug}]`);
          await this.appendMemory(ctx, 'system', `[STATE:VIDEO_SENT:${introMedia.id}]`);
        }
        break;
      }

      case 'VIDEO': {
        if (!mediaId) return;

        const allMedia = await botMedia.listBySlot(effectiveSlot);
        const media = allMedia.find((m) => m.id === mediaId && m.enabled && m.url);
        if (!media) {
          this.log.warn({ slot: effectiveSlot, mediaId }, 'VIDEO: midia nao encontrada ou sem url');
          return;
        }
        await waha.sendMedia({
          type: media.media_type === 'image' ? 'image' : 'video',
          sessao,
          chatId,
          url: media.url!,
          caption: media.caption ?? undefined,
        });
        await this.appendMemory(ctx, 'system', `[STATE:VIDEO_SENT:${mediaId}]`);
        break;
      }

      case 'VIDEOS_CURSO': {
        if (!state.cursoEscolhido) {
          this.log.warn({ slot: effectiveSlot }, 'VIDEOS_CURSO: sem curso escolhido na sessao');
          return;
        }
        const allMedia = await botMedia.listBySlot(effectiveSlot);
        const courseMedia = allMedia
          .filter((m) => m.course_slug === state.cursoEscolhido && m.enabled && m.url)
          .sort((a, b) => {
            if (a.is_course_intro && !b.is_course_intro) return -1;
            if (!a.is_course_intro && b.is_course_intro) return 1;
            return a.position_order - b.position_order;
          });

        if (!courseMedia.length) {
          this.log.warn(
            { slot: effectiveSlot, curso: state.cursoEscolhido },
            'VIDEOS_CURSO: sem midias para o curso',
          );
          return;
        }
        for (const m of courseMedia) {
          await waha.sendMedia({
            type: m.media_type === 'image' ? 'image' : 'video',
            sessao,
            chatId,
            url: m.url!,
            caption: m.caption ?? undefined,
          });
          await this.appendMemory(ctx, 'system', `[STATE:VIDEO_SENT:${m.id}]`);
        }
        break;
      }
    }
  }
}

export { DEFAULT_PROMPT_TPL as TESTE_VENDAS_DEFAULT_PROMPT };
