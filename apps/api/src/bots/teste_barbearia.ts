import type { BotContext } from '@startap/core/types';
import { cloneColaboradores } from '@startap/db';
import { gcal } from '@startap/integrations';
import type { ToolDefinition } from '@startap/integrations/openai';
import {
  type ColaboradorAgenda,
  buildContextBlock,
  buildEstabelecimentoContext,
  formatarAgendaComConfig,
  loadScheduleConfig,
  resolveColaboradorByShortId,
} from '@startap/integrations/scheduling';
import { config } from '../config.js';
import { gcalActionLockKey, withActionLock } from '../lib/action-lock.js';
import { sendClientCancellationAlert } from '../lib/client-alert.js';
import { renderPrompt } from '../lib/render-prompt.js';
import { runAgentConfigured } from '../lib/run-agent.js';
import { BotBase } from './base.js';

const SLOT = 'teste_barbearia';
const TZ = 'America/Sao_Paulo';

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

    // Cancelamento — caminho rápido determinístico (botão literal 'Cancelar').
    // Missão 023 W5: o bot NUNCA cancela (não há tool de delete no GCal). Ele ESCALA
    // pro dono do clone — mas SÓ com a flag CANCELAMENTO_ESCALADO_ENABLED=true (default OFF).
    // Flag OFF -> comportamento ATUAL idêntico (responde "vou avisar o time", sem enviar).
    if (texto.trim() === 'Cancelar') {
      if (config.CANCELAMENTO_ESCALADO_ENABLED) {
        // Fire-and-forget: o resultado do alerta NUNCA bloqueia nem quebra a resposta.
        void sendClientCancellationAlert({
          slot: this.slot,
          clienteTelefone: telefone,
          motivo: '',
          referenciaHorario: '',
        });
      }
      this.log.info(
        { slot: this.slot, telefone, pushName, escalado: config.CANCELAMENTO_ESCALADO_ENABLED },
        'cancelamento detectado (botão literal) — bot NÃO cancela; escala pro dono se flag ON',
      );
      return 'ok! vou avisar o time, e logo entraremos em contato!';
    }

    // ── Estabelecimento multi-colaborador (ADR 0023/0024, Fase A — DORMENTE) ──────
    // GATE DUPLO: SÓ entra no caminho novo se a flag ESTABELECIMENTO_ENABLED está ON
    // **E** o slot é product_type='estabelecimento'. Qualquer um dos dois falso ->
    // o código abaixo (individual) roda BYTE-A-BYTE como hoje. Cirilo/Samuel são
    // individual -> getProductType devolve 'individual' (fallback seguro até em erro)
    // -> nunca alcançam processEstabelecimento, independente da flag.
    if (config.ESTABELECIMENTO_ENABLED) {
      const productType = await cloneColaboradores.getProductType(this.slot);
      if (productType === 'estabelecimento') {
        return this.processEstabelecimento(ctx);
      }
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

    let scheduleConfig: import('@startap/integrations/scheduling').ScheduleConfig;
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

          const createEvent = () =>
            calClient.createEvent({
              summary,
              startISO: start,
              endISO: end,
              timeZone: TZ,
            });

          // ── Action-lock (ADR 0019, passo 3) ──────────────────────────────
          // Flag OFF (default) -> cria o evento direto, IGUAL a hoje.
          if (!config.IDEMPOTENCY_ACTION_LOCK) {
            const ev = await createEvent();
            this.log.info({ eventId: ev.id, summary: ev.summary, telefone }, 'Agendamento criado');
            return { ok: true, eventId: ev.id, summary: ev.summary };
          }

          // Flag ON -> envolve a criacao do evento com lock distribuido por
          // (slot, telefone, inicio). Quem adquire cria; quem nao adquire
          // entende que a acao ja foi feita por outro processamento e PULA.
          // Fail-open: Redis down -> cria mesmo assim (degraded=true).
          const lockKey = gcalActionLockKey(this.slot, telefone, start);
          const lock = await withActionLock(lockKey, createEvent);
          if (!lock.executed) {
            // Acao ja em andamento/feita por outro processamento da mesma
            // mensagem -> NAO cria 2º evento. Devolve sucesso pro agente para
            // a conversa nao virar erro nem nova tentativa.
            this.log.info(
              { lockKey, telefone },
              'inserir_agendamento pulado: acao ja em andamento (action-lock)',
            );
            return { ok: true, skipped: true };
          }
          const ev = lock.value as Awaited<ReturnType<typeof createEvent>>;
          this.log.info(
            { eventId: ev.id, summary: ev.summary, telefone, degraded: lock.degraded },
            'Agendamento criado',
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

    // ── Cancelamento escalado (Missão 023 W5 — DORMENTE por flag) ────────────────
    // A tool SÓ é exposta ao modelo quando a flag está ON. Com a flag OFF a lista de
    // tools é IDÊNTICA à de hoje (só inserir/consultar) — bot 100% inalterado.
    // A tool NÃO toca o GCal: nenhuma chamada de delete/createEvent. Apenas escala o
    // pedido pro dono do clone (fire-and-forget) e responde {ok, escalado} pro modelo.
    if (config.CANCELAMENTO_ESCALADO_ENABLED) {
      tools.push({
        name: 'escalar_cancelamento',
        description:
          'Use SOMENTE quando o cliente pedir explicitamente para CANCELAR/DESMARCAR um ' +
          'horario ja agendado e NAO quiser remarcar. NAO use para: remarcar/trocar de ' +
          'horario (isso e novo agendamento via inserir_agendamento), confirmar presenca, ' +
          'perguntar sobre horarios, ou desistir de algo que ainda nao foi agendado. ' +
          'Esta ferramenta NAO remove nada da agenda — ela apenas avisa o responsavel, ' +
          'que entra em contato com o cliente.',
        parameters: {
          type: 'object',
          properties: {
            motivo: {
              type: 'string',
              description: 'Motivo do cancelamento, se o cliente informou. Vazio se nao disse.',
            },
            referencia_horario: {
              type: 'string',
              description:
                'Dia/horario que o cliente mencionou querer cancelar, como ele falou. ' +
                'Vazio se nao especificou.',
            },
          },
          required: [],
        },
        run: async (args: unknown): Promise<{ ok: boolean; escalado: boolean }> => {
          const a = (args ?? {}) as { motivo?: unknown; referencia_horario?: unknown };
          const motivo = typeof a.motivo === 'string' ? a.motivo : '';
          const referenciaHorario =
            typeof a.referencia_horario === 'string' ? a.referencia_horario : '';
          // NUNCA toca o GCal aqui. Fire-and-forget: o resultado do envio nunca derruba
          // o atendimento (sendClientCancellationAlert captura toda falha internamente).
          const r = await sendClientCancellationAlert({
            slot: this.slot,
            clienteTelefone: telefone,
            motivo,
            referenciaHorario,
          });
          // Pro modelo: sempre {ok:true, escalado:bool} — assim a IA fecha a resposta
          // ("ja avisei o responsavel") sem nunca afirmar que cancelou de fato.
          return { ok: true, escalado: r.escalado };
        },
      });
    }

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

  /**
   * Caminho ESTABELECIMENTO (ADR 0023/0024, Fase A — MVP). Só é alcançado quando
   * ESTABELECIMENTO_ENABLED=ON E product_type='estabelecimento' (gate feito em process).
   *
   * Diferenças do individual:
   *  - resolve N agendas (1 por colaborador) via gcal.getGcalsForSlot (resolvedor com
   *    isolamento por slot+tenant_id, ADR 0024 §4) — NUNCA usa a agenda principal do clone;
   *  - {agenda} vira blocos [PROFISSIONAIS] + [HORARIOS] rotulados por colaborador,
   *    com a ocupação de TODOS lida numa única chamada freebusy.query batched (ADR 0024 §5);
   *  - inserir_agendamento exige colaborador_id (id curto C1/C2…); o servidor resolve o
   *    calendarId server-side validando contra a lista ATIVA daquele slot/tenant — o LLM
   *    nunca recebe nem passa calendarId/e-mail de agenda.
   *
   * MVP: o bot SEMPRE pergunta o profissional (sem "qualquer profissional"/pooled — Fase B).
   */
  private async processEstabelecimento(ctx: BotContext): Promise<string | null> {
    const { telefone, texto, pushName } = ctx.message;

    // Resolve os colaboradores ATIVOS (com agenda 'active' + calendarId) do slot.
    // O resolvedor já filtra ativo/gcal active no banco e isola por slot+tenant.
    const colaboradores = await gcal.getGcalsForSlot(this.slot);
    if (colaboradores.length === 0) {
      // Estabelecimento sem nenhum colaborador agendável (nenhum cadastrado ou todos
      // com agenda pending/invalid). NÃO cai pro caminho individual (vazaria a agenda
      // principal do clone) e NÃO inventa disponibilidade — silencia, igual ao
      // individual quando a config está ausente.
      this.log.error(
        { slot: this.slot, telefone },
        'estabelecimento: nenhum colaborador agendável — bot não responde (sem fallback p/ agenda do clone)',
      );
      return null;
    }

    // Config de agenda (horários + serviços globais do clone) — mesma fonte do individual.
    let scheduleConfig: import('@startap/integrations/scheduling').ScheduleConfig;
    try {
      scheduleConfig = await loadScheduleConfig(this.slot);
    } catch (err) {
      this.log.error(
        { err: err instanceof Error ? err.message : String(err), slot: this.slot, telefone },
        'estabelecimento: configuração de horários/serviços ausente — bot não responde',
      );
      return null;
    }

    const now = new Date();
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString();

    // Monta [PROFISSIONAIS] + [HORARIOS por colaborador] com 1 chamada freebusy batched.
    // `decorados` carrega o shortId (C1, C2…) + client + calendarId server-side — é a
    // MESMA lista usada para resolver o colaborador_id no inserir_agendamento (sem
    // reconstruir a numeração).
    let estab: import('@startap/integrations/scheduling').EstabelecimentoContext;
    try {
      estab = await buildEstabelecimentoContext(colaboradores, scheduleConfig, {
        timeMin,
        timeMax,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/40[13]/.test(msg)) gcal.invalidateGcalsForSlot(this.slot);
      this.log.error(
        { err: msg, slot: this.slot, telefone },
        'estabelecimento: freebusy falhou — bot não responde (não inventa disponibilidade)',
      );
      return null;
    }

    const decorados: ColaboradorAgenda[] = estab.colaboradores;

    this.log.info(
      {
        slot: this.slot,
        scheduleSource: scheduleConfig.source,
        colaboradoresCount: decorados.length,
        colaboradores: decorados.map((c) => `${c.shortId}/${c.colaboradorId}`),
      },
      'estabelecimento: contexto montado (agenda por colaborador)',
    );

    const dataAtual = now.toLocaleDateString('pt-BR', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: TZ,
    });

    let promptPersona: string;
    try {
      promptPersona = await renderPrompt({ slot: this.slot, vars: {} });
    } catch (err) {
      this.log.error({ err, slot: this.slot, telefone }, 'renderPrompt falhou — bot nao responde');
      return null;
    }

    // Contexto base do banco (negócio, horários, serviços, cliente) SEM a agenda
    // individual — a disponibilidade do estabelecimento vem nos blocos rotulados abaixo.
    const baseContext = await buildContextBlock({
      slot: this.slot,
      nomeCliente: pushName || telefone,
      telefoneCliente: telefone,
      dataAtual,
      ano: String(now.getFullYear()),
      agendaFormatada: '',
    });

    // Blocos runtime, não-editáveis, SÓ no estabelecimento (ADR 0024 §6 / panorama §6).
    const systemPrompt = [
      promptPersona,
      '',
      baseContext,
      '',
      '[PROFISSIONAIS]',
      estab.profissionaisBlock,
      '',
      '[HORARIOS DISPONIVEIS POR PROFISSIONAL - ATUALIZADO AGORA]',
      estab.horariosBlock,
    ].join('\n');

    const fullHistory = await this.loadHistory(ctx);
    const history = fullHistory.slice(0, -1);

    const tools: ToolDefinition[] = [
      {
        name: 'inserir_agendamento',
        description:
          'Insere um agendamento no Google Calendar do PROFISSIONAL escolhido. Use APENAS apos ' +
          'o cliente confirmar com SIM E ter escolhido o profissional (id curto C1, C2, …). ' +
          'Summary: "[Nome] - [Servico] | WhatsApp: [numero]"',
        parameters: {
          type: 'object',
          properties: {
            colaborador_id: {
              type: 'string',
              description:
                'Id curto do profissional escolhido pelo cliente (ex.: C1, C2). Obrigatorio. ' +
                'Use SOMENTE um id que aparece no bloco [PROFISSIONAIS]. Nunca invente nem passe e-mail/agenda.',
            },
            summary: { type: 'string', description: 'Titulo: "Nome - Servico | WhatsApp: numero"' },
            start: { type: 'string', description: 'Inicio ISO 8601 com timezone' },
            end: { type: 'string', description: 'Fim ISO 8601 com timezone' },
          },
          required: ['colaborador_id', 'summary', 'start', 'end'],
        },
        run: async (args: unknown) => {
          const { colaborador_id, summary, start, end } = args as {
            colaborador_id: string;
            summary: string;
            start: string;
            end: string;
          };

          // Resolve calendarId SERVER-SIDE a partir do id curto, validando contra a
          // lista ATIVA daquele slot/tenant (decorados). Id inválido / inativo / de
          // OUTRO estabelecimento -> null -> rejeita (sem vazamento cross-tenant).
          // O LLM nunca passa calendarId — só o id curto, que aqui é validado.
          const colaborador = resolveColaboradorByShortId(decorados, String(colaborador_id ?? ''));
          if (!colaborador) {
            this.log.warn(
              { slot: this.slot, telefone, colaboradorIdRecebido: colaborador_id },
              'inserir_agendamento rejeitado: colaborador_id invalido/inativo/fora do slot',
            );
            return {
              ok: false,
              error: 'COLABORADOR_INVALIDO',
              message:
                'Profissional não reconhecido. Pergunte ao cliente qual profissional ele quer.',
            };
          }

          const colabClient = colaborador.client;

          // Validação server-side de overlap NA AGENDA DO COLABORADOR (fonte de verdade).
          const existing = await colabClient.listEvents({ timeMin: start, timeMax: end });
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
                slot: this.slot,
                colaboradorId: colaborador.colaboradorId,
                conflito: { start: conflito.start.dateTime, end: conflito.end.dateTime },
                requestedStart: start,
                requestedEnd: end,
                telefone,
              },
              'inserir_agendamento (estab) bloqueado: conflito na agenda do colaborador',
            );
            return {
              ok: false,
              error: 'CONFLITO',
              conflito: { start: conflito.start.dateTime, end: conflito.end.dateTime },
            };
          }

          const createEvent = () =>
            colabClient.createEvent({ summary, startISO: start, endISO: end, timeZone: TZ });

          // Action-lock por (slot, colaborador, telefone, inicio): flag OFF -> cria direto.
          if (!config.IDEMPOTENCY_ACTION_LOCK) {
            const ev = await createEvent();
            this.log.info(
              {
                eventId: ev.id,
                summary: ev.summary,
                colaboradorId: colaborador.colaboradorId,
                telefone,
              },
              'Agendamento criado (estabelecimento)',
            );
            return {
              ok: true,
              eventId: ev.id,
              summary: ev.summary,
              colaborador_nome: colaborador.nome,
            };
          }

          const lockKey = gcalActionLockKey(
            `${this.slot}:${colaborador.colaboradorId}`,
            telefone,
            start,
          );
          const lock = await withActionLock(lockKey, createEvent);
          if (!lock.executed) {
            this.log.info(
              { lockKey, telefone },
              'inserir_agendamento (estab) pulado: acao ja em andamento (action-lock)',
            );
            return { ok: true, skipped: true, colaborador_nome: colaborador.nome };
          }
          const ev = lock.value as Awaited<ReturnType<typeof createEvent>>;
          this.log.info(
            {
              eventId: ev.id,
              summary: ev.summary,
              colaboradorId: colaborador.colaboradorId,
              telefone,
              degraded: lock.degraded,
            },
            'Agendamento criado (estabelecimento)',
          );
          return {
            ok: true,
            eventId: ev.id,
            summary: ev.summary,
            colaborador_nome: colaborador.nome,
          };
        },
      },
      {
        name: 'consultar_agendamento',
        description: 'Consulta agendamentos futuros do cliente nas agendas dos profissionais.',
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
          const phone = tel.replace(/\D/g, '');
          const matching: Array<{
            summary?: string;
            start?: string;
            end?: string;
            profissional: string;
          }> = [];
          // Cruza nas agendas de TODOS os colaboradores ativos do estabelecimento.
          for (const c of decorados) {
            const evs = await c.client.listEvents({ timeMin: tMin, timeMax: tMax });
            for (const e of evs) {
              if (e.summary?.includes(phone) || e.description?.includes(phone)) {
                matching.push({
                  summary: e.summary,
                  start: e.start.dateTime,
                  end: e.end.dateTime,
                  profissional: c.nome,
                });
              }
            }
          }
          if (!matching.length)
            return { events: [], message: 'Nenhum agendamento futuro encontrado.' };
          return { events: matching };
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
