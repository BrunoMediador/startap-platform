import type { BotContext } from '@startap/core/types';
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

const SLOT = 'teste_barbearia';
const TZ = 'America/Sao_Paulo';
const ALERT_PHONE = '553591746797@c.us';
const ALERT_SESSION = 'startap';

/**
 * SEED inicial — em runtime o prompt vem só do banco (bot_prompt).
 * Este template é referência para popular o banco em setup inicial; não é usado em execução.
 * Apenas persona + regras + fluxo + cartao. Dados do negocio, horarios,
 * servicos, cliente e agenda sao injetados pelo worker via buildContextBlock.
 */
const DEFAULT_PROMPT_TPL = [
  'Voce e o assistente virtual de uma barbearia.',
  'Atenda pelo WhatsApp com simpatia e objetividade. Maximo 3 linhas por resposta.',
  '',
  '[REGRAS CRITICAS - VIOLACAO = ERRO GRAVE]',
  '1. PROIBIDO perguntar nome ou telefone. O contexto abaixo ja tem esses dados.',
  '2. Os [HORARIOS DISPONIVEIS] no contexto sao a UNICA fonte de verdade sobre disponibilidade.',
  '3. Ao verificar disponibilidade: localize EXATAMENTE a linha do servico solicitado.',
  '4. Se o horario nao aparecer na linha correta -> INDISPONIVEL.',
  '5. Para gravar, DEVE chamar inserir_agendamento. NUNCA confirme sem chamar a ferramenta.',
  '6. NUNCA ofereca servicos que nao estao em [SERVICOS E PRECOS].',
  '',
  '[FLUXO OBRIGATORIO]',
  '1. Identifique o servico e o horario que o cliente quer.',
  '2. Localize a linha do servico em [HORARIOS DISPONIVEIS].',
  '3. Se nao estiver -> diga que esta ocupado e sugira o mais proximo da mesma linha.',
  '4. Se estiver -> apresente o CARTAO DE CONFIRMACAO e peca SIM.',
  '5. APOS o SIM: chame inserir_agendamento com Summary: "[Nome do cliente] - [Servico]".',
  '6. Somente apos confirmacao da ferramenta: "Feito! Ta na agenda, te espera!"',
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

    let scheduleConfig: import('../lib/free-slots.js').ScheduleConfig;
    try {
      scheduleConfig = await loadScheduleConfig(this.slot);
    } catch (err) {
      this.log.error(
        { err: err instanceof Error ? err.message : String(err), slot: this.slot, telefone },
        'free-slots: configuração ausente — bot não responde para evitar dados fictícios',
      );
      return null;
    }

    const events = await calClient.listEvents({ timeMin, timeMax }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (/40[13]/.test(msg)) gcal.invalidateGcalCache(this.slot);
      throw err;
    });

    // Log explicito do source — facilita debug quando bot oferecer durações
    // estranhas ("por que Barba 20min se cadastrei 30?"). source possiveis:
    //   flow_clones: leu do clone (ok)
    //   bot_config:  leu da matriz (ok, clone sem config preenchida)
    this.log.info(
      {
        slot: this.slot,
        scheduleSource: scheduleConfig.source,
        servicosCount: scheduleConfig.services.length,
        servicosNomes: scheduleConfig.services.map((s) => `${s.name}/${s.min}min`),
      },
      'free-slots: schedule carregado',
    );
    const agenda = formatarAgendaComConfig(events, scheduleConfig);

    const dataAtual = now.toLocaleDateString('pt-BR', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: TZ,
    });

    // O bot_prompt no banco contém SOMENTE persona+regras+fluxo+cartão (parte
    // editável pelo usuário do painel). Renderiza sem vars dinâmicas —
    // vars dinâmicas vão no bloco de contexto separado abaixo.
    let promptPersona: string;
    try {
      promptPersona = await renderPrompt({ slot: this.slot, vars: {} });
    } catch (err) {
      this.log.error({ err, slot: this.slot, telefone }, 'renderPrompt falhou — bot nao responde');
      return null;
    }

    // Bloco de CONTEXTO: dados do banco (negocio, horarios, servicos, cliente,
    // agenda) montados em runtime e concatenados ao prompt. NAO editavel pelo
    // usuario do painel — protege contra remocao acidental (Bruno 2026-05-20).
    const contextBlock = await buildContextBlock({
      slot: this.slot,
      nomeCliente: pushName || telefone,
      telefoneCliente: telefone,
      dataAtual,
      ano: String(now.getFullYear()),
      agendaFormatada: agenda,
    });

    const systemPrompt = `${promptPersona}\n\n${contextBlock}`;

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
