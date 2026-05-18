import type { BotContext } from '@startap/core/types';
import { botCourses, botMedia, leads } from '@startap/db';
import { gcal, waha } from '@startap/integrations';
import type { ToolDefinition } from '@startap/integrations/openai';
import { renderPrompt } from '../lib/render-prompt.js';
import { runAgentConfigured } from '../lib/run-agent.js';
import { BotBase } from './base.js';

export const TESTE_VENDAS_BARBEARIA_WORKFLOW_ID = 'teste_vendas_barbearia';

const SLOT = 'teste_vendas_barbearia';
const TZ = 'America/Sao_Paulo';
const CALENDAR_ID = 'cirilosbarbershop01@gmail.com';
const ALERT_PHONE = '553591746797@c.us';
const ALERT_SESSION = 'startap';

// Marcadores que a IA emite no final da resposta (última linha).
// O parser extrai e remove antes de enviar ao cliente.
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

/** Lê o estado conversacional do histórico serializado. */
function parseConversationState(
  history: Array<{ role: string; content: string }>,
): ConversationState {
  let cursoEscolhido: string | null = null;
  const mediaIdsSentSet = new Set<number>();

  for (const turn of history) {
    // Estado é persistido como mensagem de sistema com prefixo conhecido
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

/** Formata preço de centavos para R$. */
function formatPrice(centavos: number): string {
  return `R$${(centavos / 100).toFixed(2).replace('.', ',')}`;
}

/** Formata lista de cursos disponíveis para injeção no prompt. */
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

/** Formata lista de mídias disponíveis para injeção no prompt. */
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

interface ServiceDef {
  name: string;
  min: number;
}

const SERVICES: ServiceDef[] = [
  { name: 'Corte', min: 40 },
  { name: 'Barba', min: 20 },
  { name: 'Sobrancelha', min: 20 },
  { name: 'Corte+Barba', min: 60 },
  { name: 'Pezinho', min: 20 },
  { name: 'Relaxamento', min: 40 },
  { name: 'Corte pigmentado', min: 60 },
];

const WORK: Record<number, [number, number]> = {
  1: [8 * 60, 19 * 60],
  2: [8 * 60, 19 * 60],
  3: [8 * 60, 19 * 60],
  4: [8 * 60, 19 * 60],
  5: [8 * 60, 19 * 60],
  6: [7 * 60, 17 * 60],
};

const DEFAULT_PROMPT_TPL = [
  'Voce e o atendente virtual da Startap Barbearia. Sua missao e encantar cada cliente.',
  'Voce atende dois assuntos no mesmo WhatsApp: vendas do Curso de Barbeiro Profissional e agendamento na barbearia.',
  '',
  '[TOM DE VOZ]',
  '- Seja simpatico, acolhedor e profissional. Trate o cliente pelo nome.',
  '- Use uma saudacao calorosa no primeiro contato (ex.: "Oi {nome}, tudo bem? Que bom falar com voce!").',
  '- Demonstre interesse genuino, agradeca o contato e seja prestativo do inicio ao fim.',
  '- Objetividade com gentileza: respostas em ate 3 linhas, uma pergunta por vez.',
  '- Pode usar emojis com moderacao (✂️ 💈 ✨ 😊) para deixar a conversa leve.',
  '',
  '[DATA ATUAL]',
  '{data_atual}',
  'ANO: {ano} - use SEMPRE este ano ao calcular datas.',
  '',
  '[DADOS DO CLIENTE - JA IDENTIFICADO]',
  'NOME: {nome}',
  'WHATSAPP: {telefone}',
  '',
  '[TRIAGEM DE INTENCAO]',
  '- Se o cliente falar de curso, formacao, preco do curso, matricula, inscricao, diploma ou aprender barbearia: atue como vendedor do curso.',
  '- Se o cliente falar de corte, barba, sobrancelha, horario, agenda, marcar, cancelar horario ou servico de barbearia: atue como atendente da barbearia.',
  '- Se estiver ambiguo, como "quanto custa?", pergunte gentilmente: "Posso te ajudar com o curso de barbeiro ou com um agendamento na barbearia?"',
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
  '1. [LISTA_CURSOS] — use quando o cliente pedir para ver os cursos, quiser saber quais sao, ou demonstrar interesse generico.',
  '   O sistema vai enviar a lista textual de cursos disponíveis logo apos sua mensagem.',
  '',
  '2. [CURSO:<course_slug>] — use quando o cliente escolher explicitamente UM curso especifico.',
  '   Substitua <course_slug> pelo slug do curso (ex.: [CURSO:curso-presencial-barbearia]).',
  '   O sistema envia o video de apresentacao do curso escolhido.',
  '   Exemplo: se o cliente diz "quero saber do presencial", emita [CURSO:curso-presencial-barbearia] no final.',
  '',
  '3. [VIDEO:<media_id>] — use quando o cliente fizer uma pergunta contextual e voce identificar uma midia relevante na biblioteca.',
  '   Substitua <media_id> pelo ID numerico da midia (ex.: [VIDEO:42]).',
  '   So use este marcador se o contexto da midia for semanticamente relacionado com a pergunta.',
  '   NUNCA emita [VIDEO:<id>] para uma midia que ja foi enviada nesta conversa (ver ESTADO DA CONVERSA abaixo).',
  '   Se o cliente pedir explicitamente para ver de novo, voce pode emitir o marcador conscientemente.',
  '',
  '4. [VIDEOS_CURSO] — use quando o cliente pedir para ver TODOS os videos do curso ("manda tudo", "envia todos os videos", "quero ver tudo").',
  '   O sistema envia todos os videos do curso atual em sequencia (intro primeiro).',
  '   So use se ja houver um CURSO ESCOLHIDO na conversa.',
  '',
  'REGRAS ABSOLUTAS DOS MARCADORES:',
  '- Nunca mencione os marcadores para o cliente.',
  '- Nunca emita [CURSO:<slug>] sem ter um curso escolhido explicitamente pelo cliente.',
  '- Nunca emita [VIDEO:<id>] se o id nao existir na biblioteca acima.',
  '- Se o cliente demonstrou interesse mas ainda nao escolheu um curso: use [LISTA_CURSOS] primeiro.',
  '',
  '[HORARIOS DISPONIVEIS - DADOS ATUALIZADOS AGORA]',
  '{agenda}',
  '',
  '[SERVICOS E PRECOS DA BARBEARIA]',
  'Corte de cabelo: R$35 (30 min)',
  'Barba: R$35 (30 min)',
  'Sobrancelha: R$15 (10 min)',
  'Pacote completo (Corte + Barba + Sobrancelha): R$60 (60 min)',
  'Alisamento: R$60 (40 min)',
  'Progressiva: R$100 (40 min)',
  'Luzes: R$80 (40 min)',
  'Platinado: R$120 (60 min)',
  '',
  '[FUNCIONAMENTO DA BARBEARIA]',
  'Terca a Sexta: 09h00 as 20h00',
  'Sabados e Feriados: 08h00 as 18h30',
  '(Fechado as segundas)',
  '',
  '[REGRAS ABSOLUTAS]',
  '1. PROIBIDO perguntar nome ou telefone. Voce ja tem esses dados acima.',
  '2. NUNCA invente informacoes sobre curso, precos, horarios ou agenda.',
  '3. Para curso: quando cliente quiser se inscrever, use salvar_lead.',
  '4. Para barbearia: os [HORARIOS DISPONIVEIS] sao a UNICA fonte de verdade.',
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
  '4. Apos o SIM, chame inserir_agendamento com Summary: "{nome} - [SERVICO] | WhatsApp: {telefone}".',
  '5. Somente apos confirmacao da ferramenta, responda com simpatia: "Prontinho, {nome}! Seu horario esta confirmado ✨ A Startap te espera!"',
].join('\n');

function spParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((a, p) => {
      a[p.type] = p.value;
      return a;
    }, {});
  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const wd = weekdayNames.indexOf(parts.weekday ?? '');
  return {
    wd,
    key: `${parts.year}-${parts.month}-${parts.day}`,
    label: `${parts.day}/${parts.month}`,
    mins: Number.parseInt(parts.hour ?? '0') * 60 + Number.parseInt(parts.minute ?? '0'),
  };
}

function hhmm(m: number) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function formatarAgenda(events: gcal.CalendarEvent[]): string {
  const now = new Date();
  const occupied: Record<string, Array<{ s: number; e: number }>> = {};
  for (const ev of events) {
    const s = new Date(ev.start.dateTime ?? `${ev.start.date}T00:00:00`);
    const e = new Date(ev.end.dateTime ?? `${ev.end.date}T00:00:00`);
    const sp = spParts(s);
    const sep = spParts(e);
    if (!occupied[sp.key]) occupied[sp.key] = [];
    occupied[sp.key].push({ s: sp.mins, e: sep.mins });
  }

  const dias = [
    'DOMINGO',
    'SEGUNDA-FEIRA',
    'TERCA-FEIRA',
    'QUARTA-FEIRA',
    'QUINTA-FEIRA',
    'SEXTA-FEIRA',
    'SABADO',
  ];
  const blocks: string[] = [];
  for (let offset = 0; offset <= 5; offset++) {
    const date = new Date(now);
    date.setDate(date.getDate() + offset);
    const sp = spParts(date);
    const wh = WORK[sp.wd];
    if (!wh) continue;

    const [wStart, wEnd] = wh;
    const minStart = offset === 0 ? Math.max(wStart, Math.ceil((sp.mins + 10) / 20) * 20) : wStart;
    const occ = occupied[sp.key] ?? [];
    const label =
      offset === 0
        ? `HOJE (${sp.label})`
        : offset === 1
          ? `AMANHA (${sp.label})`
          : `${dias[sp.wd]} (${sp.label})`;

    const lines = SERVICES.map((svc) => {
      const slots: string[] = [];
      for (let t = minStart; t + svc.min <= wEnd; t += 20) {
        if (!occ.some((o) => t < o.e && t + svc.min > o.s)) slots.push(hhmm(t));
      }
      return `  ${svc.name} (${svc.min}min): ${slots.length ? slots.join(', ') : 'SEM DISPONIBILIDADE'}`;
    });
    blocks.push(`${label}:\n${lines.join('\n')}`);
  }

  return blocks.join('\n\n') || 'Sem horarios disponiveis.';
}

function sanitizarResposta(text: string): string {
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

    if (trimmed === 'Cancelar') {
      const alerta = `O cliente ${pushName} quer cancelar um horario, entre em contato pelo numero: ${telefone}`;
      waha
        .sendText({ sessao: ALERT_SESSION, chatId: ALERT_PHONE, texto: alerta, typing: false })
        .catch((e) => this.log.warn(e, 'Falha ao enviar alerta de cancelamento'));
      return 'ok! vou avisar o time, e logo entraremos em contato!';
    }

    const now = new Date();
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString();
    const events = await gcal.listEvents({ timeMin, timeMax, calendarId: CALENDAR_ID });
    const agenda = formatarAgenda(events);
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

    // Carrega dados dinâmicos para o prompt
    const [courses, allMedia] = await Promise.all([
      botCourses.listCoursesBySlot(this.slot),
      botMedia.listBySlot(this.slot),
    ]);

    const estadoConversa = [
      `Curso escolhido: ${state.cursoEscolhido ?? 'nenhum ate agora'}`,
      `Midias ja enviadas nesta conversa: ${state.mediaIdsSentSet.size > 0 ? Array.from(state.mediaIdsSentSet).join(', ') : 'nenhuma'}`,
    ].join('\n');

    const basePrompt = await renderPrompt({
      slot: this.slot,
      fallback: DEFAULT_PROMPT_TPL,
      vars: {
        nome: pushName || telefone,
        telefone,
        data_atual: dataAtual,
        ano: String(now.getFullYear()),
        agenda,
        cursos_disponiveis: formatCoursesForPrompt(courses),
        midias_biblioteca: formatMediaForPrompt(allMedia),
        estado_conversa: estadoConversa,
      },
    });

    const tools: ToolDefinition[] = [
      {
        name: 'salvar_lead',
        description:
          'Salva o lead do cliente interessado no curso. Use quando o cliente demonstrar intencao de se inscrever.',
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
            summary: { type: 'string', description: 'Titulo: "Nome - Servico | WhatsApp: numero"' },
            start: { type: 'string', description: 'Inicio ISO 8601 com timezone' },
            end: { type: 'string', description: 'Fim ISO 8601 com timezone' },
          },
          required: ['summary', 'start', 'end'],
        },
        run: async (args: unknown) => {
          const { summary, start, end } = args as { summary: string; start: string; end: string };
          const ev = await gcal.createEvent({
            summary,
            startISO: start,
            endISO: end,
            timeZone: TZ,
            calendarId: CALENDAR_ID,
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
            telefone: { type: 'string', description: 'WhatsApp do cliente (so digitos)' },
          },
          required: ['telefone'],
        },
        run: async (args: unknown) => {
          const { telefone: tel } = args as { telefone: string };
          const tMin = new Date().toISOString();
          const tMax = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
          const evs = await gcal.listEvents({
            timeMin: tMin,
            timeMax: tMax,
            calendarId: CALENDAR_ID,
          });
          const phone = tel.replace(/\D/g, '');
          const matching = evs.filter(
            (e) => e.summary?.includes(phone) || e.description?.includes(phone),
          );
          if (!matching.length)
            return { events: [], message: 'Nenhum agendamento futuro encontrado.' };
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

    const sanitized = sanitizarResposta(result.reply);
    const { type, courseSlug, mediaId, clean } = parseMarker(sanitized);
    const replyText = clean || sanitized;

    // Processa marcadores após enviar a resposta de texto
    if (type !== null) {
      const effectiveSlot = this.slot;
      setTimeout(() => {
        this.handleMarker({
          type,
          courseSlug,
          mediaId,
          sessao,
          chatId,
          effectiveSlot,
          state,
          ctx,
          telefone,
        }).catch((e) =>
          this.log.error({ err: e, type, telefone }, 'Falha ao processar marcador do bot'),
        );
      }, 2500);
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

        // Busca o vídeo intro do curso
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
          // Persiste estado: curso escolhido + mídia enviada
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
