import type { BotContext } from '@startap/core/types';
import { atendimentos, cloneColaboradores, flowClones } from '@startap/db';
import { gcal } from '@startap/integrations';
import type { ToolDefinition } from '@startap/integrations/openai';
import {
  type ColaboradorAgenda,
  buildContextBlock,
  buildEstabelecimentoContext,
  colaboradorFazServico,
  formatarAgendaComConfig,
  loadScheduleConfig,
  resolveColaboradorByShortId,
  servicosDoColaborador,
} from '@startap/integrations/scheduling';
import { config } from '../config.js';
import { gcalActionLockKey, withActionLock } from '../lib/action-lock.js';
import {
  buildCartaoEmojiOverrideBlock,
  buildCartaoEstabelecimentoBlock,
} from '../lib/area-emojis.js';
import { sendClientCancellationAlert } from '../lib/client-alert.js';
import {
  buildSeuPacoteBlock,
  clienteFromSummary,
  deduzirPacoteNoAgendamento,
  resolveClientPackages,
  servicoFromSummary,
} from '../lib/package-context.js';
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

    // ── Bloco [SEU PACOTE] (ADR 0025 — DORMENTE por flag) ────────────────────────
    // SÓ com PACOTES_ENABLED=ON E o cliente tendo algum pacote: injeta uma linha
    // pronta (saldo/validade/cobertura, com EXPIRADO/ESGOTADO explícitos). Read-only —
    // nenhuma escrita, nenhuma dedução (isso é o bloco 2b). Com a flag OFF, pacoteBlock
    // fica '' e o systemPrompt é BYTE-A-BYTE o de hoje. System prompt segue só persona.
    let pacoteBlock = '';
    if (config.PACOTES_ENABLED) {
      const credits = await resolveClientPackages({
        slot: this.slot,
        telefone,
        apenasAtivos: false, // inclui EXPIRADO/ESGOTADO para informar o cliente
      });
      pacoteBlock = buildSeuPacoteBlock(credits);
    }

    // ── Emojis do cartão por ÁREA (flow_clones.area, migration 051) ──────────────
    // O cartão individual vive no bot_prompt persistido com 💈/✂️ (barbearia). Pra
    // áreas NÃO-barbearia (salão/manicure/estética), injetamos EM RUNTIME um bloco
    // que manda o modelo trocar os ícones — assim clones JÁ existentes (Bruna/salão)
    // pegam o emoji certo SEM re-renderizar o prompt. Para barbearia (Cirilo/Samuel)
    // e para área NULL/desconhecida o builder devolve '' → systemPrompt byte-a-byte
    // o de hoje. getArea degrada pra null em erro/coluna ausente (fallback seguro).
    const area = await cloneColaboradores.getArea(this.slot);
    const cartaoEmojiBlock = buildCartaoEmojiOverrideBlock(area);

    const systemPrompt = [promptPersona, contextBlock, pacoteBlock, cartaoEmojiBlock]
      .filter((b) => b !== '')
      .join('\n\n');

    const fullHistory = await this.loadHistory(ctx);
    const history = fullHistory.slice(0, -1);

    const tools: ToolDefinition[] = [
      {
        name: 'inserir_agendamento',
        description:
          'Insere um agendamento no Google Calendar. Use APENAS apos o cliente confirmar com SIM. ' +
          'Summary: "[Nome] - [Servico] | WhatsApp: [numero]". Se houver [SEU PACOTE] e o ' +
          'cliente quiser usar o pacote pra este servico, passe servico=<nome do servico> e ' +
          'usa_pacote=true; o SISTEMA decide e desconta (voce NUNCA da baixa). Se for avulso, ' +
          'usa_pacote=false. Em caso de duvida, deixe usa_pacote ausente (o sistema valida).',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'Titulo: "Nome - Servico | WhatsApp: numero"' },
            start: { type: 'string', description: 'Inicio ISO 8601 com timezone' },
            end: { type: 'string', description: 'Fim ISO 8601 com timezone' },
            servico: {
              type: 'string',
              description:
                'Nome do servico agendado (ex.: "Corte"). Usado pra checar cobertura de pacote. ' +
                'Se vazio, o sistema tenta extrair do summary.',
            },
            usa_pacote: {
              type: 'boolean',
              description:
                'SUGESTAO: true se o cliente quer usar o pacote pre-pago neste servico. O sistema ' +
                're-valida cobertura/saldo/validade e decide; nunca confie nisto para o saldo.',
            },
          },
          required: ['summary', 'start', 'end'],
        },
        run: async (args: unknown) => {
          const {
            summary,
            start,
            end,
            servico: servicoArg,
            usa_pacote: usaPacoteArg,
          } = args as {
            summary: string;
            start: string;
            end: string;
            servico?: unknown;
            usa_pacote?: unknown;
          };

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
            // Dedução de pacote (ADR 0025 2b) — gated por PACOTES_ENABLED; OFF = pula tudo.
            const pacote = await this.maybeDeduzirPacote({
              telefone,
              eventId: ev.id,
              summary,
              servicoArg,
              usaPacoteArg,
            });
            // Gancho de billing derivado da agenda (ADR 0027) — gated por ATEND_FROM_AGENDA;
            // OFF = no-op. Best-effort: nunca quebra o agendamento (try/catch interno). Individual = colaborador null.
            await this.maybeRegistrarAtendimento({
              eventId: ev.id,
              summary,
              servicoArg,
              start,
              end,
              colaboradorId: null,
            });
            return { ok: true, eventId: ev.id, summary: ev.summary, ...(pacote ? { pacote } : {}) };
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
          // Dedução de pacote (ADR 0025 2b) sob o MESMO action-lock — gated; OFF = pula.
          // Idempotente por UNIQUE(gcal_event_id,reason): retry do MESMO evento não duplica.
          const pacote = await this.maybeDeduzirPacote({
            telefone,
            eventId: ev.id,
            summary,
            servicoArg,
            usaPacoteArg,
          });
          // Gancho de billing derivado da agenda (ADR 0027) sob o MESMO action-lock — gated;
          // OFF = no-op. Idempotente pelo unique parcial (slot, gcal_event_id). Individual = colaborador null.
          await this.maybeRegistrarAtendimento({
            eventId: ev.id,
            summary,
            servicoArg,
            start,
            end,
            colaboradorId: null,
          });
          return { ok: true, eventId: ev.id, summary: ev.summary, ...(pacote ? { pacote } : {}) };
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

    // ── consultar_pacote (ADR 0025 BLOCO 2a — DORMENTE por flag) ─────────────────
    // Tool READ-ONLY: SÓ é exposta com PACOTES_ENABLED=ON. Com a flag OFF a lista de
    // tools é IDÊNTICA à de hoje (bot 100% inalterado). NÃO toca saldo/ledger/GCal —
    // só LÊ os pacotes do cliente já calculados server-side (saldo/validade/cobertura/
    // escopo, com EXPIRADO/ESGOTADO explícitos). A DEDUÇÃO é o bloco 2b.
    if (config.PACOTES_ENABLED) {
      tools.push({
        name: 'consultar_pacote',
        description:
          'Use quando o cliente perguntar sobre o PACOTE pré-pago dele (quantas sessões ' +
          'restam, validade, o que cobre). Esta ferramenta apenas CONSULTA o saldo — ela ' +
          'NÃO desconta, NÃO agenda e NÃO altera nada. Devolve os pacotes do cliente já ' +
          'calculados (ativos, expirados e esgotados).',
        parameters: {
          type: 'object',
          properties: {
            telefone: {
              type: 'string',
              description: 'WhatsApp do cliente (so digitos). Vazio = usa o numero da conversa.',
            },
          },
          required: [],
        },
        run: async (args: unknown) => {
          const a = (args ?? {}) as { telefone?: unknown };
          const tel = typeof a.telefone === 'string' && a.telefone.trim() ? a.telefone : telefone;
          const credits = await resolveClientPackages({
            slot: this.slot,
            telefone: tel,
            apenasAtivos: false,
          });
          // Devolve já calculado; NUNCA o número cru, NUNCA o HMAC (resolvido internamente).
          return {
            pacotes: credits.map((c) => ({
              nome: c.nome,
              estado: c.estado, // ATIVO | EXPIRADO | ESGOTADO | CANCELADO
              sessoes_restantes: c.sessoes_restantes,
              sessoes_total: c.sessoes_total,
              valido_ate: c.data_expiracao,
              cobre: c.servicos_cobertos,
              escopo: c.colaborador_id === null ? 'casa' : 'colaborador',
            })),
          };
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
   * Dedução de pacote APÓS o evento existir no GCal (ADR 0025 BLOCO 2b). Gated por
   * PACOTES_ENABLED no chamador. SEMPRE degrada para "avulso" sem nunca lançar — o evento
   * já está na agenda; falha de pacote não derruba o atendimento (lição #247). Devolve os
   * campos enriquecidos que vão na resposta da tool (descontou/sessoes_restantes/avulso/...).
   *
   * O telefone vem da CONVERSA (this) — nunca de campo livre do LLM. tenant_id é resolvido
   * do clone (cache) como defesa em profundidade (P3 #320); ausência não bloqueia.
   */
  private async maybeDeduzirPacote(input: {
    telefone: string;
    eventId: string | undefined;
    summary: string;
    servicoArg: unknown;
    usaPacoteArg: unknown;
    colaboradorId?: number | null;
  }): Promise<{
    descontou_do_pacote: boolean;
    avulso: boolean;
    sessoes_restantes: number | null;
    motivo: string;
    pacote_nome?: string;
    pacote_colaborador_id?: number | null;
  } | null> {
    if (!config.PACOTES_ENABLED) return null;
    // Sem eventId (action-lock skip / criação degradada sem id) não há âncora de
    // idempotência -> NÃO desconta (evita baixa sem rastro ligável ao evento).
    if (!input.eventId) return null;

    const servicoExplicito =
      typeof input.servicoArg === 'string' && input.servicoArg.trim()
        ? input.servicoArg.trim()
        : servicoFromSummary(input.summary);
    const usaPacote = typeof input.usaPacoteArg === 'boolean' ? input.usaPacoteArg : undefined;

    let tenantId: string | undefined;
    try {
      const clone = await flowClones.getCloneBySlot(this.slot);
      tenantId = clone?.tenant_id ?? undefined;
    } catch {
      tenantId = undefined; // defesa em profundidade — ausência não bloqueia (escopo por slot continua).
    }

    const r = await deduzirPacoteNoAgendamento({
      slot: this.slot,
      tenantId,
      telefone: input.telefone,
      gcalEventId: input.eventId,
      servicoNome: servicoExplicito,
      colaboradorId: input.colaboradorId ?? null,
      usaPacote,
    });
    this.log.info(
      {
        slot: this.slot,
        eventId: input.eventId,
        descontou: r.descontou_do_pacote,
        motivo: r.motivo,
        sessoesRestantes: r.sessoes_restantes,
      },
      'pacote: resultado da deducao no agendamento',
    );
    return {
      descontou_do_pacote: r.descontou_do_pacote,
      avulso: r.avulso,
      sessoes_restantes: r.sessoes_restantes,
      motivo: r.motivo,
      pacote_nome: r.pacote_nome,
      pacote_colaborador_id: r.colaborador_id,
    };
  }

  /**
   * Gancho de billing DERIVADO DA AGENDA (ADR 0027, Fase D). Best-effort, DORMENTE por
   * flag. Faz o evento recém-criado pelo bot virar uma linha de PREVISÃO em `atendimentos`
   * (origem='agenda', status='agendado'). Roda AO LADO da dedução de pacote, sob o MESMO
   * action-lock idempotente — o helper é idempotente pelo unique parcial (slot, gcal_event_id),
   * então reprocesso de webhook / retry do MESMO evento NÃO duplica.
   *
   * GARANTIAS NÃO-NEGOCIÁVEIS (Bruno):
   *  1) GATING: flag ATEND_FROM_AGENDA OFF (default) -> retorna IMEDIATAMENTE, zero linha,
   *     zero efeito. O caminho do bot é byte-a-byte o de hoje (Cirilo/Samuel inalterados).
   *  2) NUNCA QUEBRA O FLUXO: TODO o corpo é envolvido em try/catch. Qualquer falha
   *     (tenant não resolvido, DB fora, helper lançando) é LOGADA e ENGOLIDA — o bot já
   *     criou o evento, deduziu pacote e vai responder o cliente exatamente como hoje.
   *
   * ISOLAMENTO P0: a linha NUNCA nasce sem tenant_id. tenant_id vem do clone
   * (getScopeBySlot, nunca de input). Sem tenant resolvido -> NÃO grava (loga e segue).
   */
  private async maybeRegistrarAtendimento(input: {
    eventId: string | undefined;
    summary: string;
    servicoArg: unknown;
    start: string;
    end: string;
    colaboradorId?: number | null;
  }): Promise<void> {
    // GATE: flag OFF (default) -> nada acontece. Byte-a-byte o bot de hoje.
    if (!config.ATEND_FROM_AGENDA) return;
    // Sem eventId (criação degradada / action-lock sem id) não há chave de idempotência
    // (gcal_event_id) -> NÃO cria (evitaria linha sem âncora de dedup).
    if (!input.eventId) return;

    // best-effort: o gancho NUNCA pode quebrar o agendamento nem a resposta do bot.
    try {
      // tenant_id SEMPRE do clone (isolamento P0) — nunca de input do cliente.
      const scope = await cloneColaboradores.getScopeBySlot(this.slot);
      const tenantId = scope.tenant_id;
      if (!tenantId) {
        this.log.warn(
          { slot: this.slot, eventId: input.eventId },
          'atend-from-agenda: tenant_id não resolvido — linha NÃO criada (isolamento)',
        );
        return;
      }

      // servico/cliente snapshot do mesmo summary que o resto do fluxo usa.
      const servicoNome =
        typeof input.servicoArg === 'string' && input.servicoArg.trim()
          ? input.servicoArg.trim()
          : servicoFromSummary(input.summary);
      const clienteNome = clienteFromSummary(input.summary);

      // valor automático: o helper resolve do flow_clones.servicos pelo servicoNome
      // (valorCents ausente). origem='agenda', status='agendado' definidos no helper.
      const row = await atendimentos.upsertAtendimentoFromEvent({
        slot: this.slot,
        tenantId,
        gcalEventId: input.eventId,
        servicoNome: servicoNome || null,
        colaboradorId: input.colaboradorId ?? null,
        clienteNome: clienteNome || null,
        inicioAt: input.start,
        fimAt: input.end,
      });
      this.log.info(
        {
          slot: this.slot,
          eventId: input.eventId,
          atendimentoId: row.id,
          colaboradorId: input.colaboradorId ?? null,
        },
        'atend-from-agenda: linha de previsão criada/atualizada',
      );
    } catch (err) {
      // Billing é derivado/best-effort; o atendimento ao cliente é sagrado. Loga e segue.
      this.log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          slot: this.slot,
          eventId: input.eventId,
        },
        'atend-from-agenda: falha ao gravar atendimento — IGNORADA (bot segue normal)',
      );
    }
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
    //
    // [CARTAO DE CONFIRMACAO - ESTABELECIMENTO]: o cartão de confirmação do clone
    // individual (no bot_prompt) lista DIA/HORARIO/SERVICO/VALOR mas NÃO o profissional —
    // num estabelecimento o cliente escolhe COM QUEM agendar, então o cartão precisa
    // mostrar isso. Injetamos a regra EM RUNTIME (não no template estático do bot_prompt)
    // de propósito: assim TODO clone estabelecimento — inclusive os JÁ existentes, como o
    // da Bruna — passa a incluir a linha do profissional SEM re-renderizar o prompt deles.
    // Esta instrução SÓ entra neste caminho (gate duplo ESTABELECIMENTO_ENABLED +
    // product_type='estabelecimento'); o clone individual (Cirilo/Samuel) nunca a vê e o
    // cartão deles segue byte-a-byte.
    //
    // Os EMOJIS do cartão seguem a ÁREA do clone (migration 051): barbearia mantém
    // 📅 🕐 ✂️ 💰 👤 (idêntico ao bloco original); salão/manicure/estética trocam
    // marca+serviço. getArea degrada pra null (→ genérico) em erro/coluna ausente.
    const area = await cloneColaboradores.getArea(this.slot);
    const cartaoEstabelecimentoBlock = buildCartaoEstabelecimentoBlock(area);

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
      '',
      cartaoEstabelecimentoBlock,
    ].join('\n');

    const fullHistory = await this.loadHistory(ctx);
    const history = fullHistory.slice(0, -1);

    const tools: ToolDefinition[] = [
      {
        name: 'inserir_agendamento',
        description:
          'Insere um agendamento no Google Calendar do PROFISSIONAL escolhido. Use APENAS apos ' +
          'o cliente confirmar com SIM no CARTAO DE CONFIRMACAO E ter escolhido o profissional ' +
          '(id curto C1, C2, …). NUNCA chame sem mostrar o cartao e receber o SIM — vale para ' +
          'TODO agendamento, inclusive o 2º/3º na mesma conversa. Só agende o servico com um ' +
          'profissional que faz aquele servico (ver [PROFISSIONAIS]). ' +
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
            servico: {
              type: 'string',
              description:
                'Nome do servico agendado. Usado pra checar cobertura de pacote. Vazio = extrai do summary.',
            },
            usa_pacote: {
              type: 'boolean',
              description:
                'SUGESTAO: true se o cliente quer usar o pacote pre-pago. O sistema re-valida e decide.',
            },
          },
          required: ['colaborador_id', 'summary', 'start', 'end'],
        },
        run: async (args: unknown) => {
          const {
            colaborador_id,
            summary,
            start,
            end,
            servico: servicoArg,
            usa_pacote: usaPacoteArg,
          } = args as {
            colaborador_id: string;
            summary: string;
            start: string;
            end: string;
            servico?: unknown;
            usa_pacote?: unknown;
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

          // VALIDAÇÃO serviço×profissional (Bug 2): o serviço pedido tem que estar na
          // lista do colaborador escolhido (clone_colaboradores.servicos, migration 057;
          // vazio = faz todos os globais — fallback em servicosDoColaborador). Rede final
          // server-side: mesmo que o prompt vacile, NÃO marcamos um serviço com quem não
          // o faz. Serviço extraído do arg explícito ou do summary (mesma fonte do pacote).
          const servicoPedido =
            typeof servicoArg === 'string' && servicoArg.trim()
              ? servicoArg.trim()
              : servicoFromSummary(summary);
          if (!colaboradorFazServico(colaborador, scheduleConfig, servicoPedido)) {
            const oferece = servicosDoColaborador(colaborador, scheduleConfig).join(', ');
            this.log.warn(
              {
                slot: this.slot,
                telefone,
                colaboradorId: colaborador.colaboradorId,
                servicoPedido,
              },
              'inserir_agendamento (estab) rejeitado: profissional nao faz o servico pedido',
            );
            return {
              ok: false,
              error: 'SERVICO_NAO_OFERECIDO',
              message:
                `${colaborador.nome} não faz "${servicoPedido}". ` +
                `Ele(a) faz: ${oferece}. Ofereça um desses ou pergunte com qual profissional ` +
                `o cliente quer fazer "${servicoPedido}".`,
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
            const pacote = await this.maybeDeduzirPacote({
              telefone,
              eventId: ev.id,
              summary,
              servicoArg,
              usaPacoteArg,
              colaboradorId: colaborador.colaboradorId,
            });
            // Gancho de billing derivado da agenda (ADR 0027) — gated; OFF = no-op. Best-effort.
            // Estabelecimento: passa o colaborador que recebeu o evento.
            await this.maybeRegistrarAtendimento({
              eventId: ev.id,
              summary,
              servicoArg,
              start,
              end,
              colaboradorId: colaborador.colaboradorId,
            });
            return {
              ok: true,
              eventId: ev.id,
              summary: ev.summary,
              colaborador_nome: colaborador.nome,
              ...(pacote ? { pacote } : {}),
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
          const pacote = await this.maybeDeduzirPacote({
            telefone,
            eventId: ev.id,
            summary,
            servicoArg,
            usaPacoteArg,
            colaboradorId: colaborador.colaboradorId,
          });
          // Gancho de billing derivado da agenda (ADR 0027) sob o MESMO action-lock — gated;
          // OFF = no-op. Best-effort. Estabelecimento: colaborador que recebeu o evento.
          await this.maybeRegistrarAtendimento({
            eventId: ev.id,
            summary,
            servicoArg,
            start,
            end,
            colaboradorId: colaborador.colaboradorId,
          });
          return {
            ok: true,
            eventId: ev.id,
            summary: ev.summary,
            colaborador_nome: colaborador.nome,
            ...(pacote ? { pacote } : {}),
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
