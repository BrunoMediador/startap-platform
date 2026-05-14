import type { BotContext } from '@startap/core/types';
import { gcal, openai, waha } from '@startap/integrations';
import type { ToolDefinition } from '@startap/integrations/openai';
import { BotBase } from './base.js';

const TZ = 'America/Sao_Paulo';
const CALENDAR_ID = 'cirilosbarbershop01@gmail.com';
const ALERT_PHONE = '553591746797@c.us';
const ALERT_SESSION = 'startap';

interface ServiceDef { name: string; min: number }
const SERVICES: ServiceDef[] = [
  { name: 'Corte',            min: 40 },
  { name: 'Barba',            min: 20 },
  { name: 'Sobrancelha',      min: 20 },
  { name: 'Corte+Barba',      min: 60 },
  { name: 'Pezinho',          min: 20 },
  { name: 'Relaxamento',      min: 40 },
  { name: 'Corte pigmentado', min: 60 },
];

// 1=Seg … 5=Sex, 6=Sab (0=Dom fechado)
const WORK: Record<number, [number, number]> = {
  1: [8 * 60, 19 * 60], 2: [8 * 60, 19 * 60], 3: [8 * 60, 19 * 60],
  4: [8 * 60, 19 * 60], 5: [8 * 60, 19 * 60], 6: [7 * 60, 17 * 60],
};

function spParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
    hour12: false,
  }).formatToParts(date).reduce<Record<string, string>>((a, p) => { a[p.type] = p.value; return a; }, {});
  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const wd = weekdayNames.indexOf(parts.weekday ?? '');
  return {
    wd,
    key: `${parts.year}-${parts.month}-${parts.day}`,
    label: `${parts.day}/${parts.month}`,
    mins: parseInt(parts.hour ?? '0') * 60 + parseInt(parts.minute ?? '0'),
  };
}

function hhmm(m: number) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function formatarAgenda(events: gcal.CalendarEvent[]): string {
  const now = new Date();

  const occupied: Record<string, Array<{ s: number; e: number }>> = {};
  for (const ev of events) {
    const s = new Date(ev.start.dateTime ?? ev.start.date + 'T00:00:00');
    const e = new Date(ev.end.dateTime ?? ev.end.date + 'T00:00:00');
    const sp = spParts(s);
    const sep = spParts(e);
    if (!occupied[sp.key]) occupied[sp.key] = [];
    occupied[sp.key].push({ s: sp.mins, e: sep.mins });
  }

  const DIAS = ['DOMINGO', 'SEGUNDA-FEIRA', 'TERCA-FEIRA', 'QUARTA-FEIRA', 'QUINTA-FEIRA', 'SEXTA-FEIRA', 'SABADO'];
  const blocks: string[] = [];

  for (let offset = 0; offset <= 5; offset++) {
    const date = new Date(now);
    date.setDate(date.getDate() + offset);
    const sp = spParts(date);
    const wh = WORK[sp.wd];
    if (!wh) continue; // Domingo fechado

    const [wStart, wEnd] = wh;
    let minStart = wStart;
    if (offset === 0) {
      minStart = Math.max(wStart, Math.ceil((sp.mins + 10) / 20) * 20);
    }

    const occ = occupied[sp.key] ?? [];
    let label: string;
    if (offset === 0) label = `HOJE (${sp.label})`;
    else if (offset === 1) label = `AMANHA (${sp.label})`;
    else label = `${DIAS[sp.wd]} (${sp.label})`;

    const lines: string[] = [];
    for (const svc of SERVICES) {
      const slots: string[] = [];
      for (let t = minStart; t + svc.min <= wEnd; t += 20) {
        if (!occ.some(o => t < o.e && (t + svc.min) > o.s)) slots.push(hhmm(t));
      }
      lines.push(`  ${svc.name} (${svc.min}min): ${slots.length ? slots.join(', ') : 'SEM DISPONIBILIDADE'}`);
    }
    blocks.push(`${label}:\n${lines.join('\n')}`);
  }

  return blocks.join('\n\n') || 'Sem horarios disponiveis.';
}

function buildSystemPrompt(nomeCliente: string, telefone: string, agenda: string): string {
  const now = new Date();
  const dataAtual = now.toLocaleDateString('pt-BR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: TZ,
  });
  const ano = now.getFullYear();

  return [
    'Voce e o assistente virtual da Barbearia Startap.',
    'Atenda pelo WhatsApp com simpatia e objetividade. Maximo 3 linhas por resposta.',
    '',
    '[DATA ATUAL]',
    dataAtual,
    `ANO: ${ano} - use SEMPRE este ano ao calcular datas.`,
    '',
    '[DADOS DO CLIENTE - JA IDENTIFICADO]',
    `NOME: ${nomeCliente}`,
    `WHATSAPP: ${telefone}`,
    '',
    '[HORARIOS DISPONIVEIS - DADOS ATUALIZADOS AGORA]',
    agenda,
    '',
    '[SERVICOS E PRECOS]',
    'Corte de cabelo: R$35 (30 min)',
    'Barba: R$35 (30 min)',
    'Sobrancelha: R$15 (10 min)',
    'Pacote completo (Corte + Barba + Sobrancelha): R$60 (60 min)',
    'Alisamento: R$60 (40 min)',
    'Progressiva: R$100 (40 min)',
    'Luzes: R$80 (40 min)',
    'Platinado: R$120 (60 min)',
    '',
    '[FUNCIONAMENTO]',
    'Terca a Sexta: 09h00 as 20h00',
    'Sabados e Feriados: 08h00 as 18h30',
    '(Fechado as segundas)',
    '',
    '[ENDERECO]',
    'Rua Jhon Lennon, no 201, America 2, Vila Sesamo - CEP 89221-040',
    '',
    '[REGRAS CRITICAS - VIOLACAO = ERRO GRAVE]',
    '1. PROIBIDO perguntar nome ou telefone. Voce ja tem esses dados acima.',
    '2. Os [HORARIOS DISPONIVEIS] acima sao a UNICA fonte de verdade sobre disponibilidade. Ignore qualquer informacao do historico da conversa sobre horarios - ela pode estar desatualizada. Confie SEMPRE nos dados acima.',
    '3. Ao verificar disponibilidade: localize EXATAMENTE a linha do servico solicitado e verifique se o horario pedido aparece NESSA linha. Um horario disponivel para Barba NAO significa que esta disponivel para Corte.',
    '4. Se o horario nao aparecer na linha correta -> INDISPONIVEL. Informe e sugira o horario mais proximo DA MESMA LINHA.',
    '5. Para gravar, DEVE chamar inserir_agendamento. NUNCA confirme sem chamar a ferramenta.',
    '',
    '[FLUXO OBRIGATORIO]',
    '1. Identifique o servico e o horario que o cliente quer.',
    '2. Localize a linha do servico em [HORARIOS DISPONIVEIS]. Verifique se o horario pedido esta NESSA linha.',
    '3. Se nao estiver -> diga que esta ocupado e sugira o mais proximo da mesma linha.',
    '4. Se estiver -> apresente o CARTAO DE CONFIRMACAO e peca SIM.',
    `5. APOS o SIM: chame inserir_agendamento com Summary: "${nomeCliente} - [SERVICO]".`,
    '6. Somente apos confirmacao da ferramenta: "Feito! Ta na agenda, a Startap te espera!"',
    '7. Se o cliente falar de outro assunto ou cancelamento, acione o fluxo_De_Alertas.',
    '',
    '[CONSULTAR AGENDAMENTOS]',
    'Se o cliente perguntar sobre agendamentos futuros ou quiser confirmar um existente, chame consultar_agendamento.',
    '- A busca usa o WhatsApp do cliente ja identificado - NUNCA peca o numero.',
    '- Se retornar eventos: informe os proximos agendamentos com data, hora e servico.',
    '- Se nao retornar eventos: informe que nao ha agendamento futuro registrado.',
    '',
    '[MODELO CARTAO DE CONFIRMACAO]',
    'CARTAO DE CONFIRMACAO',
    '----------------------',
    'DIA:',
    'HORARIO:',
    'SERVICO:',
    'VALOR:',
    '----------------------',
    'Responda SIM para confirmar.',
  ].join('\n');
}

function sanitizarResposta(text: string): string {
  return text
    .split('\n')
    .filter(l => {
      const t = l.trim();
      if (t === '') return true;
      if (/^to=functions\./i.test(t)) return false;
      if (/^\{.*\}$/.test(t)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

export class BarbeariaCiriloBot extends BotBase {
  constructor() {
    super({
      name: 'barbearia-cirilo',
      pauseTable: 'pausa_cirilo',
      memoryTable: 'n8n_chat_histories',
      memoryWindow: 10,
    });
  }

  protected async process(ctx: BotContext): Promise<string | null> {
    const { telefone, texto, pushName } = ctx.message;

    if (!texto.trim()) return null;

    // Cancelamento explícito
    if (texto.trim() === 'Cancelar') {
      const alerta = `O cliente ${pushName} quer cancelar um horario, entre em contato pelo numero: ${telefone}`;
      waha
        .sendText({ sessao: ALERT_SESSION, chatId: ALERT_PHONE, texto: alerta, typing: false })
        .catch(e => this.log.warn(e, 'Falha ao enviar alerta de cancelamento'));
      return 'ok! vou avisar o Cirilo, e logo ele entrara em contato!';
    }

    // Busca agenda (hoje + 5 dias)
    const now = new Date();
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString();
    const events = await gcal.listEvents({ timeMin, timeMax, calendarId: CALENDAR_ID });

    const agenda = formatarAgenda(events);
    const systemPrompt = buildSystemPrompt(pushName || telefone, telefone, agenda);

    // BotBase.handle() já fez appendMemory antes de chamar process(); remove o último item (msg atual)
    const fullHistory = await this.loadHistory(telefone);
    const history = fullHistory.slice(0, -1);

    const tools: ToolDefinition[] = [
      {
        name: 'inserir_agendamento',
        description:
          "Insere um agendamento no Google Calendar da CIRILO's BARBERSHOP. " +
          'Use APENAS apos o cliente confirmar com SIM. ' +
          'Summary: "[Nome] - [Servico] | WhatsApp: [numero]"',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'Titulo: "Nome - Servico | WhatsApp: numero"' },
            start:   { type: 'string', description: 'Inicio ISO 8601 com timezone' },
            end:     { type: 'string', description: 'Fim ISO 8601 com timezone' },
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
          this.log.info({ eventId: ev.id, summary: ev.summary, telefone }, 'Agendamento criado');
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
          const evs = await gcal.listEvents({ timeMin: tMin, timeMax: tMax, calendarId: CALENDAR_ID });
          const phone = tel.replace(/\D/g, '');
          const matching = evs.filter(
            e => e.summary?.includes(phone) || e.description?.includes(phone),
          );
          if (!matching.length) return { events: [], message: 'Nenhum agendamento futuro encontrado.' };
          return {
            events: matching.map(e => ({
              summary: e.summary,
              start: e.start.dateTime,
              end: e.end.dateTime,
            })),
          };
        },
      },
    ];

    const result = await openai.runAgent({
      systemPrompt,
      history,
      userMessage: texto,
      tools,
      temperature: 0.3,
      maxTurns: 5,
    });

    return sanitizarResposta(result.reply);
  }
}
