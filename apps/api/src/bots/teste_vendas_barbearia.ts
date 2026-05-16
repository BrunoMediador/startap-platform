import type { BotContext } from '@startap/core/types';
import { botMedia, leads } from '@startap/db';
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
const COURSE_VIDEO_MARKER = '[SISTEMA:VIDEOS_CURSO_ENVIADOS]';

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
  '[SOBRE O CURSO]',
  'Duracao: 3 meses | 2x por semana',
  'Horarios: Manha 09h-11h | Tarde 15h-17h',
  'Inclui: Apostila completa, fardamento e suporte no grupo de WhatsApp',
  'Diploma valido em mais de 122 paises - trabalha em qualquer lugar do Brasil',
  'Investimento: Entrada de R$200 + 3x de R$200',
  'Curso pratico, do zero ao profissional',
  '',
  '[VIDEOS DO CURSO - REGRA IMPORTANTE]',
  '- SEMPRE que o cliente perguntar sobre o curso pela primeira vez (preco, duracao, como funciona, certificado, conteudo, qualquer duvida sobre o curso), termine sua resposta com [V1] para enviar os videos automaticamente.',
  '- Tambem use [V1] quando o cliente disser que tem interesse, quer saber mais, ou quer ver como e.',
  '- Depois que o sistema registrar que os videos ja foram enviados, NUNCA use [V1] para duvidas normais.',
  '- Se o cliente pedir explicitamente para mandar/ver os videos de novo, termine a resposta com [V1].',
  '- NUNCA mencione a tag [V1] para o cliente.',
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

function parseVideoTag(text: string): { tag: 'V1' | null; clean: string } {
  const m = text.match(/\[(V1)\]\s*$/i);
  if (!m) return { tag: null, clean: text.trim() };
  return { tag: 'V1', clean: text.slice(0, m.index).trim() };
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

function isExplicitVideoRequest(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /\b(video|videos|v[íi]deo|v[íi]deos|material|materiais)\b/.test(lower) &&
    /\b(manda|mandar|envia|enviar|reenviar|ver|assistir|mostra|mostrar|receber|passa|passar)\b/.test(
      lower,
    )
  );
}

function isClearCourseIntent(text: string): boolean {
  const lower = text.toLowerCase();
  const course =
    /\b(curso|barbeiro profissional|aprender|diploma|matricula|matr[íi]cula|inscri[cç][aã]o|inscrever|aula|apostila|fardamento)\b/.test(
      lower,
    );
  const barbershop =
    /\b(corte|barba|sobrancelha|pezinho|hor[aá]rio|agenda|agendar|marcar|cancelar|servi[cç]o)\b/.test(
      lower,
    );
  return course && !barbershop;
}

async function sendCourseVideos(input: { sessao: string; chatId: string }): Promise<void> {
  const { sessao, chatId } = input;
  const v1 = await botMedia.getByPosition(SLOT, 'V1');
  const v2 = await botMedia.getByPosition(SLOT, 'V2');
  const v3 = await botMedia.getByPosition(SLOT, 'V3');
  const pos = await botMedia.getByPosition(SLOT, 'POS_VIDEOS');
  for (const media of [v1, v2, v3]) {
    if (!media?.url) continue;
    await waha.sendMedia({
      type: 'video',
      sessao,
      chatId,
      url: media.url,
      caption: media.caption ?? undefined,
    });
  }
  if (pos?.caption) await waha.sendText({ sessao, chatId, texto: pos.caption, typing: false });
}

export class TesteVendasBarbeariaBot extends BotBase {
  constructor() {
    super({
      name: SLOT,
      projectId: SLOT,
      pauseTable: null,
      memoryTable: 'chat_histories_vendas_barbearia',
      memoryWindow: 12,
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
    const videosAlreadySent = history.some((turn) => turn.content.includes(COURSE_VIDEO_MARKER));
    const explicitVideoRequest = isExplicitVideoRequest(trimmed);

    const basePrompt = await renderPrompt({
      slot: SLOT,
      fallback: DEFAULT_PROMPT_TPL,
      vars: {
        nome: pushName || telefone,
        telefone,
        data_atual: dataAtual,
        ano: String(now.getFullYear()),
        agenda,
      },
    });
    const mediaContext = await botMedia.formatContextForPrompt(SLOT);
    const systemPrompt = mediaContext
      ? [
          basePrompt,
          '',
          '[CONTEXTO INTERNO DAS MIDIAS]',
          'Use este contexto apenas para decidir se uma tag de video faz sentido na conversa. Nao envie este texto ao cliente.',
          mediaContext,
        ].join('\n')
      : basePrompt;

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
      slot: SLOT,
      projectId: SLOT,
      flowId: ctx.flowId,
      telefone,
      systemPrompt,
      history,
      userMessage: trimmed,
      tools,
      maxTurns: 5,
    });

    const sanitized = sanitizarResposta(result.reply);
    const { tag, clean } = parseVideoTag(sanitized);
    const shouldSendVideos =
      explicitVideoRequest ||
      (tag === 'V1' && !videosAlreadySent) ||
      (!videosAlreadySent && isClearCourseIntent(trimmed));

    if (shouldSendVideos) {
      setTimeout(() => {
        sendCourseVideos({ sessao, chatId })
          .then(() => this.appendMemory(ctx, 'system', COURSE_VIDEO_MARKER))
          .catch((e) => this.log.error({ err: e, telefone }, 'Falha ao enviar videos do curso'));
      }, 2500);
    }

    return clean || sanitized;
  }
}

export { DEFAULT_PROMPT_TPL as TESTE_VENDAS_BARBEARIA_DEFAULT_PROMPT };
