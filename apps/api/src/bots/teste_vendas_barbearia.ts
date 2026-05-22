import type { BotContext } from '@startap/core/types';
import { botCourses, botMedia, flowExecutionLog, leads } from '@startap/db';
import { gcal, waha } from '@startap/integrations';
import type { ToolDefinition } from '@startap/integrations/openai';
import {
  buildContextBlock,
  formatarAgendaComConfig,
  loadScheduleConfig,
} from '../lib/free-slots.js';
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

export const TESTE_VENDAS_BARBEARIA_WORKFLOW_ID = 'teste_vendas_barbearia';

const SLOT = 'teste_vendas_barbearia';
const TZ = 'America/Sao_Paulo';

/**
 * SEED inicial — em runtime o prompt vem só do banco (bot_prompt).
 * Este template é referência para popular o banco em setup inicial; não é usado em execução.
 * Somente persona + regras + marcadores + fluxo de agendamento.
 * Dados dinâmicos (cliente, data, cursos, mídias, estado, horários, serviços)
 * são injetados via buildContextBlock em runtime.
 */
const DEFAULT_PROMPT_TPL = [
  'Voce e o atendente virtual da Startap Barbearia. Sua missao e encantar cada cliente.',
  'Voce atende dois assuntos no mesmo WhatsApp: vendas do Curso de Barbeiro Profissional e agendamento na barbearia.',
  '',
  '[TOM DE VOZ]',
  '- Seja simpatico, acolhedor e profissional. Trate o cliente pelo nome.',
  '- Use uma saudacao calorosa no primeiro contato.',
  '- Demonstre interesse genuino, agradeca o contato e seja prestativo do inicio ao fim.',
  '- Objetividade com gentileza: respostas em ate 3 linhas, uma pergunta por vez.',
  '- Pode usar emojis com moderacao (✂️ 💈 ✨ 😊) para deixar a conversa leve.',
  '',
  '[TRIAGEM DE INTENCAO]',
  '- Se o cliente falar de curso, formacao, preco do curso, matricula, inscricao, diploma ou aprender barbearia: atue como vendedor do curso.',
  '- Se o cliente falar de corte, barba, sobrancelha, horario, agenda, marcar, cancelar horario ou servico de barbearia: atue como atendente da barbearia.',
  '- Se estiver ambiguo, como "quanto custa?", pergunte gentilmente: "Posso te ajudar com o curso de barbeiro ou com um agendamento na barbearia?"',
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
  '1. [LISTA_CURSOS] — use quando o cliente pedir para ver os cursos, quiser saber quais sao, ou demonstrar interesse generico.',
  '   PROATIVIDADE: Se o cliente mencionar qualquer intencao de aprender, fazer curso, formacao profissional, virar barbeiro ou area correlata,',
  '   emita [LISTA_CURSOS] IMEDIATAMENTE no PRIMEIRO turno, sem esperar pedido explicito de ver a lista.',
  '   Ao emitir [LISTA_CURSOS], NAO mencione nomes, precos ou descricoes dos cursos no texto da sua resposta.',
  '   Escreva apenas uma frase curta convidando o cliente a conhecer as opcoes (ex: "Temos algumas opcoes de curso — da uma olhada:").',
  '   O sistema vai enviar a lista formatada logo apos sua mensagem.',
  '',
  '2. [CURSO:<course_slug>] — use quando o cliente escolher explicitamente UM curso especifico OU mencionar o nome/area de um curso especifico.',
  '   PROATIVIDADE: Se o cliente citar o nome ou area de um curso especifico, emita [CURSO:<slug>] IMEDIATAMENTE no PRIMEIRO turno, sem aguardar pedido explicito.',
  '   Substitua <course_slug> pelo slug do curso (ex.: [CURSO:curso-presencial-barbearia]).',
  '   O sistema envia o video de apresentacao do curso escolhido.',
  '',
  '3. [VIDEO:<media_id>] — use quando o cliente fizer uma pergunta contextual e voce identificar uma midia relevante na biblioteca.',
  '   Substitua <media_id> pelo ID numerico da midia (ex.: [VIDEO:42]).',
  '   So use este marcador se o contexto da midia for semanticamente relacionado com a pergunta.',
  '   NUNCA emita [VIDEO:<id>] para uma midia que ja foi enviada nesta conversa (ver [ESTADO DA CONVERSA] no contexto).',
  '   Se o cliente pedir explicitamente para ver de novo, voce pode emitir o marcador conscientemente.',
  '',
  '4. [VIDEOS_CURSO] — use quando o cliente pedir para ver TODOS os videos do curso ("manda tudo", "envia todos os videos", "quero ver tudo").',
  '   O sistema envia todos os videos do curso atual em sequencia (intro primeiro).',
  '   So use se ja houver um CURSO ESCOLHIDO na conversa.',
  '',
  'REGRAS ABSOLUTAS DOS MARCADORES:',
  '- Nunca mencione os marcadores para o cliente.',
  '- Nunca emita [CURSO:<slug>] sem ter um curso escolhido explicitamente pelo cliente.',
  '- Nunca emita [VIDEO:<id>] se o id nao existir na biblioteca do contexto.',
  '- Se o cliente demonstrou interesse generico mas ainda nao escolheu um curso: use [LISTA_CURSOS] IMEDIATAMENTE.',
  '- Se o cliente demonstrou interesse em curso especifico: use [CURSO:<slug>] IMEDIATAMENTE, sem esperar pedido explicito.',
  '',
  '[REGRAS ABSOLUTAS]',
  '1. PROIBIDO perguntar nome ou telefone. Os dados do cliente estao no contexto.',
  '2. NUNCA invente informacoes sobre curso, precos, horarios ou agenda.',
  '3. Para curso: quando cliente quiser se inscrever, use salvar_lead.',
  '4. Para barbearia: os [HORARIOS DISPONIVEIS] no contexto sao a UNICA fonte de verdade.',
  '5. Para agendar: DEVE chamar inserir_agendamento depois do SIM. NUNCA confirme sem ferramenta.',
  '6. Ao verificar disponibilidade, localize EXATAMENTE a linha do servico solicitado.',
  '',
  '[FLUXO DE AGENDAMENTO]',
  '1. Identifique servico e horario com gentileza.',
  '2. Se o horario nao aparecer na linha correta, informe que esta ocupado e sugira o mais proximo disponivel na mesma linha de servico.',
  '3. Se estiver disponivel, envie EXATAMENTE o cartao abaixo (substituindo apenas os valores entre colchetes):',
  '',
  '💈 *CARTAO DE CONFIRMACAO* 💈',
  '──────────────────────',
  '📅 *DIA:* [DD/MM/AAAA]',
  '⏰ *HORARIO:* [HH:MM]',
  '✂️ *SERVICO:* [nome do servico]',
  '💰 *VALOR:* R$[valor]',
  '──────────────────────',
  '✅ Responda *SIM* para confirmar.',
  '',
  '4. Apos o SIM, chame inserir_agendamento com Summary: "[Nome do cliente] - [SERVICO] | WhatsApp: [telefone]".',
  '5. Somente apos confirmacao da ferramenta, responda com simpatia: "Prontinho! Seu horario esta confirmado ✨ A Startap te espera!"',
  '',
  '[COMPORTAMENTO AUTOMATICO DO SISTEMA]',
  '- Quando o cliente emitir [CURSO:<slug>], o sistema envia automaticamente UM video aleatorio do catalogo daquele curso. Voce nao precisa mencionar nem repetir esse video.',
  '- Voce TEM acesso a uma biblioteca de midias listada em [MIDIAS DISPONIVEIS] no contexto. Use-a conforme a conversa pedir: depoimentos, demo de modulo, screenshots, etc.',
  '- NUNCA repita midias ja enviadas (ids listados em [ESTADO DA CONVERSA] no contexto).',
  '- Para enviar uma midia adicional, emita [VIDEO:<media_id>] passando o ID numerico da midia.',
].join('\n');

export class TesteVendasBarbeariaBot extends BotBase {
  constructor(opts?: { slotOverride?: string }) {
    super({
      name: opts?.slotOverride ?? SLOT,
      projectId: SLOT,
      pauseTable: null,
      memoryTable: 'chat_histories_vendas_barbearia',
      memoryWindow: 12,
      slotOverride: opts?.slotOverride,
    });
  }

  protected async process(ctx: BotContext): Promise<string | null> {
    const { telefone, texto, pushName, sessao, chatId } = ctx.message;
    const trimmed = texto.trim();
    if (!trimmed) return null;

    // Cancelamento — deteccao mantida; envio de alerta pausado (Bruno 2026-05-22).
    // Numero 553591746797@c.us removido: nao existe mais e feature nao e vendida ao cliente.
    // TODO: quando feature for retomada, ler bot_config.alert_destination por clone
    //       e enviar via waha.sendText para o destino configurado (sem hardcode).
    if (trimmed === 'Cancelar') {
      this.log.info(
        { slot: this.slot, telefone, pushName },
        'cancelamento detectado — feature de alerta pausada (Bruno 2026-05-22). TODO: implementar handoff pro dono do bot via bot_config.alert_destination quando feature for retomada.',
      );
      return 'ok! vou avisar o time, e logo entraremos em contato!';
    }

    const calClient = await gcal.getGcalForSlot(this.slot);
    if (!calClient) {
      this.log.error(
        { slot: this.slot },
        'gcal_not_configured — bot exige Service Account configurada via painel',
      );
      return 'Desculpe, a agenda deste fluxo ainda não foi configurada. Avise o administrador.';
    }

    const now = new Date();
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString();
    const events = await calClient.listEvents({ timeMin, timeMax }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (/40[13]/.test(msg)) gcal.invalidateGcalCache(this.slot);
      throw err;
    });
    // Lê horarios+servicos do clone (flow_clones) ou matriz (bot_config) e
    // formata agenda respeitando dias fechados. Antes usava WORK/SERVICES
    // hardcoded que ignoravam config do clone (sábado fechado virava aberto).
    const scheduleConfig = await loadScheduleConfig(this.slot);
    if (scheduleConfig.source === 'defaults' && this.slot !== SLOT) {
      this.log.warn(
        { slot: this.slot },
        'free-slots: clone sem horarios/servicos configurados — usando defaults',
      );
    }
    const agenda = formatarAgendaComConfig(events, scheduleConfig);
    const dataAtual = now.toLocaleDateString('pt-BR', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: TZ,
    });

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
      `Midias ja enviadas nesta conversa: ${state.mediaIdsSentSet.size > 0 ? Array.from(state.mediaIdsSentSet).join(', ') : 'nenhuma'}`,
    ].join('\n');

    // Prompt: somente persona+regras+marcadores (editavel pelo painel sem risco).
    // Dados do cliente, data, cursos, midias, estado e agenda ficam no bloco de
    // contexto imutavel — protege contra remocao acidental (Bruno 2026-05-20).
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
      agendaFormatada: agenda,
      cursosDisponiveis: formatCoursesForPrompt(courses),
      midiasDisponiveis: formatMediaForPrompt(allMedia),
      estadoConversa,
    });

    const basePrompt = `${promptPersona}\n\n${contextBlock}`;

    const tools: ToolDefinition[] = [
      {
        name: 'salvar_lead',
        description:
          'Salva o lead do cliente interessado no curso. Use quando o cliente demonstrar intencao de se inscrever.',
        parameters: {
          type: 'object',
          properties: {
            nome: { type: 'string', description: 'Nome do cliente' },
            interesse: {
              type: 'string',
              description: 'Resumo do interesse do cliente no curso',
            },
          },
          required: ['nome', 'interesse'],
        },
        run: async (args: unknown) => {
          const { nome, interesse } = args as {
            nome: string;
            interesse: string;
          };
          await leads.saveLeadVendasBarbearia({
            nome,
            telefone,
            mensagem_inicial: interesse,
            origem: 'whatsapp',
            slot: this.slot,
          });
          this.log.info({ telefone, nome }, 'Lead do fluxo hibrido salvo');
          return { ok: true };
        },
      },
      {
        name: 'inserir_agendamento',
        description:
          'Insere um agendamento no Google Calendar. Use APENAS apos o cliente confirmar com SIM.',
        parameters: {
          type: 'object',
          properties: {
            summary: {
              type: 'string',
              description: 'Titulo: "Nome - Servico | WhatsApp: numero"',
            },
            start: {
              type: 'string',
              description: 'Inicio ISO 8601 com timezone',
            },
            end: { type: 'string', description: 'Fim ISO 8601 com timezone' },
          },
          required: ['summary', 'start', 'end'],
        },
        run: async (args: unknown) => {
          const { summary, start, end } = args as {
            summary: string;
            start: string;
            end: string;
          };

          // Validação server-side: impede criação de evento com overlap real no Calendar.
          // O LLM pode alucinar disponibilidade — esta verificação é a fonte de verdade.
          const existing = await calClient.listEvents({
            timeMin: start,
            timeMax: end,
          });
          const reqStart = new Date(start).getTime();
          const reqEnd = new Date(end).getTime();
          const conflito = existing.find((ev) => {
            const evStart = new Date(ev.start.dateTime ?? ev.start.date ?? start).getTime();
            const evEnd = new Date(ev.end.dateTime ?? ev.end.date ?? end).getTime();
            return evStart < reqEnd && evEnd > reqStart;
          });
          if (conflito) {
            this.log.warn(
              {
                conflito: {
                  summary: conflito.summary,
                  start: conflito.start.dateTime,
                  end: conflito.end.dateTime,
                },
                requestedStart: start,
                requestedEnd: end,
                telefone,
              },
              'inserir_agendamento bloqueado: conflito detectado server-side (bot hibrido)',
            );
            return {
              ok: false,
              error: 'CONFLITO',
              conflito: {
                summary: conflito.summary,
                start: conflito.start.dateTime,
                end: conflito.end.dateTime,
              },
            };
          }

          const ev = await calClient.createEvent({
            summary,
            startISO: start,
            endISO: end,
            timeZone: TZ,
          });
          this.log.info(
            { eventId: ev.id, summary: ev.summary, telefone },
            'Agendamento criado pelo bot hibrido',
          );
          return { ok: true, eventId: ev.id, summary: ev.summary };
        },
      },
      {
        name: 'consultar_agendamento',
        description: 'Consulta agendamentos futuros do cliente no Google Calendar.',
        parameters: {
          type: 'object',
          properties: {
            telefone: {
              type: 'string',
              description: 'WhatsApp do cliente (so digitos)',
            },
          },
          required: ['telefone'],
        },
        run: async (args: unknown) => {
          const { telefone: tel } = args as { telefone: string };
          const tMin = new Date().toISOString();
          const tMax = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
          const evs = await calClient.listEvents({
            timeMin: tMin,
            timeMax: tMax,
          });
          const phone = tel.replace(/\D/g, '');
          const matching = evs.filter(
            (e) => e.summary?.includes(phone) || e.description?.includes(phone),
          );
          if (!matching.length)
            return {
              events: [],
              message: 'Nenhum agendamento futuro encontrado.',
            };
          return {
            events: matching.map((e) => ({
              summary: e.summary,
              start: e.start.dateTime,
              end: e.end.dateTime,
            })),
          };
        },
      },
    ];

    const result = await runAgentConfigured({
      slot: this.slot,
      projectId: this.slot,
      flowId: ctx.flowId,
      telefone,
      systemPrompt: basePrompt,
      history,
      userMessage: trimmed,
      tools,
      maxTurns: 5,
    });

    const sanitized = sanitizar(result.reply);
    const { type, courseSlug, mediaId, clean } = parseMarker(sanitized);
    const replyText = clean || sanitized;

    // Processa marcadores após enviar a resposta de texto
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
          telefone,
        });
      } catch (e) {
        this.log.error({ err: e, type, telefone }, 'Falha ao processar marcador do bot');
      }
    }

    return replyText;
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
    telefone: string;
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
          // Observabilidade: registra ausência de mídia disponível
          if (ctx.executionId) {
            await flowExecutionLog.logFlowEvent({
              executionId: ctx.executionId,
              flowId: ctx.flowId,
              flowName: ctx.flowName,
              bot: this.name,
              telefone: input.telefone,
              session: sessao,
              eventType: 'bot.media-skipped',
              status: 'ignored',
              message: `Nenhuma midia disponivel para o curso: ${courseSlug}`,
              metadata: {
                marker: 'CURSO',
                course_slug: courseSlug,
                reason: 'no_candidates',
              },
            });
          }
        } else {
          // Prioriza midia marcada como is_course_intro; fallback para aleatorio do pool.
          const intros = pool.filter((m) => m.is_course_intro === true);
          const escolhido =
            intros.length > 0
              ? intros[Math.floor(Math.random() * intros.length)]
              : pool[Math.floor(Math.random() * pool.length)];
          await waha.sendMedia({
            type: 'video',
            sessao,
            chatId,
            url: escolhido.url!,
            caption: escolhido.caption ?? undefined,
          });
          // Persiste estado: curso escolhido + mídia enviada
          await this.appendMemory(ctx, 'system', `[STATE:CURSO_ESCOLHIDO:${courseSlug}]`);
          await this.appendMemory(ctx, 'system', `[STATE:VIDEO_SENT:${escolhido.id}]`);
          // Observabilidade: registra envio de mídia do curso
          if (ctx.executionId) {
            await flowExecutionLog.logFlowEvent({
              executionId: ctx.executionId,
              flowId: ctx.flowId,
              flowName: ctx.flowName,
              bot: this.name,
              telefone: input.telefone,
              session: sessao,
              eventType: 'bot.media-sent',
              status: 'success',
              message: `Midia de curso enviada: ${courseSlug}`,
              metadata: {
                media_id: escolhido.id,
                course_slug: courseSlug,
                is_intro: escolhido.is_course_intro === true,
              },
            });
          }
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
        // Intro primeiro, depois secundários, apenas habilitados com URL
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

export { DEFAULT_PROMPT_TPL as TESTE_VENDAS_BARBEARIA_DEFAULT_PROMPT };
