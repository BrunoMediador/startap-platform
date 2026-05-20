import type { BotContext } from '@startap/core/types';
import { gcal, waha } from '@startap/integrations';
import type { ToolDefinition } from '@startap/integrations/openai';
import { formatarAgendaComConfig, loadScheduleConfig } from '../lib/free-slots.js';
import { renderPrompt } from '../lib/render-prompt.js';
import { runAgentConfigured } from '../lib/run-agent.js';
import { BotBase } from './base.js';

const SLOT = 'teste_barbearia';
const TZ = 'America/Sao_Paulo';
const ALERT_PHONE = '553591746797@c.us';
const ALERT_SESSION = 'startap';

const DEFAULT_PROMPT_TPL = [
  'Voce e o assistente virtual da Barbearia Startap.',
  'Atenda pelo WhatsApp com simpatia e objetividade. Maximo 3 linhas por resposta.',
  '',
  '[DATA ATUAL]',
  '{data_atual}',
  'ANO: {ano} - use SEMPRE este ano ao calcular datas.',
  '',
  '[DADOS DO CLIENTE - JA IDENTIFICADO]',
  'NOME: {nome}',
  'WHATSAPP: {telefone}',
  '',
  '[HORARIOS DISPONIVEIS - DADOS ATUALIZADOS AGORA]',
  '{agenda}',
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
  '[REGRAS CRITICAS - VIOLACAO = ERRO GRAVE]',
  '1. PROIBIDO perguntar nome ou telefone. Voce ja tem esses dados acima.',
  '2. Os [HORARIOS DISPONIVEIS] acima sao a UNICA fonte de verdade sobre disponibilidade.',
  '3. Ao verificar disponibilidade: localize EXATAMENTE a linha do servico solicitado.',
  '4. Se o horario nao aparecer na linha correta -> INDISPONIVEL.',
  '5. Para gravar, DEVE chamar inserir_agendamento. NUNCA confirme sem chamar a ferramenta.',
  '',
  '[FLUXO OBRIGATORIO]',
  '1. Identifique o servico e o horario que o cliente quer.',
  '2. Localize a linha do servico em [HORARIOS DISPONIVEIS].',
  '3. Se nao estiver -> diga que esta ocupado e sugira o mais proximo da mesma linha.',
  '4. Se estiver -> apresente o CARTAO DE CONFIRMACAO e peca SIM.',
  '5. APOS o SIM: chame inserir_agendamento com Summary: "{nome} - [SERVICO]".',
  '6. Somente apos confirmacao da ferramenta: "Feito! Ta na agenda, a Startap te espera!"',
  '',
  '[CARTAO DE CONFIRMACAO]',
  'DIA / HORARIO / SERVICO / VALOR e pede SIM.',
].join('\n');

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

export class TesteBarbeariaBot extends BotBase {
  constructor(opts?: { slotOverride?: string }) {
    super({
      name: opts?.slotOverride ?? SLOT,
      projectId: SLOT,
      pauseTable: null, // migration 008 migrou pausa_cirilo → flow_pauses; legado removido
      memoryTable: 'chat_histories',
      memoryWindow: 10,
      slotOverride: opts?.slotOverride,
    });
  }

  protected async process(ctx: BotContext): Promise<string | null> {
    const { telefone, texto, pushName } = ctx.message;
    if (!texto.trim()) return null;

    // Cancelamento
    if (texto.trim() === 'Cancelar') {
      const alerta = `O cliente ${pushName} quer cancelar um horario, entre em contato pelo numero: ${telefone}`;
      waha
        .sendText({ sessao: ALERT_SESSION, chatId: ALERT_PHONE, texto: alerta, typing: false })
        .catch((e) => this.log.warn(e, 'Falha ao enviar alerta de cancelamento'));
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

    // Buscar agenda
    const now = new Date();
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString();
    const [events, scheduleConfig] = await Promise.all([
      calClient.listEvents({ timeMin, timeMax }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (/40[13]/.test(msg)) gcal.invalidateGcalCache(this.slot);
        throw err;
      }),
      loadScheduleConfig(this.slot),
    ]);
    if (scheduleConfig.source === 'defaults' && this.slot !== SLOT) {
      this.log.warn(
        { slot: this.slot },
        'free-slots: clone sem horarios/servicos configurados — usando defaults do bot base',
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

    const systemPrompt = await renderPrompt({
      slot: this.slot,
      fallback: DEFAULT_PROMPT_TPL,
      vars: {
        nome: pushName || telefone,
        telefone,
        data_atual: dataAtual,
        ano: String(now.getFullYear()),
        agenda,
      },
    });

    const fullHistory = await this.loadHistory(ctx);
    const history = fullHistory.slice(0, -1);

    const tools: ToolDefinition[] = [
      {
        name: 'inserir_agendamento',
        description:
          'Insere um agendamento no Google Calendar. Use APENAS apos o cliente confirmar com SIM. ' +
          'Summary: "[Nome] - [Servico] | WhatsApp: [numero]"',
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

          // Validação server-side: impede criação de evento com overlap real no Calendar.
          // O LLM pode alucinar disponibilidade — esta verificação é a fonte de verdade.
          const existing = await calClient.listEvents({ timeMin: start, timeMax: end });
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
              'inserir_agendamento bloqueado: conflito detectado server-side',
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
          const evs = await calClient.listEvents({ timeMin: tMin, timeMax: tMax });
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
      systemPrompt,
      history,
      userMessage: texto,
      tools,
      maxTurns: 5,
    });

    return sanitizarResposta(result.reply);
  }
}

export { DEFAULT_PROMPT_TPL as TESTE_BARBEARIA_DEFAULT_PROMPT };
