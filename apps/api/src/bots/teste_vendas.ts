import type { BotContext } from '@startap/core/types';
import { botCourses, botMedia, leads } from '@startap/db';
import { waha } from '@startap/integrations';
import type { ToolDefinition } from '@startap/integrations/openai';
import { buildContextBlock } from '../lib/free-slots.js';
import { applyFlowManualCommand } from '../lib/manual-pause.js';
import { renderPrompt } from '../lib/render-prompt.js';
import { runAgentConfigured } from '../lib/run-agent.js';
import { BotBase } from './base.js';
import {
  type ConversationState,
  type ParsedMarker,
  delay,
  formatCoursesForPrompt,
  formatMediaForPrompt,
  formatPrice,
  parseConversationState,
  parseMarker,
  sanitizar,
} from './lib/vendas-utils.js';

const SLOT = 'teste_vendas';
const WORKFLOW_ID = 'dlpKXM3gvX2joC1b';
const WORKFLOW_NAME = 'teste_vendas';
const PAUSE_TABLE = 'pause_ricardo';

/**
 * SEED inicial — em runtime o prompt vem só do banco (bot_prompt).
 * Este template é referência para popular o banco em setup inicial; não é usado em execução.
 * Somente persona + regras + marcadores. Dados dinâmicos (cliente, cursos,
 * mídias, estado da conversa) são injetados via buildContextBlock em runtime.
 */
const DEFAULT_PROMPT_TPL = [
  'Voce e um assistente virtual do Curso de Barbeiro Profissional do Ricardo.',
  'Atenda os interessados com simpatia, entusiasmo e objetividade. Maximo 3 linhas por resposta.',
  '',
  '[SOBRE OS CURSOS]',
  'Duracao: 3 meses | 2x por semana',
  'Horarios: Manha 09h-11h | Tarde 15h-17h',
  'Inclui: Apostila completa, fardamento e suporte no grupo de WhatsApp',
  'Diploma valido em mais de 122 paises - trabalha em qualquer lugar do Brasil',
  'Curso pratico, do zero ao profissional',
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
  '   NUNCA emita [VIDEO:<id>] para uma midia ja enviada nesta conversa (ver [ESTADO DA CONVERSA] no contexto).',
  '   Se o cliente pedir explicitamente ver de novo, voce pode emitir o marcador conscientemente.',
  '',
  '4. [VIDEOS_CURSO] — use quando o cliente pedir todos os videos do curso ("manda tudo", "envia todos").',
  '   So use se ja houver um CURSO ESCOLHIDO na conversa.',
  '',
  'REGRAS ABSOLUTAS DOS MARCADORES:',
  '- Nunca mencione os marcadores para o cliente.',
  '- Nunca emita [CURSO:<slug>] sem escolha explicita do cliente.',
  '- Nunca emita [VIDEO:<id>] se o id nao existir na biblioteca do contexto.',
  '- Se o cliente demonstrou interesse mas nao escolheu curso: use [LISTA_CURSOS] primeiro.',
  '',
  '[REGRAS ABSOLUTAS - VIOLACAO = FALHA CRITICA]',
  '1. PROIBIDO perguntar nome ou telefone - os dados do cliente estao no contexto.',
  '2. NUNCA invente informacoes sobre o curso.',
  '3. NUNCA cite precos de outros cursos.',
  '4. Maximo 3 linhas por resposta. Uma pergunta por vez.',
  '5. Quando cliente quiser se inscrever -> use ferramenta salvar_lead.',
  '',
  '[COMPORTAMENTO AUTOMATICO DO SISTEMA]',
  '- Quando o cliente emitir [CURSO:<slug>], o sistema envia automaticamente UM video aleatorio do catalogo daquele curso. Voce nao precisa mencionar nem repetir esse video.',
  '- Voce TEM acesso a uma biblioteca de midias listada em [MIDIAS DISPONIVEIS] no contexto. Use-a conforme a conversa pedir: depoimentos, demo de modulo, screenshots, etc.',
  '- NUNCA repita midias ja enviadas (ids listados em [ESTADO DA CONVERSA] no contexto).',
  '- Para enviar uma midia adicional, emita [VIDEO:<media_id>] passando o ID numerico da midia.',
].join('\n');

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

    // Carrega dados dinamicos para o contexto
    const [courses, allMedia] = await Promise.all([
      botCourses.listCoursesBySlot(this.slot),
      botMedia.listBySlot(this.slot),
    ]);

    const estadoConversa = [
      `Curso escolhido: ${state.cursoEscolhido ?? 'nenhum ate agora'}`,
      `Midias ja enviadas: ${state.mediaIdsSentSet.size > 0 ? Array.from(state.mediaIdsSentSet).join(', ') : 'nenhuma'}`,
    ].join('\n');

    const now = new Date();
    const dataAtual = now.toLocaleDateString('pt-BR', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'America/Sao_Paulo',
    });

    // Prompt: somente persona+regras (editavel pelo painel sem risco).
    // Dados do cliente, cursos, midias e estado ficam no bloco de contexto
    // imutavel — protege contra remocao acidental (Bruno 2026-05-20).
    let promptPersona: string;
    try {
      promptPersona = await renderPrompt({ slot: this.slot, vars: {} });
    } catch (err) {
      this.log.error({ err, slot: this.slot, telefone }, 'renderPrompt falhou — bot nao responde');
      return null;
    }

    const contextBlock = await buildContextBlock({
      slot: this.slot,
      nomeCliente: pushName || telefone,
      telefoneCliente: telefone,
      dataAtual,
      ano: String(now.getFullYear()),
      agendaFormatada: '',
      cursosDisponiveis: formatCoursesForPrompt(courses),
      midiasDisponiveis: formatMediaForPrompt(allMedia),
      estadoConversa,
    });

    const systemPrompt = `${promptPersona}\n\n${contextBlock}`;

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
        const candidates = allMedia.filter(
          (m) => m.course_slug === courseSlug && m.enabled && m.url,
        );
        const naoEnviadas = candidates.filter((m) => !state.mediaIdsSentSet.has(m.id));
        const pool = naoEnviadas.length > 0 ? naoEnviadas : candidates;

        if (pool.length === 0) {
          this.log.warn(
            { slot: effectiveSlot, courseSlug },
            'CURSO: sem videos cadastrados para o curso — enviando apenas o texto',
          );
        } else {
          const escolhido = pool[Math.floor(Math.random() * pool.length)];
          await waha.sendMedia({
            type: 'video',
            sessao,
            chatId,
            url: escolhido.url!,
            caption: escolhido.caption ?? undefined,
          });
          await this.appendMemory(ctx, 'system', `[STATE:CURSO_ESCOLHIDO:${courseSlug}]`);
          await this.appendMemory(ctx, 'system', `[STATE:VIDEO_SENT:${escolhido.id}]`);
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
