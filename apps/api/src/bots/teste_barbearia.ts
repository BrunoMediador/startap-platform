import { hashEventIdForLog } from '@startap/core/gcal-event-log';
import { phoneLogTag } from '@startap/core/phone';
import type { BotContext } from '@startap/core/types';
import { atendimentos, cloneColaboradores, flowClones } from '@startap/db';
import { gcal } from '@startap/integrations';
import type { ToolDefinition } from '@startap/integrations/openai';
import { buildCartaoRuntimeBlock } from '@startap/integrations/prompt-builder';
import {
  type ColaboradorAgenda,
  buildContextBlock,
  buildEstabelecimentoContext,
  colaboradorFazServico,
  formatarAgendaComConfig,
  loadScheduleConfig,
  reanchorWallTimeToTz,
  resolveColaboradorByShortId,
  servicosDoColaborador,
} from '@startap/integrations/scheduling';
import { config } from '../config.js';
import { gcalActionLockKey, withActionLock } from '../lib/action-lock.js';
import {
  buildCartaoEmojiOverrideBlock,
  buildCartaoEstabelecimentoBlock,
} from '../lib/area-emojis.js';
import { sendClientCancellationAlert, sendOwnerAlert } from '../lib/client-alert.js';
import { buildEquipeBlock, buildModoAtendenteBlock } from '../lib/modo-atendente.js';
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

/**
 * Resultado da resolução do evento a remarcar (buildRemarcarTool). O caller injeta um
 * resolver que encontra o agendamento DO PRÓPRIO cliente: individual = a agenda única do
 * clone; estabelecimento = varre as agendas dos colaboradores e devolve a agenda DONA do
 * evento + o colaborador (não move entre colaboradores). `ambiguous` = mais de um match
 * (mesmo telefone+horário em agendas diferentes) -> pede ao cliente pra especificar.
 */
type RemarcarResolve =
  | {
      kind: 'found';
      client: gcal.GoogleCalendarClient;
      colaboradorId: number | null;
      event: gcal.CalendarEvent;
    }
  | { kind: 'not_found' }
  | { kind: 'ambiguous' };

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

  /**
   * Tool `escalar_cancelamento` (Missão 023 W5) — DORMENTE por flag. O bot NUNCA
   * cancela na agenda: a tool só ESCALA o pedido pro dono do clone (fire-and-forget,
   * `sendClientCancellationAlert` captura toda falha) e devolve {ok,escalado} pro modelo.
   *
   * Extraída pra ser usada nos DOIS caminhos (individual + estabelecimento) — antes só o
   * individual a expunha, então no estabelecimento um cliente que digitava "quero cancelar"
   * (texto, não botão) fazia o LLM improvisar, podendo afirmar que cancelou SEM avisar o dono.
   * O caller decide expor ou não pela flag CANCELAMENTO_ESCALADO_ENABLED — comportamento
   * idêntico nos dois caminhos.
   */
  private buildEscalarCancelamentoTool(telefone: string): ToolDefinition {
    return {
      name: 'escalar_cancelamento',
      description:
        'Use SOMENTE quando o cliente pedir explicitamente para CANCELAR/DESMARCAR um ' +
        'horario ja agendado e NAO quiser remarcar. NAO use para: remarcar/trocar de ' +
        'horario (isso e remarcar_agendamento, NUNCA inserir_agendamento), confirmar presenca, ' +
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
    };
  }

  /**
   * Tool `consultar_pacote` (ADR 0025 BLOCO 2a — DORMENTE por flag). READ-ONLY: só LÊ os
   * pacotes do cliente já calculados server-side (saldo/validade/cobertura/escopo, com
   * EXPIRADO/ESGOTADO explícitos). NÃO toca saldo/ledger/GCal — a DEDUÇÃO é o bloco 2b
   * (maybeDeduzirPacote), INTOCADA. O caller expõe ou não pela flag PACOTES_ENABLED.
   *
   * Compartilhada por individual E estabelecimento (SCRUM-68 — fecha o "pacote cego ao saldo"
   * no estab): a identidade é SEMPRE o número da CONVERSA (telefone), NUNCA o do LLM
   * (anti-IDOR/PII cross-cliente). O pacote é por cliente-final, então resolveClientPackages
   * isola por slot+telefone idêntico nos dois caminhos.
   */
  private buildConsultarPacoteTool(telefone: string): ToolDefinition {
    return {
      name: 'consultar_pacote',
      description:
        'Use quando o cliente perguntar sobre o PACOTE pré-pago dele (quantas sessões ' +
        'restam, validade, o que cobre). Esta ferramenta apenas CONSULTA o saldo — ela ' +
        'NÃO desconta, NÃO agenda e NÃO altera nada. Devolve os pacotes do cliente já ' +
        'calculados (ativos, expirados e esgotados).',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      run: async () => {
        // SEGURANÇA (IDOR/PII cross-cliente): NUNCA aceita telefone do LLM. O saldo é
        // SEMPRE o do número da CONVERSA (o remetente).
        const credits = await resolveClientPackages({
          slot: this.slot,
          telefone,
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
    };
  }

  /**
   * Tool `escalar_para_humano` (MODO ATENDENTE — SCRUM-59). Passa a bola pro humano quando
   * o bot NÃO deve/consegue resolver: reclamação, negociação de preço, pedido fora do padrão
   * ou pedido explícito de falar com uma pessoa. Espelha `escalar_cancelamento`:
   * fire-and-forget (sendOwnerAlert captura toda falha), NUNCA toca agenda, SEMPRE devolve
   * {ok:true} pro modelo — a IA só manda a mensagem de transição, nunca trava a conversa.
   *
   * Transporte = sessão do PRÓPRIO clone (não a ALERTAS, muda por 463).
   *
   * SCRUM-62: escalar SÓ ALERTA — NÃO auto-pausa mais (removida a chamada e o método
   * autoPauseAfterEscalation). A pausa `escalated_human` SEM expires_at era PERMANENTE
   * (pausa.ts): o cliente pedia "cancelar/falar com humano", o bot alertava o dono E calava
   * o número pra sempre, sem nada que despausasse sozinho (evidência prod: 2 pausas
   * escalated_human na Meduzza em 06/07, uma despausada à mão). A pausa automática do modo
   * atendente vive AGORA só onde deve: quando o atendente responde À MÃO (human_reply, 60min,
   * router.ts) ou por frase de pausa explícita/portal.
   */
  private buildEscalarParaHumanoTool(telefone: string): ToolDefinition {
    return {
      name: 'escalar_para_humano',
      description:
        'Use quando: (1) reclamacao/insatisfacao, (2) negociacao de preco/desconto/condicao ' +
        'especial, (3) pedido fora do padrao ou que voce NAO consegue responder com o contexto, ' +
        '(4) pedido explicito de falar com uma pessoa/atendente/humano. NAO use para agendar ' +
        '(isso e registrar_interesse) nem para duvida que voce sabe responder com o contexto. ' +
        'Esta ferramenta apenas AVISA a equipe/dono — quem assume e um humano.',
      parameters: {
        type: 'object',
        properties: {
          motivo: {
            type: 'string',
            enum: ['reclamacao', 'negociacao', 'fora_do_padrao', 'pediu_humano'],
            description: 'Categoria do que o cliente quer.',
          },
          resumo: {
            type: 'string',
            description: '1-2 frases do que o cliente quer, pra equipe entrar ja situada.',
          },
        },
        required: ['motivo', 'resumo'],
      },
      run: async (args: unknown): Promise<{ ok: boolean; escalado: boolean }> => {
        const a = (args ?? {}) as { motivo?: unknown; resumo?: unknown };
        const motivo = typeof a.motivo === 'string' ? a.motivo : '';
        const resumo = typeof a.resumo === 'string' ? a.resumo : '';
        // Fire-and-forget: o resultado do envio nunca derruba o atendimento.
        const r = await sendOwnerAlert({
          slot: this.slot,
          clienteTelefone: telefone,
          kind: 'escalonamento',
          transport: 'clone_session',
          payload: { motivo, resumo },
        });
        // SCRUM-62: NÃO auto-pausa. Escalar só alerta o dono; a pausa (temporária, 60min)
        // acontece quando o atendente responde à mão (router.ts) ou por frase de pausa.
        return { ok: true, escalado: r.escalado };
      },
    };
  }

  /**
   * Tool `registrar_interesse` (MODO ATENDENTE — SCRUM-59). Registra o lead (interesse em
   * agendar) e AVISA o dono pra dar sequência. NÃO agenda nada. Espelha o padrão do escalar:
   * fire-and-forget, SEMPRE {ok:true} pro modelo. Transporte = sessão do PRÓPRIO clone.
   *
   * Persistência (fase 1): o próprio sendOwnerAlert emite log estruturado no envio bem-
   * sucedido (registro mínimo). NUNCA carimba "avisado" antes do envio (lição #412): o
   * campo `registrado` reflete o resultado REAL do envio (r.escalado).
   */
  private buildRegistrarInteresseTool(telefone: string): ToolDefinition {
    return {
      name: 'registrar_interesse',
      description:
        'Use quando o cliente demonstrar que quer AGENDAR e voce ja juntou o minimo (servico + ' +
        'melhor dia/faixa de horario). Registra o interesse e avisa a equipe/dono para dar ' +
        'sequencia. NAO agenda nada — apenas registra e dispara o aviso. Chame UMA vez por ' +
        'conversa (a menos que os dados mudem muito).',
      parameters: {
        type: 'object',
        properties: {
          nome: {
            type: 'string',
            description: 'Nome do cliente (ja conhecido). Nao pergunte de novo se ja tem.',
          },
          servico: { type: 'string', description: 'Servico desejado, como o cliente falou.' },
          profissional: {
            type: 'string',
            description: 'Preferencia de profissional; "" se tanto faz ou negocio individual.',
          },
          janela: {
            type: 'string',
            description: 'Melhor dia/faixa, ex.: "sabado de manha", "quinta a tarde".',
          },
          observacao: {
            type: 'string',
            description: 'Opcional: algo relevante ("cliente novo", "veio do instagram").',
          },
        },
        required: ['servico', 'janela'],
      },
      run: async (args: unknown): Promise<{ ok: boolean; registrado: boolean }> => {
        const a = (args ?? {}) as {
          nome?: unknown;
          servico?: unknown;
          profissional?: unknown;
          janela?: unknown;
          observacao?: unknown;
        };
        const r = await sendOwnerAlert({
          slot: this.slot,
          clienteTelefone: telefone,
          kind: 'lead',
          transport: 'clone_session',
          payload: {
            nome: typeof a.nome === 'string' ? a.nome : undefined,
            servico: typeof a.servico === 'string' ? a.servico : '',
            profissional: typeof a.profissional === 'string' ? a.profissional : undefined,
            janela: typeof a.janela === 'string' ? a.janela : '',
            observacao: typeof a.observacao === 'string' ? a.observacao : undefined,
          },
        });
        return { ok: true, registrado: r.escalado };
      },
    };
  }

  /**
   * Tool `remarcar_agendamento` — REMARCAÇÃO via patchEvent (preserva o MESMO eventId).
   *
   * BUG que isto corrige: antes o bot só tinha `inserir_agendamento` (createEvent → eventId
   * NOVO). Quando o cliente pedia pra REMARCAR, a IA criava um evento NOVO → (1) 2ª linha de
   * `atendimentos` (fatura/comissão 2×), (2) **2ª baixa de pacote** (o UNIQUE(gcal_event_id,
   * reason) do ledger não pega event_id novo → double-redeem, "dívida 5" do ADR 0025) e (3)
   * lembrete pros DOIS horários. O PORTAL já resolvia isso preservando o event_id num PATCH
   * (#331). Esta tool espelha a MESMA abordagem provada no caminho do bot.
   *
   * Compartilhada pelos DOIS caminhos (individual + estabelecimento). A diferença — onde o
   * evento mora (1 agenda do clone vs. N agendas de colaborador) — fica encapsulada no
   * `resolveEvent` injetado pelo caller. Aqui só: valida horários → resolve o evento DO
   * PRÓPRIO cliente (telefone da CONVERSA, nunca de input do LLM) → recheca conflito na nova
   * janela (ignorando o próprio evento) → `patchEvent` (mesmo eventId) → sincroniza a linha de
   * atendimento (mesma linha; SEM forma de pagamento, pra preservar a marca 'pacote' e NÃO
   * reabrir o bug DOBRA do ADR 0027). NÃO move o agendamento entre colaboradores (v1, igual ao
   * portal) e NÃO troca o serviço (remarcação = só horário) — ambos seguem pelo fluxo normal.
   */
  private buildRemarcarTool(args: {
    telefone: string;
    resolveEvent: (startAtualISO: string) => Promise<RemarcarResolve>;
    /** Fuso (IANA) do clone (default SP). Reancora SÓ a NOVA janela; start_atual fica intacto. */
    cloneTz: string;
  }): ToolDefinition {
    const { telefone, resolveEvent, cloneTz } = args;
    return {
      name: 'remarcar_agendamento',
      description:
        'Use para REMARCAR/transferir um agendamento JA EXISTENTE do cliente para um novo ' +
        'horario (MESMO servico). NUNCA use inserir_agendamento para remarcar — isso criaria ' +
        'um evento DUPLICADO e cobraria/descontaria o pacote 2x. Antes, confirme com ' +
        'consultar_agendamento qual agendamento o cliente quer mover. Passe start_atual = o ' +
        'inicio ATUAL desse agendamento (ISO 8601, exatamente como veio em consultar_agendamento) ' +
        'e novo_start/novo_end = o novo horario (use a duracao do servico). A ferramenta MOVE o ' +
        'mesmo agendamento (preserva pacote/cobranca). Para TROCAR de servico ou de profissional, ' +
        'nao use esta tool.',
      parameters: {
        type: 'object',
        properties: {
          start_atual: {
            type: 'string',
            description:
              'Inicio ATUAL do agendamento a remarcar (ISO 8601, como veio em consultar_agendamento).',
          },
          novo_start: { type: 'string', description: 'Novo inicio ISO 8601 com timezone.' },
          novo_end: { type: 'string', description: 'Novo fim ISO 8601 com timezone.' },
        },
        required: ['start_atual', 'novo_start', 'novo_end'],
      },
      run: async (rawArgs: unknown) => {
        const {
          start_atual: startAtual,
          novo_start: novoStartRaw,
          novo_end: novoEndRaw,
        } = rawArgs as { start_atual: string; novo_start: string; novo_end: string };

        // Reancora SÓ a NOVA janela no fuso do clone — o LLM emite wall-time com o offset
        // errado chumbado (−03 de SP). start_atual NÃO é reancorado: é instante absoluto do
        // GCal usado pra casar o evento por .getTime() no resolveEvent. Clone SP = no-op
        // (reancorar 14:00−03 em SP devolve o MESMO instante → byte-idêntico ao de hoje).
        const novoStart = reanchorWallTimeToTz(novoStartRaw, cloneTz) ?? novoStartRaw;
        const novoEnd = reanchorWallTimeToTz(novoEndRaw, cloneTz) ?? novoEndRaw;

        const atualMs = new Date(startAtual).getTime();
        const novoStartMs = new Date(novoStart).getTime();
        const novoEndMs = new Date(novoEnd).getTime();
        if (
          !Number.isFinite(atualMs) ||
          !Number.isFinite(novoStartMs) ||
          !Number.isFinite(novoEndMs) ||
          novoEndMs <= novoStartMs
        ) {
          return {
            ok: false,
            error: 'PARAMETROS_INVALIDOS',
            message: 'Horarios invalidos. Confirme o agendamento atual e o novo horario.',
          };
        }

        // Resolve o evento DO PRÓPRIO cliente (telefone da conversa) que começa em start_atual.
        // not_found / ambiguous nunca tocam o GCal — só devolvem instrução pro modelo.
        const resolved = await resolveEvent(startAtual);
        if (resolved.kind === 'not_found') {
          return {
            ok: false,
            error: 'AGENDAMENTO_NAO_ENCONTRADO',
            message:
              'Nao encontrei esse agendamento. Confirme o horario atual com o cliente ' +
              '(use consultar_agendamento) antes de remarcar.',
          };
        }
        if (resolved.kind === 'ambiguous') {
          return {
            ok: false,
            error: 'AGENDAMENTO_AMBIGUO',
            message:
              'Ha mais de um agendamento nesse horario. Pergunte ao cliente qual servico/' +
              'profissional ele quer remarcar.',
          };
        }

        const { client, colaboradorId, event } = resolved;
        const eventId = event.id;

        // Anti-corrida: recheca a NOVA janela NA MESMA agenda, IGNORANDO o proprio evento
        // (mesma regra server-side do inserir_agendamento — o GCal e a fonte de verdade).
        const existing = await client.listEvents({ timeMin: novoStart, timeMax: novoEnd });
        const conflito = existing.find((ev) => {
          if (ev.id === eventId) return false;
          const evStart = new Date(ev.start.dateTime ?? ev.start.date ?? novoStart).getTime();
          const evEnd = new Date(ev.end.dateTime ?? ev.end.date ?? novoEnd).getTime();
          return evStart < novoEndMs && evEnd > novoStartMs;
        });
        if (conflito) {
          this.log.warn(
            {
              slot: this.slot,
              fone: phoneLogTag(telefone),
              eventId: hashEventIdForLog(eventId),
              novoStart,
              colaboradorId,
            },
            'remarcar_agendamento bloqueado: nova janela ocupada (conflito server-side)',
          );
          return {
            ok: false,
            error: 'CONFLITO',
            conflito: { start: conflito.start.dateTime, end: conflito.end.dateTime },
          };
        }

        // PATCH preserva o MESMO eventId -> sem 2o atendimento, sem 2a baixa de pacote, sem
        // 2o lembrete (o reminder reaponta sozinho: mesma linha, novo inicio_at). NUNCA
        // delete+create (ADR 0025 divida 5).
        const updated = await client.patchEvent(eventId, {
          startISO: novoStart,
          endISO: novoEnd,
          timeZone: cloneTz,
        });
        this.log.info(
          {
            slot: this.slot,
            fone: phoneLogTag(telefone),
            eventId: hashEventIdForLog(eventId),
            colaboradorId,
            novoStart,
            novoEnd,
          },
          'Agendamento remarcado (patchEvent — eventId preservado)',
        );

        // Sincroniza a linha de atendimento (MESMA linha, idempotente pelo eventId preservado):
        // janela nova, SEM forma de pagamento -> o UPDATE PRESERVA forma/valor existentes
        // (remarcar um agendamento pago via PACOTE NÃO reverte a marca -> não dobra a receita).
        // Gated por slot (ATEND_FROM_AGENDA_SLOTS) e best-effort (nunca derruba a remarcação).
        await this.maybeSincronizarAtendimento({
          eventId,
          summary: updated.summary ?? event.summary ?? '',
          start: updated.start?.dateTime ?? novoStart,
          end: updated.end?.dateTime ?? novoEnd,
          colaboradorId,
        });

        return { ok: true, eventId, novo_start: novoStart, novo_end: novoEnd };
      },
    };
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
        {
          slot: this.slot,
          fone: phoneLogTag(telefone),
          pushName,
          escalado: config.CANCELAMENTO_ESCALADO_ENABLED,
        },
        'cancelamento detectado (botão literal) — bot NÃO cancela; escala pro dono se flag ON',
      );
      return 'ok! vou avisar o time, e logo entraremos em contato!';
    }

    // ── Modo ATENDENTE (SCRUM-59 — DORMENTE por gate por-clone) ──────────────────
    // GATE DUPLO: só entra no ramo atendente se MODO_ATENDENTE_SLOTS inclui este slot
    // **E** o perfil do clone tem agenda_automatica=false (flow_clones.personalizacao).
    // Qualquer um falso -> o código abaixo (estabelecimento/individual) roda BYTE-A-BYTE
    // como hoje. Cirilo/Samuel estão fora do gate -> nunca alcançam processAtendente. O
    // modo atendente NÃO tem agenda, então precede o gate de estabelecimento (que resolve
    // agenda por colaborador). personalizacao pode guardar boolean OU string — checa ambos.
    if (
      await flowClones.resolveModoAtendenteEnabledForSlot(this.slot, config.MODO_ATENDENTE_SLOTS)
    ) {
      const cloneModo = await flowClones.getCloneBySlot(this.slot);
      const rawAgenda: unknown = cloneModo?.personalizacao?.agenda_automatica;
      if (rawAgenda === false || rawAgenda === 'false') {
        return this.processAtendente(ctx);
      }
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
      // ── DEGRADE ELEGANTE (ADR 0030 D3, Onda 3) ─────────────────────────────────
      // Clone individual que escolheu AGENDA mas cuja Service Account do Google AINDA
      // não foi conectada pelo time (etapa manual, ADR 0024): em vez do gate DURO
      // ("agenda ainda não configurada, avise o admin"), o bot degrada pra ATENDENTE
      // (coleta lead + encaminha, SEM tool de agenda, SEM [HORARIOS], sem prometer
      // horário) até o gcal ficar de pé.
      //
      // É derivação de RUNTIME: efetivo = agenda_automatica && gcalConfigured
      // (resolveEffectiveAgenda). getGcalForSlot=null => gcalConfigured=false => efetivo
      // atendente. NÃO há flip do valor armazenado — ao conectar a SA, getGcalForSlot
      // volta não-nula e este ramo NÃO roda mais (bot vira agenda sozinho, sem deploy).
      //
      // BYTE-IDÊNTICO pros clones JÁ conectados (Cirilo/Samuel): gcal ativo =>
      // calClient != null => nunca entram aqui. Só clones sem agenda conectada degradam.
      this.log.info(
        { slot: this.slot },
        'gcal ainda não conectado — degrade elegante para atendente (ADR 0030 D3)',
      );
      return this.processAtendente(ctx);
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
        {
          err: err instanceof Error ? err.message : String(err),
          slot: this.slot,
          fone: phoneLogTag(telefone),
        },
        'free-slots: configuração ausente — bot não responde para evitar dados fictícios',
      );
      return null;
    }

    // Fuso do clone (default 'America/Sao_Paulo' via migration 068) — relógio da barbearia.
    // Clone SP é byte-idêntico ao comportamento de hoje em todos os pontos abaixo.
    const cloneTz = scheduleConfig.timezone;

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
      timeZone: cloneTz,
    });

    // O bot_prompt no banco contém SOMENTE persona+regras+fluxo+cartão (parte
    // editável pelo usuário do painel). Renderiza sem vars dinâmicas —
    // vars dinâmicas vão no bloco de contexto separado abaixo.
    let promptPersona: string;
    try {
      promptPersona = await renderPrompt({ slot: this.slot, vars: {} });
    } catch (err) {
      this.log.error(
        { err, slot: this.slot, fone: phoneLogTag(telefone) },
        'renderPrompt falhou — bot nao responde',
      );
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
      faqSlotsConfig: config.FAQ_PERSONALIZADO_SLOTS,
      // faqColumnEnabled (ADR 0030 D1) OMITIDO de propósito no caminho do bot: o env FAQ é '*'
      // (cobre TODOS via UNIÃO) -> ler a coluna aqui só adicionaria um getCloneBySlot sem mudar
      // nada (byte-idêntico). A coluna do FAQ é a fonte self-service no PORTAL (portal-perfil,
      // resolveFaqPersonalizadoEnabledForSlot). Quando o env deixar de ser '*' (Onda 3+), passa-se
      // faqColumnEnabled aqui a partir do clone JÁ carregado no caminho — sem read novo.
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
    // o de hoje. getAreaAndPromptCustom degrada pra { null, false } em erro/coluna
    // ausente (fallback seguro).
    //
    // SCRUM-84: se a persona é custom (prompt_custom=true, dono estilizou o cartão à
    // mão — ex. Ingrid com 🌻), ela é autoridade final e o override de emojis NÃO é
    // injetado. Mesma leitura por slot de antes, só com a coluna prompt_custom junto.
    const { area, promptCustom, cartaoMode, cartaoConfig, nomeNegocio } =
      await cloneColaboradores.getAreaPromptCustomCartao(this.slot);

    // ── Cartão em RUNTIME (SCRUM-92 inc.2 / ADR 0032) — gate DUPLO ────────────────
    // runtimeCartao só é NÃO-VAZIO com CARTAO_RUNTIME_ENABLED (ON em prod desde 23/07/2026)
    // **E** cartao_mode='runtime' (coluna por-clone; default 'baked'). Clone 'baked' →
    // runtimeCartao='' → cartaoBlock = buildCartaoEmojiOverrideBlock EXATAMENTE como antes
    // (barbearia baked → '' → array colapsa igual; golden byte-a-byte).
    // ⚠️ A FLAG É LOAD-BEARING (ADR 0033): desligá-la com clones em cartao_mode='runtime' os deixa
    // SEM cartão (o baked já foi removido do bot_prompt deles). Rollback = migrate-cartao-runtime
    // --revert <slot>, NÃO a flag.
    // Quando ativo, o cartão montado por código SUBSTITUI o override de emojis (não soma):
    // o clone runtime NÃO tem o cartão baked no bot_prompt, então há 1 cartão só. `nomeNegocio`
    // vem do MESMO read (zero query extra) → cabeia o `<nome do negócio>` do cartão (antes
    // placeholder); clone migrado com `verbatim` ignora tudo isso e emite o cartão legado exato.
    const runtimeCartao =
      config.CARTAO_RUNTIME_ENABLED && cartaoMode === 'runtime'
        ? buildCartaoRuntimeBlock({
            modo: 'agenda',
            area,
            config: cartaoConfig,
            nomeNegocio: nomeNegocio ?? undefined,
          })
        : '';
    const cartaoBlock =
      runtimeCartao !== '' ? runtimeCartao : buildCartaoEmojiOverrideBlock(area, promptCustom);

    const systemPrompt = [promptPersona, contextBlock, pacoteBlock, cartaoBlock]
      .filter((b) => b !== '')
      .join('\n\n');

    const fullHistory = await this.loadHistory(ctx);
    const history = fullHistory.slice(0, -1);

    const tools: ToolDefinition[] = [
      {
        name: 'inserir_agendamento',
        description:
          'Insere um agendamento NOVO no Google Calendar. Use APENAS apos o cliente confirmar com SIM. ' +
          'Para REMARCAR um agendamento que JA existe, use remarcar_agendamento — NUNCA crie outro ' +
          'evento aqui (duplicaria cobranca/pacote). ' +
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

          // Reancora o horário-de-parede do LLM no fuso do clone ANTES de tudo (conflito,
          // criação, atendimento). O LLM emite start/end com o offset errado chumbado (−03 de
          // SP); reinterpretamos a hora-de-parede no relógio da barbearia. Clone SP = no-op
          // (byte-idêntico ao de hoje). startISO/endISO viram a fonte de verdade do instante.
          const startISO = reanchorWallTimeToTz(start, cloneTz) ?? start;
          const endISO = reanchorWallTimeToTz(end, cloneTz) ?? end;

          // Validação server-side: impede criação de evento com overlap real no Calendar.
          // O LLM pode alucinar disponibilidade — esta verificação é a fonte de verdade.
          const existing = await calClient.listEvents({ timeMin: startISO, timeMax: endISO });
          const reqStart = new Date(startISO).getTime();
          const reqEnd = new Date(endISO).getTime();
          const conflito = existing.find((ev) => {
            const evStart = new Date(ev.start.dateTime ?? ev.start.date ?? startISO).getTime();
            const evEnd = new Date(ev.end.dateTime ?? ev.end.date ?? endISO).getTime();
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
                requestedStart: startISO,
                requestedEnd: endISO,
                fone: phoneLogTag(telefone),
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
              startISO,
              endISO,
              timeZone: cloneTz,
            });

          // ── Action-lock (ADR 0019, passo 3) ──────────────────────────────
          // Flag OFF (default) -> cria o evento direto, IGUAL a hoje.
          if (!config.IDEMPOTENCY_ACTION_LOCK) {
            const ev = await createEvent();
            this.log.info(
              {
                eventId: hashEventIdForLog(ev.id),
                summary: ev.summary,
                fone: phoneLogTag(telefone),
              },
              'Agendamento criado',
            );
            // Dedução de pacote (ADR 0025 2b) — gated por PACOTES_ENABLED; OFF = pula tudo.
            const pacote = await this.maybeDeduzirPacote({
              telefone,
              eventId: ev.id,
              summary,
              servicoArg,
              usaPacoteArg,
            });
            // Gancho de billing derivado da agenda (ADR 0027) — gated por slot (ATEND_FROM_AGENDA_SLOTS);
            // slot fora da lista = no-op. Best-effort: nunca quebra o agendamento (try/catch interno). Individual = colaborador null.
            // formaPagamento='pacote' quando o pacote foi DEDUZIDO -> linha conta receita 0 (não dobra).
            await this.maybeRegistrarAtendimento({
              eventId: ev.id,
              summary,
              servicoArg,
              start: startISO,
              end: endISO,
              colaboradorId: null,
              formaPagamento: pacote?.descontou_do_pacote ? 'pacote' : null,
            });
            return { ok: true, eventId: ev.id, summary: ev.summary, ...(pacote ? { pacote } : {}) };
          }

          // Flag ON -> envolve a criacao do evento com lock distribuido por
          // (slot, telefone, inicio). Quem adquire cria; quem nao adquire
          // entende que a acao ja foi feita por outro processamento e PULA.
          // Fail-open: Redis down -> cria mesmo assim (degraded=true).
          const lockKey = gcalActionLockKey(this.slot, telefone, startISO);
          const lock = await withActionLock(lockKey, createEvent);
          if (!lock.executed) {
            // Acao ja em andamento/feita por outro processamento da mesma
            // mensagem -> NAO cria 2º evento. Devolve sucesso pro agente para
            // a conversa nao virar erro nem nova tentativa.
            this.log.info(
              { lockKey, fone: phoneLogTag(telefone) },
              'inserir_agendamento pulado: acao ja em andamento (action-lock)',
            );
            return { ok: true, skipped: true };
          }
          const ev = lock.value as Awaited<ReturnType<typeof createEvent>>;
          this.log.info(
            {
              eventId: hashEventIdForLog(ev.id),
              summary: ev.summary,
              fone: phoneLogTag(telefone),
              degraded: lock.degraded,
            },
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
          // formaPagamento='pacote' quando o pacote foi DEDUZIDO -> linha conta receita 0 (não dobra).
          // start/end REANCORADOS no fuso do clone (startISO/endISO), IGUAL ao ramo sem-lock e ao
          // createEvent. Passar o cru (offset −03 do LLM) gravava o atendimento 1h adiantado em
          // clones não-SP (ex.: Seven/Cuiabá −04). Clone SP = byte-idêntico (no-op).
          await this.maybeRegistrarAtendimento({
            eventId: ev.id,
            summary,
            servicoArg,
            start: startISO,
            end: endISO,
            colaboradorId: null,
            formaPagamento: pacote?.descontou_do_pacote ? 'pacote' : null,
          });
          return { ok: true, eventId: ev.id, summary: ev.summary, ...(pacote ? { pacote } : {}) };
        },
      },
      {
        name: 'consultar_agendamento',
        description:
          'Consulta os agendamentos futuros do PRÓPRIO cliente da conversa no Google ' +
          'Calendar. Não precisa de telefone — usa sempre o número de quem está falando.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        run: async () => {
          // SEGURANÇA (IDOR/PII cross-cliente): ignora QUALQUER telefone vindo do LLM e
          // usa SEMPRE o número da CONVERSA (o remetente). Antes a tool filtrava pelo
          // telefone cru passado pelo modelo → um cliente pedia "ver o horário do 5511…"
          // e recebia nome/horário de OUTRO cliente do mesmo tenant.
          const phone = telefone.replace(/\D/g, '');
          const tMin = new Date().toISOString();
          const tMax = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
          const evs = await calClient.listEvents({ timeMin: tMin, timeMax: tMax });
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

    // ── Remarcação via patchEvent (individual) — SEMPRE exposta ──────────────────
    // Resolve o agendamento DO PRÓPRIO cliente na agenda única do clone, casando telefone
    // da CONVERSA (nunca input do LLM) + inicio ATUAL (start_atual). patchEvent preserva o
    // eventId -> sem 2º atendimento/baixa de pacote/lembrete. Sempre disponível: sem ela, a
    // IA recriava o evento (bug). Os ganchos de billing/pacote seguem gated por slot.
    tools.push(
      this.buildRemarcarTool({
        telefone,
        cloneTz,
        resolveEvent: async (startAtualISO: string): Promise<RemarcarResolve> => {
          const tMin = new Date().toISOString();
          const tMax = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
          const evs = await calClient.listEvents({ timeMin: tMin, timeMax: tMax });
          const phone = telefone.replace(/\D/g, '');
          const targetMs = new Date(startAtualISO).getTime();
          const matches = evs.filter(
            (e) =>
              (e.summary?.includes(phone) || e.description?.includes(phone)) &&
              e.start.dateTime != null &&
              new Date(e.start.dateTime).getTime() === targetMs,
          );
          if (matches.length === 0) return { kind: 'not_found' };
          if (matches.length > 1) return { kind: 'ambiguous' };
          return { kind: 'found', client: calClient, colaboradorId: null, event: matches[0] };
        },
      }),
    );

    // ── Cancelamento escalado (Missão 023 W5 — DORMENTE por flag) ────────────────
    // A tool SÓ é exposta ao modelo quando a flag está ON. Com a flag OFF a lista de
    // tools é IDÊNTICA à de hoje (só inserir/consultar) — bot 100% inalterado.
    // A tool NÃO toca o GCal: nenhuma chamada de delete/createEvent. Apenas escala o
    // pedido pro dono do clone (fire-and-forget) e responde {ok, escalado} pro modelo.
    if (config.CANCELAMENTO_ESCALADO_ENABLED) {
      tools.push(this.buildEscalarCancelamentoTool(telefone));
    }

    // ── consultar_pacote (ADR 0025 BLOCO 2a — DORMENTE por flag) ─────────────────
    // Tool READ-ONLY: SÓ é exposta com PACOTES_ENABLED=ON. Com a flag OFF a lista de
    // tools é IDÊNTICA à de hoje (bot 100% inalterado). NÃO toca saldo/ledger/GCal —
    // só LÊ os pacotes do cliente já calculados server-side. A DEDUÇÃO é o bloco 2b.
    // Helper compartilhado com o estabelecimento (SCRUM-68) — MESMA tool, mesma identidade.
    if (config.PACOTES_ENABLED) {
      tools.push(this.buildConsultarPacoteTool(telefone));
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
   * MODO ATENDENTE (SCRUM-59). Ramo do bot para clones SEM agenda automática: atende, tira
   * dúvida (com os dados do CONTEXTO), qualifica interesse e ESCALA pro humano — sem NUNCA
   * tocar a agenda. Reusa o mesmo runner: renderPrompt (persona do banco) + buildContextBlock
   * SEM `agendaFormatada` (nega disponibilidade em tempo real; mantém [NEGOCIO]/[FUNCIONAMENTO]/
   * [SERVICOS]/[OBSERVACOES], onde o link_agendamento cai) + buildModoAtendenteBlock (guardrail).
   *
   * Tools = [escalar_para_humano, registrar_interesse]. NENHUMA tool de agenda (inserir/
   * remarcar/consultar) — o bot fica INCAPAZ de fechar pelo GCal por construção (requisito nº1
   * do cliente). Não injeta [SEU PACOTE] nem cartão de confirmação (não há agendamento aqui).
   */
  private async processAtendente(ctx: BotContext): Promise<string | null> {
    const { telefone, texto, pushName } = ctx.message;

    // 1 leitura do clone (cacheada): fuso + link_agendamento. Não usa loadScheduleConfig
    // (que exige agenda e silenciaria). timezone default SP via normalizeCloneRow.
    const clone = await flowClones.getCloneBySlot(this.slot);
    const cloneTz = clone?.timezone ?? 'America/Sao_Paulo';
    const linkRaw: unknown = clone?.personalizacao?.link_agendamento;
    const hasLink = typeof linkRaw === 'string' && linkRaw.trim() !== '';

    const now = new Date();

    // Persona vem só do banco (bot_prompt) — igual ao caminho individual.
    let promptPersona: string;
    try {
      promptPersona = await renderPrompt({ slot: this.slot, vars: {} });
    } catch (err) {
      this.log.error(
        { err, slot: this.slot, fone: phoneLogTag(telefone) },
        'renderPrompt falhou (modo atendente) — bot nao responde',
      );
      return null;
    }

    const dataAtual = now.toLocaleDateString('pt-BR', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: cloneTz,
    });

    // Contexto SEM agendaFormatada: nega disponibilidade em tempo real, mas mantém os
    // dados do negócio (funcionamento/serviços/preços/endereço/pagamento/link).
    const contextBlock = await buildContextBlock({
      slot: this.slot,
      nomeCliente: pushName || telefone,
      telefoneCliente: telefone,
      dataAtual,
      ano: String(now.getFullYear()),
      faqSlotsConfig: config.FAQ_PERSONALIZADO_SLOTS,
      // faqColumnEnabled (ADR 0030 D1) OMITIDO de propósito no caminho do bot: o env FAQ é '*'
      // (cobre TODOS via UNIÃO) -> ler a coluna aqui só adicionaria um getCloneBySlot sem mudar
      // nada (byte-idêntico). A coluna do FAQ é a fonte self-service no PORTAL (portal-perfil,
      // resolveFaqPersonalizadoEnabledForSlot). Quando o env deixar de ser '*' (Onda 3+), passa-se
      // faqColumnEnabled aqui a partir do clone JÁ carregado no caminho — sem read novo.
    });

    // ── Bloco [EQUIPE] (SCRUM-59) — só pro estabelecimento com colaboradores ativos ──
    // O clone do piloto virou product_type='estabelecimento' pra usar a Equipe do portal; mesmo
    // SEM agenda, o bot precisa responder "quem faz X"/"quero com Fulano". listBySlot dá nome +
    // serviços SEM tocar gcal/calendarId (não há agenda no modo). getProductType degrada pra
    // 'individual' em erro -> individual/erro = sem bloco (bot não menciona equipe). Best-effort:
    // falha aqui não derruba o atendimento (o bloco fica vazio).
    let equipeBlock = '';
    try {
      const productType = await cloneColaboradores.getProductType(this.slot);
      if (productType === 'estabelecimento') {
        const colaboradores = await cloneColaboradores.listBySlot(this.slot);
        equipeBlock = buildEquipeBlock(
          colaboradores.filter((c) => c.ativo).map((c) => ({ nome: c.nome, servicos: c.servicos })),
        );
      }
    } catch (err) {
      this.log.warn(
        { err: err instanceof Error ? err.message : String(err), slot: this.slot },
        'modo-atendente: falha ao montar [EQUIPE] (segue sem o bloco)',
      );
    }

    const modoBlock = buildModoAtendenteBlock({ hasLink, hasEquipe: equipeBlock !== '' });

    // ── Cartão em RUNTIME (SCRUM-92 inc.2 / ADR 0032) — ATENDENTE não tem cartão ─────
    // 3º ponto de injeção, mesmo padrão gated dos outros 2 — mas o modo atendente é
    // PRÉ-VENDA: não marca horário, logo NÃO há cartão de confirmação em NENHUM modo
    // (baked ou runtime). buildCartaoRuntimeBlock({modo:'atendente'}) devolve '' por
    // CONSTRUÇÃO → runtimeCartao é sempre '' → o array colapsa byte-a-byte o de hoje.
    // Não lemos cartao_mode aqui de propósito: zero read novo no hot path do atendente.
    const runtimeCartao = config.CARTAO_RUNTIME_ENABLED
      ? buildCartaoRuntimeBlock({ modo: 'atendente' })
      : '';

    const systemPrompt = [promptPersona, contextBlock, equipeBlock, modoBlock, runtimeCartao]
      .filter((b) => b !== '')
      .join('\n\n');

    const fullHistory = await this.loadHistory(ctx);
    const history = fullHistory.slice(0, -1);

    // SÓ as 2 tools do modo atendente. NENHUMA tool de agenda (incapacidade por construção).
    const tools: ToolDefinition[] = [
      this.buildEscalarParaHumanoTool(telefone),
      this.buildRegistrarInteresseTool(telefone),
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
        eventId: hashEventIdForLog(input.eventId),
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
   *  1) GATING POR-CLONE: slot fora de ATEND_FROM_AGENDA_SLOTS (lista vazia = todos)
   *     -> retorna IMEDIATAMENTE, zero linha, zero efeito. O caminho do bot é byte-a-byte
   *     o de hoje (Cirilo/Samuel inalterados).
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
    /**
     * Forma de pagamento DERIVADA da dedução de pacote (ADR 0027 — bug DOBRA receita).
     * Quando o agendamento foi pago via PACOTE (maybeDeduzirPacote.descontou_do_pacote=true),
     * o caller passa 'pacote' aqui -> upsertAtendimentoFromEvent zera valor_cents (a receita
     * já entrou na venda do pacote; não contar 2×). Ausente/undefined = previsão normal.
     */
    formaPagamento?: string | null;
  }): Promise<void> {
    // GATE POR-CLONE: slot fora da lista (vazia = todos) -> nada acontece. Byte-a-byte
    // o bot de hoje (Cirilo/Samuel inalterados). this.slot SEMPRE do clone (isolamento).
    // Resolução env→coluna (ADR 0030 D1): env ATEND_FROM_AGENDA_SLOTS OR flow_clones.billing_from_agenda_enabled.
    if (
      !(await flowClones.resolveAtendFromAgendaEnabledForSlot(
        this.slot,
        config.ATEND_FROM_AGENDA_SLOTS,
      ))
    )
      return;
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
          { slot: this.slot, eventId: hashEventIdForLog(input.eventId) },
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
      // formaPagamento='pacote' (quando o pacote foi deduzido) -> o helper zera valor_cents
      // (não conta receita 2×, ADR 0027 bug DOBRA). Ausente -> previsão normal (forma null).
      const row = await atendimentos.upsertAtendimentoFromEvent({
        slot: this.slot,
        tenantId,
        gcalEventId: input.eventId,
        servicoNome: servicoNome || null,
        colaboradorId: input.colaboradorId ?? null,
        clienteNome: clienteNome || null,
        inicioAt: input.start,
        fimAt: input.end,
        formaPagamento: input.formaPagamento ?? null,
        // Fuso do clone (default SP) — deriva `data` (dia-de-parede) no relógio da barbearia.
        // Clone SP = byte-idêntico; clone em outro fuso evita booking noturno vazar de dia.
        timezone: scope.timezone,
      });
      this.log.info(
        {
          slot: this.slot,
          eventId: hashEventIdForLog(input.eventId),
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
          eventId: hashEventIdForLog(input.eventId),
        },
        'atend-from-agenda: falha ao gravar atendimento — IGNORADA (bot segue normal)',
      );
    }
  }

  /**
   * Gancho de billing na REMARCAÇÃO (espelha o PATCH do portal — hookUpsertAtendimento mode
   * 'sync'). Sincroniza a MESMA linha de atendimento do evento (eventId preservado pelo
   * patchEvent) com a nova janela. Best-effort + gated por slot (ATEND_FROM_AGENDA_SLOTS) —
   * idêntico a maybeRegistrarAtendimento, com 2 diferenças DELIBERADAS:
   *
   *  1) usa syncAtendimentoFromEvent (intenção explícita de SINCRONIZAR um evento já existente);
   *  2) NÃO passa formaPagamento -> o UPDATE PRESERVA forma/valor da linha (ADR 0027). Assim
   *     remarcar um agendamento pago via PACOTE NÃO reverte a marca 'pacote' pra null (o que
   *     faria a receita DOBRAR). Remarcação é só de horário; não reprecifica.
   *
   * NUNCA quebra a remarcação: todo o corpo em try/catch (o evento já foi movido no GCal).
   */
  private async maybeSincronizarAtendimento(input: {
    eventId: string;
    summary: string;
    start: string;
    end: string;
    colaboradorId?: number | null;
  }): Promise<void> {
    if (
      !(await flowClones.resolveAtendFromAgendaEnabledForSlot(
        this.slot,
        config.ATEND_FROM_AGENDA_SLOTS,
      ))
    )
      return;
    try {
      // tenant_id SEMPRE do clone (isolamento P0) — nunca de input.
      const scope = await cloneColaboradores.getScopeBySlot(this.slot);
      const tenantId = scope.tenant_id;
      if (!tenantId) {
        this.log.warn(
          { slot: this.slot, eventId: hashEventIdForLog(input.eventId) },
          'atend-from-agenda (remarcar): tenant_id não resolvido — linha NÃO sincronizada (isolamento)',
        );
        return;
      }
      const servicoNome = servicoFromSummary(input.summary);
      const clienteNome = clienteFromSummary(input.summary);
      const row = await atendimentos.syncAtendimentoFromEvent({
        slot: this.slot,
        tenantId,
        gcalEventId: input.eventId,
        servicoNome: servicoNome || null,
        colaboradorId: input.colaboradorId ?? null,
        clienteNome: clienteNome || null,
        inicioAt: input.start,
        fimAt: input.end,
        // Fuso do clone (default SP) — deriva `data` no relógio da barbearia (idêntico p/ SP).
        timezone: scope.timezone,
        // formaPagamento OMITIDO de propósito -> UPDATE preserva forma/valor (não reabre DOBRA).
      });
      this.log.info(
        {
          slot: this.slot,
          eventId: hashEventIdForLog(input.eventId),
          atendimentoId: row.id,
          colaboradorId: input.colaboradorId ?? null,
        },
        'atend-from-agenda (remarcar): linha sincronizada com a nova janela',
      );
    } catch (err) {
      this.log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          slot: this.slot,
          eventId: hashEventIdForLog(input.eventId),
        },
        'atend-from-agenda (remarcar): falha ao sincronizar — IGNORADA (remarcação OK)',
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
      // ── DEGRADE ELEGANTE do ESTABELECIMENTO (ADR 0030 D3, Onda 3) ───────────────
      // Estabelecimento que escolheu AGENDA mas cuja Service Account do Google / agendas
      // dos colaboradores AINDA não foram conectadas pelo time (etapa manual, ADR 0024):
      // nenhum colaborador agendável. Em vez de SILENCIAR (gate DURO, que deixava o cliente
      // novo sem resposta), degrada pra ATENDENTE — coleta lead + encaminha, SEM tool de
      // agenda e SEM vazar a agenda principal do clone (processAtendente não toca gcal) —
      // até as agendas ficarem de pé. Paridade com o degrade INDIVIDUAL acima.
      //
      // Derivação de RUNTIME: ao conectar as agendas, getGcalsForSlot volta não-vazio e este
      // ramo NÃO roda mais (vira estabelecimento com agenda, sem deploy). BYTE-IDÊNTICO pro
      // dragon (que TEM colaboradores/gcal): getGcalsForSlot != [] => nunca entra aqui.
      this.log.info(
        { slot: this.slot, fone: phoneLogTag(telefone) },
        'estabelecimento sem colaborador agendável — degrade elegante para atendente (ADR 0030 D3)',
      );
      return this.processAtendente(ctx);
    }

    // Config de agenda (horários + serviços globais do clone) — mesma fonte do individual.
    let scheduleConfig: import('@startap/integrations/scheduling').ScheduleConfig;
    try {
      scheduleConfig = await loadScheduleConfig(this.slot);
    } catch (err) {
      this.log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          slot: this.slot,
          fone: phoneLogTag(telefone),
        },
        'estabelecimento: configuração de horários/serviços ausente — bot não responde',
      );
      return null;
    }

    // Fuso do clone (default 'America/Sao_Paulo' via migration 068) — relógio da barbearia.
    // Clone SP é byte-idêntico ao comportamento de hoje em todos os pontos abaixo.
    const cloneTz = scheduleConfig.timezone;

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
        { err: msg, slot: this.slot, fone: phoneLogTag(telefone) },
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
      timeZone: cloneTz,
    });

    let promptPersona: string;
    try {
      promptPersona = await renderPrompt({ slot: this.slot, vars: {} });
    } catch (err) {
      this.log.error(
        { err, slot: this.slot, fone: phoneLogTag(telefone) },
        'renderPrompt falhou — bot nao responde',
      );
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
      faqSlotsConfig: config.FAQ_PERSONALIZADO_SLOTS,
      // faqColumnEnabled (ADR 0030 D1) OMITIDO de propósito no caminho do bot: o env FAQ é '*'
      // (cobre TODOS via UNIÃO) -> ler a coluna aqui só adicionaria um getCloneBySlot sem mudar
      // nada (byte-idêntico). A coluna do FAQ é a fonte self-service no PORTAL (portal-perfil,
      // resolveFaqPersonalizadoEnabledForSlot). Quando o env deixar de ser '*' (Onda 3+), passa-se
      // faqColumnEnabled aqui a partir do clone JÁ carregado no caminho — sem read novo.
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
    //
    // SCRUM-85: a REGRA ESTRUTURAL do cartão (obrigatório + SIM + PROFISSIONAL +
    // back-to-back) vai SEMPRE; só o ESTILO/emojis respeita prompt_custom. Se a persona
    // é custom (dono estilizou o cartão à mão), buildCartaoEstabelecimentoBlock mantém
    // os campos obrigatórios mas NÃO impõe os emojis da área — a persona dita os ícones.
    const { area, promptCustom, cartaoMode, cartaoConfig, nomeNegocio } =
      await cloneColaboradores.getAreaPromptCustomCartao(this.slot);

    // ── Cartão em RUNTIME no ESTABELECIMENTO (SCRUM-92 inc.2 / ADR 0032) — gate DUPLO ──
    // Igual ao individual: só NÃO-VAZIO com CARTAO_RUNTIME_ENABLED (ON em prod desde 23/07/2026)
    // **E** cartao_mode='runtime' (default 'baked'). Clone 'baked' → runtimeCartao='' → cai no
    // buildCartaoEstabelecimentoBlock EXATAMENTE como antes (byte-a-byte). Flag LOAD-BEARING: ver
    // ADR 0033 e a nota no caminho individual.
    // Quando ativo, o cartão de estabelecimento montado por código (com 👤 PROFISSIONAL)
    // SUBSTITUI o bloco baked na MESMA posição do array — nunca soma, sem duplicar cartão.
    const runtimeCartao =
      config.CARTAO_RUNTIME_ENABLED && cartaoMode === 'runtime'
        ? buildCartaoRuntimeBlock({
            modo: 'estabelecimento',
            area,
            config: cartaoConfig,
            nomeNegocio: nomeNegocio ?? undefined,
          })
        : '';
    const cartaoEstabelecimentoBlock =
      runtimeCartao !== '' ? runtimeCartao : buildCartaoEstabelecimentoBlock(area, promptCustom);

    // ── Bloco [SEU PACOTE] no ESTABELECIMENTO (ADR 0025 — DORMENTE por flag; SCRUM-68) ──
    // Fecha o "pacote cego ao saldo" no estab: o bot já DEDUZ pacote (maybeDeduzirPacote,
    // INTOCADO) mas não informava o saldo na conversa. Mesma lógica/identidade do individual:
    // SÓ com PACOTES_ENABLED=ON E o cliente (número da CONVERSA) tendo algum pacote. Pacote é
    // por cliente-final (telefone) — resolveClientPackages isola por slot+telefone idêntico ao
    // individual. Read-only: nenhuma escrita/dedução. Com a flag OFF ou sem pacote, pacoteBlock
    // fica '' e o systemPrompt do estab é BYTE-A-BYTE o de hoje (append condicional abaixo).
    let pacoteBlock = '';
    if (config.PACOTES_ENABLED) {
      const credits = await resolveClientPackages({
        slot: this.slot,
        telefone,
        apenasAtivos: false, // inclui EXPIRADO/ESGOTADO para informar o cliente
      });
      pacoteBlock = buildSeuPacoteBlock(credits);
    }

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
      // Append condicional: pacoteBlock vazio (flag OFF / sem pacote) NÃO adiciona linha —
      // systemPrompt byte-a-byte o de hoje. Com pacote: '' (separador) + o bloco.
      ...(pacoteBlock ? ['', pacoteBlock] : []),
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
          'profissional que faz aquele servico (ver [PROFISSIONAIS]). Para REMARCAR um ' +
          'agendamento que JA existe, use remarcar_agendamento — NUNCA crie outro evento aqui. ' +
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

          // Reancora o horário-de-parede do LLM no fuso do clone (mesmo do individual). O LLM
          // emite start/end com offset errado chumbado (−03 de SP); reinterpretamos no relógio
          // da barbearia. Clone SP = no-op (byte-idêntico). startISO/endISO = fonte do instante.
          const startISO = reanchorWallTimeToTz(start, cloneTz) ?? start;
          const endISO = reanchorWallTimeToTz(end, cloneTz) ?? end;

          // Resolve calendarId SERVER-SIDE a partir do id curto, validando contra a
          // lista ATIVA daquele slot/tenant (decorados). Id inválido / inativo / de
          // OUTRO estabelecimento -> null -> rejeita (sem vazamento cross-tenant).
          // O LLM nunca passa calendarId — só o id curto, que aqui é validado.
          const colaborador = resolveColaboradorByShortId(decorados, String(colaborador_id ?? ''));
          if (!colaborador) {
            this.log.warn(
              {
                slot: this.slot,
                fone: phoneLogTag(telefone),
                colaboradorIdRecebido: colaborador_id,
              },
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
                fone: phoneLogTag(telefone),
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
          const existing = await colabClient.listEvents({ timeMin: startISO, timeMax: endISO });
          const reqStart = new Date(startISO).getTime();
          const reqEnd = new Date(endISO).getTime();
          const conflito = existing.find((ev) => {
            const evStart = new Date(ev.start.dateTime ?? ev.start.date ?? startISO).getTime();
            const evEnd = new Date(ev.end.dateTime ?? ev.end.date ?? endISO).getTime();
            return evStart < reqEnd && evEnd > reqStart;
          });
          if (conflito) {
            this.log.warn(
              {
                slot: this.slot,
                colaboradorId: colaborador.colaboradorId,
                conflito: { start: conflito.start.dateTime, end: conflito.end.dateTime },
                requestedStart: startISO,
                requestedEnd: endISO,
                fone: phoneLogTag(telefone),
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
            colabClient.createEvent({ summary, startISO, endISO, timeZone: cloneTz });

          // Action-lock por (slot, colaborador, telefone, inicio): flag OFF -> cria direto.
          if (!config.IDEMPOTENCY_ACTION_LOCK) {
            const ev = await createEvent();
            this.log.info(
              {
                eventId: hashEventIdForLog(ev.id),
                summary: ev.summary,
                colaboradorId: colaborador.colaboradorId,
                fone: phoneLogTag(telefone),
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
            // formaPagamento='pacote' quando o pacote foi DEDUZIDO -> linha conta receita 0 (não dobra).
            await this.maybeRegistrarAtendimento({
              eventId: ev.id,
              summary,
              servicoArg,
              start: startISO,
              end: endISO,
              colaboradorId: colaborador.colaboradorId,
              formaPagamento: pacote?.descontou_do_pacote ? 'pacote' : null,
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
            startISO,
          );
          const lock = await withActionLock(lockKey, createEvent);
          if (!lock.executed) {
            this.log.info(
              { lockKey, fone: phoneLogTag(telefone) },
              'inserir_agendamento (estab) pulado: acao ja em andamento (action-lock)',
            );
            return { ok: true, skipped: true, colaborador_nome: colaborador.nome };
          }
          const ev = lock.value as Awaited<ReturnType<typeof createEvent>>;
          this.log.info(
            {
              eventId: hashEventIdForLog(ev.id),
              summary: ev.summary,
              colaboradorId: colaborador.colaboradorId,
              fone: phoneLogTag(telefone),
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
          // formaPagamento='pacote' quando o pacote foi DEDUZIDO -> linha conta receita 0 (não dobra).
          // start/end REANCORADOS no fuso do clone (startISO/endISO), IGUAL ao ramo sem-lock e ao
          // createEvent. Passar o cru (offset −03 do LLM) gravava o atendimento 1h adiantado em
          // clones não-SP (ex.: Seven/Cuiabá −04). Clone SP = byte-idêntico (no-op).
          await this.maybeRegistrarAtendimento({
            eventId: ev.id,
            summary,
            servicoArg,
            start: startISO,
            end: endISO,
            colaboradorId: colaborador.colaboradorId,
            formaPagamento: pacote?.descontou_do_pacote ? 'pacote' : null,
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
        description:
          'Consulta os agendamentos futuros do PRÓPRIO cliente da conversa nas agendas dos ' +
          'profissionais. Não precisa de telefone — usa sempre o número de quem está falando.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        run: async () => {
          // SEGURANÇA (IDOR/PII cross-cliente): ignora QUALQUER telefone do LLM; usa SEMPRE
          // o número da CONVERSA (o remetente) ao cruzar as agendas dos colaboradores.
          const phone = telefone.replace(/\D/g, '');
          const tMin = new Date().toISOString();
          const tMax = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
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

    // ── Remarcação via patchEvent (estabelecimento) — SEMPRE exposta ─────────────
    // Varre as agendas dos colaboradores ATIVOS (decorados) procurando o agendamento DO
    // cliente (telefone da CONVERSA + inicio ATUAL). Devolve a agenda DONA + o colaborador;
    // patchEvent acontece NELA (eventId preservado) — NÃO move entre colaboradores (v1, igual
    // ao portal). Ambíguo (mesmo telefone+horário em 2 agendas) -> pede pra especificar.
    tools.push(
      this.buildRemarcarTool({
        telefone,
        cloneTz,
        resolveEvent: async (startAtualISO: string): Promise<RemarcarResolve> => {
          const tMin = new Date().toISOString();
          const tMax = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
          const phone = telefone.replace(/\D/g, '');
          const targetMs = new Date(startAtualISO).getTime();
          const matches: Array<{
            client: gcal.GoogleCalendarClient;
            colaboradorId: number;
            event: gcal.CalendarEvent;
          }> = [];
          for (const c of decorados) {
            const evs = await c.client.listEvents({ timeMin: tMin, timeMax: tMax });
            for (const e of evs) {
              if (
                (e.summary?.includes(phone) || e.description?.includes(phone)) &&
                e.start.dateTime != null &&
                new Date(e.start.dateTime).getTime() === targetMs
              ) {
                matches.push({ client: c.client, colaboradorId: c.colaboradorId, event: e });
              }
            }
          }
          if (matches.length === 0) return { kind: 'not_found' };
          if (matches.length > 1) return { kind: 'ambiguous' };
          const m = matches[0];
          return {
            kind: 'found',
            client: m.client,
            colaboradorId: m.colaboradorId,
            event: m.event,
          };
        },
      }),
    );

    // ── Cancelamento escalado (Missão 023 W5 — DORMENTE por flag) ────────────────
    // MESMO comportamento do caminho individual: a tool SÓ é exposta com a flag ON e
    // NÃO toca o GCal — apenas escala o pedido pro dono. Sem isto, um cliente que digita
    // "quero cancelar" (texto, não botão) no estabelecimento fazia o LLM improvisar e
    // podia afirmar que cancelou sem avisar o dono.
    if (config.CANCELAMENTO_ESCALADO_ENABLED) {
      tools.push(this.buildEscalarCancelamentoTool(telefone));
    }

    // ── consultar_pacote no ESTABELECIMENTO (ADR 0025 BLOCO 2a — DORMENTE por flag; SCRUM-68) ──
    // MESMA tool read-only do individual (buildConsultarPacoteTool): SÓ exposta com
    // PACOTES_ENABLED=ON. Fecha o "pacote cego ao saldo" no estab — o bot já DEDUZ pacote
    // (maybeDeduzirPacote, INTOCADO) mas não sabia CONSULTAR/informar o saldo na conversa.
    // NÃO toca saldo/ledger/GCal; identidade = número da CONVERSA (anti-IDOR). Flag OFF ->
    // lista de tools do estab BYTE-A-BYTE a de hoje.
    if (config.PACOTES_ENABLED) {
      tools.push(this.buildConsultarPacoteTool(telefone));
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
}

export { DEFAULT_PROMPT_TPL as TESTE_BARBEARIA_DEFAULT_PROMPT };
