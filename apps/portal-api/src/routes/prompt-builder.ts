/**
 * Builder conversacional de persona (SCRUM-92, ADR 0032).
 *
 * 4 endpoints AUTENTICADOS (withTenant — slot SÓ da sessão, nunca do body): o dono ENTREVISTA
 * um meta-agente que PROPÕE a persona do assistente de WhatsApp dele; ao aprovar, a persona
 * (+ BLOCO_ESTRUTURAL colado por CÓDIGO) vira o bot_prompt de produção do clone.
 *
 *   POST /portal/prompt-builder/start    -> inicia a entrevista (idempotente por slot)
 *   POST /portal/prompt-builder/message  -> 1 turno de conversa; quando o agente chama a tool
 *                                           `propor_prompt`, marca o rascunho pronto
 *   GET  /portal/prompt-builder/draft    -> prévia (persona + bloco estrutural que SERÁ colado)
 *   POST /portal/prompt-builder/approve  -> persiste (transação SCRUM-83) + prompt_custom=true.
 *                                           Persona SEMPRE é o rascunho gerado pela IA — não há
 *                                           edição manual (ordem do Bruno 31/07: dado operacional
 *                                           tem tela própria, editar à mão reintroduz o furo).
 *   POST /portal/prompt-builder/reset    -> recomeça do zero (increment)
 *
 * GARANTIA INEGOCIÁVEL: o meta-agente gera SÓ a persona; a mecânica de agendamento (cartão +
 * exigir SIM antes de inserir_agendamento) é o BLOCO_ESTRUTURAL colado pelo SERVIDOR no approve
 * — a IA nunca a escreve, então nunca pode removê-la. Validador determinístico limpa dados
 * operacionais/PII/tokens estruturais ANTES de persistir.
 *
 * Meta-agente roda SEMPRE no OpenAI (gpt-4o, config.PROMPT_BUILDER_MODEL) — NÃO herda bot_config
 * do clone e NÃO muda o bot real do cliente. Estado da entrevista é efêmero no Redis (TTL).
 * Guardas de custo/abuso no Redis (fail-closed).
 * LGPD: NUNCA loga conteúdo da conversa nem a persona — só slot, tokens, latency, blocked_reason.
 */
import { isAgendaAutomaticaIntent, resolveNomeNegocio } from '@startap/core';
import { logger } from '@startap/core/logger';
import type { ChatTurn } from '@startap/db';
import { botPrompt, cloneColaboradores, flowClones } from '@startap/db';
import { metaEntrevistador, openai, promptBuilder } from '@startap/integrations';
import type { ToolDefinition } from '@startap/integrations/openai';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { PROMPT_BUILDER_CANNED, reserveMessageBudget } from '../lib/prompt-builder-guards.js';
import { avaliarPreservacao } from '../lib/prompt-builder-preservacao.js';
import {
  type PromptBuilderState,
  deleteState,
  getState,
  saveState,
} from '../lib/prompt-builder-state.js';
import {
  MAX_FINAL_PROMPT_CHARS,
  extrairLinhasComTagMoeda,
  sanitizeOrphanPlaceholders,
  stripPII,
  validatePersona,
} from '../lib/prompt-builder-validator.js';
import { classificarLinhasDeMoeda } from '../lib/servico-persona-validator.js';
import { getRedis } from '../lib/session.js';
import { requireTenant, withTenant } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'prompt-builder' });

const FALLBACK_REPLY = 'Tive uma instabilidade agora. Pode enviar a mensagem novamente?';
/** Teto defensivo de turns guardados no estado (history enviada ao modelo é bem menor). */
const MAX_STORED_TURNS = 80;

// Body do /message: .strict() => campo desconhecido = 400 (anti mass-assignment). `role` só pode
// ser 'user' (o system prompt é FIXO no servidor; o cliente NUNCA injeta system/assistant).
// `generate_now` (botão "gerar agora" do front): quando true, o servidor FORÇA a tool
// propor_prompt neste turno (caminho determinístico) — o rascunho sai mesmo com pouca info.
const messageSchema = z
  .object({
    content: z.string().min(1).max(config.PROMPT_BUILDER_MAX_INPUT_CHARS),
    role: z.literal('user').optional(),
    generate_now: z.boolean().optional(),
  })
  .strict();

// Body do /approve: SEM campos (ordem do Bruno 31/07 — dado operacional tem tela própria; edição
// manual da persona permitia colar horário/endereço/preço que a IA barra por design). .strict()
// => qualquer campo (inclusive `persona_editada` de um client antigo em cache) vira 400 de graça
// (anti mass-assignment). NÃO reintroduzir `persona_editada` aqui — é o ponto que este PR fecha.
const approveBodySchema = z.object({}).strict();

// Args da tool propor_prompt capturados via runAgent.toolCalls — validados com Zod (não confiamos
// no schema declarado ao modelo). Chaves extras são descartadas (default do zod object).
const proporPromptArgsSchema = z.object({
  persona_prompt: z.string().min(1).max(6000),
  nome_do_bot: z.string().max(80).nullable().optional(),
  resumo: z.string().min(1).max(2000),
});

/** Timeout duro na chamada do modelo (regra 7: nunca aguardar infinito). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('prompt_builder_llm_timeout')), ms),
    ),
  ]);
}

/**
 * `validatePersona` + classificação de linha de moeda (ADR 0035) — 1 função pros 2 call-sites
 * (mensagem que gera draft + approve). Kill-switch `SERVICO_VALIDACAO_CRUZADA_ENABLED`: OFF
 * (default) → `validatePersona` roda SEM allowlist, byte-a-byte com o comportamento antigo
 * (toda linha `moeda` é cortada, inclusive plano legítimo). ON → extrai as linhas com indício de
 * moeda, pergunta à IA quais são plano/pacote/assinatura legítimo, e só essas sobrevivem.
 *
 * ATALHO DETERMINÍSTICO (01/08, achado do PM em prod): linhas que aparecem DEPOIS de
 * `botPrompt.PLANOS_BLOCK_HEADER` na persona vêm do bloco estrutural que a migração
 * (`migrateClonePlanosToBotPrompt`, PR #568) colou byte-a-byte no `bot_prompt` — origem
 * estruturalmente confiável (texto do dono, grafado pelo script, não pela IA), sem precisar de
 * LLM pra confirmar. Caso real: Ingrid, `bot_prompt` de 2703 bytes com "Pacote Mensal com 4
 * sessões: R$ 396,00 (99,00 por sessão)" + "Ou 2x 198,00 quinzenalmente" sob esse header. Essas
 * linhas entram na allowlist ANTES de chamar o classificador — 0 chamada de LLM pro caso mais
 * comum (o dono nem tocou nessa seção na conversa).
 *
 * Falha do classificador NUNCA bloqueia o approve/draft (fail-closed dentro de
 * `classificarLinhasDeMoeda`: em erro devolve lista vazia) — o pior caso é a linha de plano ser
 * cortada como sempre foi, nunca um 503 no meio da conversa do builder.
 */
async function validatePersonaComClassificacaoDeMoeda(
  persona: string,
  opts: { servicos?: string[] } = {},
): Promise<ReturnType<typeof validatePersona>> {
  if (!config.SERVICO_VALIDACAO_CRUZADA_ENABLED || !config.OPENAI_API_KEY) {
    return validatePersona(persona, opts);
  }

  // Atalho determinístico: linhas dentro do bloco estrutural de planos já migrado são
  // legítimas por origem, sem perguntar ao LLM (ver JSDoc acima).
  const headerTitulo = botPrompt.PLANOS_BLOCK_HEADER.split('\n')[0];
  const idxHeader = persona.indexOf(headerTitulo);
  const linhasDoBlocoEstrutural =
    idxHeader === -1
      ? []
      : persona
          .slice(idxHeader)
          .split('\n')
          .slice(1) // pula a linha do título
          .map((l) => l.replace(/\s+$/g, ''))
          .filter((l) => l.trim() !== '');

  const todasAsLinhasDeMoeda = extrairLinhasComTagMoeda(persona);
  const linhasParaClassificar = todasAsLinhasDeMoeda.filter(
    (l) => !linhasDoBlocoEstrutural.includes(l),
  );

  if (linhasParaClassificar.length === 0) {
    if (linhasDoBlocoEstrutural.length === 0) return validatePersona(persona, opts);
    return validatePersona(persona, {
      ...opts,
      linhasMoedaPermitidas: new Set(linhasDoBlocoEstrutural),
    });
  }

  const { linhasLegitimas } = await classificarLinhasDeMoeda(linhasParaClassificar, {
    model: config.SERVICO_VALIDATOR_MODEL,
    temperature: config.SERVICO_VALIDATOR_TEMPERATURE,
    timeoutMs: config.SERVICO_VALIDATOR_TIMEOUT_MS,
    apiKey: config.OPENAI_API_KEY,
  });
  return validatePersona(persona, {
    ...opts,
    linhasMoedaPermitidas: new Set([...linhasDoBlocoEstrutural, ...linhasLegitimas]),
  });
}

/** Sanitiza o texto do dono antes de virar role:user (strip {{ }} + colapsa quebras + trunca). */
function sanitizeInput(raw: string): string {
  const stripped = raw
    .replace(/\{\{|\}\}/g, '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  const max = config.PROMPT_BUILDER_MAX_INPUT_CHARS;
  return stripped.length > max ? stripped.slice(0, max) : stripped;
}

// resolveNomeNegocio vive em @startap/core (fonte única, também consumida pelo caminho do bot
// via db.getAreaPromptCustomCartao — SCRUM-92 inc.2). Re-exportado aqui pra não quebrar os
// testes/callers que o importam deste módulo.
export { resolveNomeNegocio };

/** Resolve o contexto do clone (nome/área/modo/tipo/cartão) da sessão — NUNCA de input. */
async function loadCloneContext(slot: string): Promise<{
  nomeNegocio: string;
  area: string;
  modo: 'agenda' | 'atendente';
  productType: 'individual' | 'estabelecimento';
  servicos: string[];
  cartaoMode: 'baked' | 'runtime';
  promptCustom: boolean;
  /** JSONB de personalizacao do clone — usado SÓ pra derivar os RÓTULOS dos campos preenchidos
   *  (derivarCamposConfigurados). Nenhum VALOR daqui entra em prompt (SCRUM-153). */
  personalizacao: Record<string, unknown> | null;
} | null> {
  const clone = await flowClones.getCloneBySlot(slot);
  if (!clone) return null;
  // área + cartao_mode + prompt_custom ATUAIS do clone numa única leitura (getAreaPromptCustomCartao,
  // SCRUM-92 inc.2). promptCustom alimenta o guard anti-cartão-duplo do approve (SCRUM-120).
  // failClosed:true (SCRUM-143): este é caminho de ESCRITA (o approve pode flipar cartao_mode) →
  // no erro de DB o reader RELANÇA (em vez de devolver {promptCustom:false}) e o approve aborta,
  // nunca flipa um clone prompt_custom=true às cegas (caso Ingrid).
  const { area, cartaoMode, promptCustom } = await cloneColaboradores.getAreaPromptCustomCartao(
    slot,
    { failClosed: true },
  );

  // ── MODO REAL DO RUNTIME (SCRUM-92, raiz do incidente Ingrid) ──────────────────────
  // O runtime (apps/api/src/bots/teste_barbearia.ts, process()) só entra no ramo ATENDENTE
  // quando a flag/config de atendente está ON **E** agenda_automatica está explicitamente OFF
  // (false/'false'). Um clone com agenda_automatica != false roda AGENDA mesmo com a flag
  // atendente setada (exatamente o caso da Ingrid). Espelhamos EXATAMENTE essa decisão aqui
  // para: (a) o entrevistador usar a postura certa; (b) o approve assar a variante certa do
  // bloco/cartão (individual/estabelecimento vs. atendente). A intenção `agenda_automatica`
  // é a fonte estável (o degrade-elegante por gcal não-conectado é transitório e NÃO deve
  // congelar a persona no bloco de atendente — quando a agenda conecta o clone volta a agenda).
  const modoAtendenteFlag = await flowClones.resolveModoAtendenteEnabledForSlot(
    slot,
    config.MODO_ATENDENTE_SLOTS,
  );
  const agendaIntent = isAgendaAutomaticaIntent(clone.personalizacao?.agenda_automatica);
  const reallyAtendente = modoAtendenteFlag && !agendaIntent;

  // product_type do clone (individual|estabelecimento) — decide se o BLOCO estrutural
  // ganha o campo do profissional. getProductType tem fallback seguro 'individual'.
  const productType = await cloneColaboradores.getProductType(slot);
  const nomeNegocio = resolveNomeNegocio(clone);
  const servicos = (clone.servicos ?? []).map((s) => s.nome).filter((n) => typeof n === 'string');
  return {
    nomeNegocio,
    area: area ?? '',
    modo: reallyAtendente ? 'atendente' : 'agenda',
    productType,
    servicos,
    cartaoMode,
    promptCustom,
    personalizacao: (clone.personalizacao ?? null) as Record<string, unknown> | null,
  };
}

/**
 * Deriva a variante do BLOCO estrutural a partir do tipo do clone + modo da entrevista.
 * Estabelecimento entrevista COMO agenda (o meta-entrevistador não muda), mas o cartão
 * BAKED precisa da variante 'estabelecimento' (com 👤 PROFISSIONAL) — senão colaria o
 * cartão individual, que conflita com o que o runtime já injeta. Atendente é intocado.
 */
function deriveBlocoModo(
  productType: 'individual' | 'estabelecimento',
  modo: 'agenda' | 'atendente',
): promptBuilder.BlocoEstruturalModo {
  return productType === 'estabelecimento' && modo === 'agenda' ? 'estabelecimento' : modo;
}

/** ChatTurn do agente a partir do turno guardado (user->human, assistant->ai). */
function toChatTurn(t: { role: 'user' | 'assistant'; content: string }): ChatTurn {
  return { role: t.role === 'user' ? 'human' : 'ai', content: t.content };
}

/** Prévia read-only do que SERÁ persistido: persona + bloco estrutural colado por código. */
function buildPreviewFinal(state: PromptBuilderState): string | null {
  if (!state.draft) return null;
  // Estabelecimento usa a variante com profissional; estados antigos (pré-deploy) sem
  // productType caem no fallback 'individual' (deriveBlocoModo trata undefined como não-estab).
  const blocoModo = deriveBlocoModo(state.productType ?? 'individual', state.modo);
  const bloco = promptBuilder.buildBlocoEstrutural({ modo: blocoModo, area: state.area });
  return sanitizeOrphanPlaceholders(`${state.draft.persona}\n\n${bloco}`);
}

export const promptBuilderRoutes: FastifyPluginAsync = async (app) => {
  // Ferramenta única do meta-agente: captura a persona proposta. `run` só ecoa (a captura real
  // é lida de result.toolCalls) — o agente NÃO tem tool de leitura de banco (sem exfiltração).
  const proporPromptTool: ToolDefinition = {
    name: metaEntrevistador.PROPOR_PROMPT_TOOL_NAME,
    description:
      'Entrega a PERSONA final do assistente (só persona/tom/postura). Chame quando tiver o ' +
      'suficiente ou o dono pedir pra gerar. NÃO inclua endereço/horário/serviço/preço nem regra técnica.',
    parameters: metaEntrevistador.PROPOR_PROMPT_PARAMETERS,
    run: async () => ({ ok: true }),
  };

  // ── POST /start ────────────────────────────────────────────────────────────
  app.post('/portal/prompt-builder/start', { preHandler: withTenant }, async (req, reply) => {
    if (!config.PROMPT_BUILDER_ENABLED)
      return reply.code(404).send({ error: 'recurso_indisponivel' });
    const { slot } = requireTenant(req);
    const redis = getRedis();

    const existing = await getState(redis, slot);
    if (existing) {
      // Idempotente: entrevista viva -> devolve a corrente (não recomeça sem reset). Retorna os
      // `turns` (aditivo, não quebra a UI) pra reidratar o chat de onde parou — antes só voltava a
      // 1ª pergunta e a conversa sumia. `pergunta` mantém compat. SCRUM-92 (bug 7). LGPD: são os
      // turns do PRÓPRIO dono (withTenant), não vão pra log.
      const abertura = existing.turns.find((t) => t.role === 'assistant')?.content ?? '';
      return reply.code(200).send({
        session_id: slot,
        pergunta: abertura,
        turns: existing.turns.map((t) => ({ role: t.role, content: t.content })),
        draft_ready: existing.draft !== null,
        resumo: existing.draft?.resumo,
        nome_do_bot: existing.draft?.nome_do_bot,
        retomada: true,
        // Aditivo (SCRUM-153): a UI pode rotular a sessão retomada. Estado antigo sem o campo
        // = 'criacao' (o comportamento de sempre).
        modo: existing.sessaoModo ?? 'criacao',
      });
    }

    const ctx = await loadCloneContext(slot);
    if (!ctx) return reply.code(404).send({ error: 'clone_nao_encontrado' });

    // ── MODO DA SESSÃO (SCRUM-153) ───────────────────────────────────────────
    // Decidido AQUI, uma vez, pelo estado REAL do clone — nunca por input do cliente:
    //   clone com persona própria (prompt_custom=true) E bot_prompt não-vazio -> 'melhoria'
    //   qualquer outro caso -> 'criacao' (o caminho de sempre, byte-a-byte).
    // A flag PROMPT_BUILDER_MELHORIA_ENABLED é o kill-switch: OFF -> TODO clone cai em
    // 'criacao', ou seja, o comportamento atual de produção, sem nenhuma mudança.
    // prompt_custom=true SEM prompt no banco (estado inconsistente) também cai em 'criacao':
    // sem persona atual não há o que melhorar, e a V5 ficaria com contexto vazio.
    let sessaoModo: 'criacao' | 'melhoria' = 'criacao';
    let personaAtual = '';
    if (config.PROMPT_BUILDER_MELHORIA_ENABLED && ctx.promptCustom) {
      const atual = await botPrompt.getPrompt(slot);
      if (atual && atual.trim().length > 0) {
        sessaoModo = 'melhoria';
        personaAtual = atual;
      }
    }
    const camposConfigurados =
      sessaoModo === 'melhoria'
        ? metaEntrevistador.derivarCamposConfigurados(ctx.personalizacao, ctx.servicos)
        : [];

    const pergunta =
      sessaoModo === 'melhoria'
        ? metaEntrevistador.primeiraMensagemMelhoria({
            nomeNegocio: ctx.nomeNegocio,
            area: ctx.area || 'atendimento',
            modo: ctx.modo,
          })
        : metaEntrevistador.primeiraPergunta({
            nomeNegocio: ctx.nomeNegocio,
            area: ctx.area || 'atendimento',
            modo: ctx.modo,
          });
    const state: PromptBuilderState = {
      slot,
      nomeNegocio: ctx.nomeNegocio,
      area: ctx.area,
      modo: ctx.modo,
      productType: ctx.productType,
      sessaoModo,
      ...(sessaoModo === 'melhoria' ? { personaAtual, camposConfigurados } : {}),
      turns: [{ role: 'assistant', content: pergunta }],
      draft: null,
      updatedAt: Date.now(),
    };
    await saveState(redis, state);
    // LGPD: loga só o SINAL (modo + quantos campos), nunca a persona nem o conteúdo dos campos.
    log.info(
      { slot, modo: ctx.modo, sessaoModo, camposCount: camposConfigurados.length },
      'prompt-builder: sessão iniciada',
    );
    return reply
      .code(200)
      .send({ session_id: slot, pergunta, draft_ready: false, retomada: false, modo: sessaoModo });
  });

  // ── POST /message ────────────────────────────────────────────────────────────
  app.post('/portal/prompt-builder/message', { preHandler: withTenant }, async (req, reply) => {
    if (!config.PROMPT_BUILDER_ENABLED)
      return reply.code(404).send({ error: 'recurso_indisponivel' });
    const { slot } = requireTenant(req);

    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'dados_invalidos' });

    const redis = getRedis();
    const state = await getState(redis, slot);
    if (!state) return reply.code(409).send({ error: 'entrevista_nao_iniciada' });

    // Sanitiza o input do dono ANTES dos gates: é preciso pra detectar a intenção de "gerar agora"
    // (que fura o teto de turns, ver abaixo) e pra rejeitar mensagem vazia cedo (sem gastar budget).
    const userMessage = sanitizeInput(parsed.data.content);
    if (!userMessage) return reply.code(400).send({ error: 'mensagem_vazia' });

    // CAMINHO DETERMINÍSTICO "gerar agora": quando o dono clica o botão (generate_now=true) OU o
    // texto sinaliza intenção clara ("pode gerar", "terminei"...), FORÇAMOS a tool propor_prompt via
    // tool_choice no runAgent — o rascunho sai NESTE turno, sem depender da vontade do modelo (v3
    // preenche padrões p/ persona completa). Avaliado ANTES do teto: quem bateu o teto sem fechar o
    // draft precisa conseguir clicar "Gerar" — senão era beco sem saída (a própria copy do teto manda
    // "clicar em Gerar"). SCRUM-92 (bug 2).
    const forceGenerate =
      parsed.data.generate_now === true || metaEntrevistador.matchesGenerateIntent(userMessage);

    // REESCRITA EXPLÍCITA (SCRUM-153, só importa no modo melhoria): "refaz tudo", "quero uma
    // persona nova", "começa do zero". Uma vez pedida, vale pro RESTO da sessão (fica no state):
    // o dono não precisa repetir a cada refino, e a guarda de preservação para de segurar
    // proposta menor — ele declarou que quer trocar o texto. STICKY de propósito; pra voltar a
    // preservar, o caminho é /reset (recomeça a sessão limpa).
    const reescritaPedida =
      state.reescritaExplicita === true ||
      metaEntrevistador.matchesReescritaTotalIntent(userMessage);
    if (reescritaPedida) state.reescritaExplicita = true;

    // MODO DA SESSÃO (SCRUM-153) — resolvido ANTES das guardas porque o payload de TODA resposta
    // 200 (inclusive as barradas por teto/orçamento) carrega os campos do preview vivo.
    const emMelhoria = state.sessaoModo === 'melhoria' && !!state.personaAtual;

    /**
     * Campos do PREVIEW VIVO (31/07) presentes em TODA resposta 200 do /message — inclusive nas
     * barradas por guarda: quem bateu o teto de turns continua precisando VER o rascunho que já
     * conseguiu (é justamente daí que ele aprova). Contrato: string|null, nunca undefined.
     *
     * ⚠️ `preview_final` NÃO entra aqui de propósito (review de security S1, P3): o front
     * descarta o campo no parser do /message (`sendBuilderMessage` só extrai `persona_rascunho`)
     * e só lê `previewFinal` do GET /draft. Mandá-lo a cada turno serializava o BLOCO ESTRUTURAL
     * (marcadores + nomes de tool tipo inserir_agendamento) à toa: payload maior e superfície
     * desnecessária, sem nenhum consumidor. Ele continua no GET /draft, que é onde é usado.
     */
    const previewFields = (): {
      persona_rascunho: string | null;
      persona_base: string | null;
    } => ({
      persona_rascunho: state.draft?.persona ?? null,
      // Persona NO AR = lado esquerdo do diff. Do PRÓPRIO tenant (withTenant); null em criação.
      persona_base: emMelhoria ? (state.personaAtual ?? null) : null,
    });

    // 1. teto de turns por entrevista (corta loop de refino infinito) — sem chamar o LLM. NÃO se
    // aplica ao caminho determinístico de geração forçada: esse é 1 turno terminal que fecha o draft.
    const userTurns = state.turns.filter((t) => t.role === 'user').length;
    if (!forceGenerate && userTurns >= config.PROMPT_BUILDER_MAX_TURNS) {
      return reply.code(200).send({
        reply: PROMPT_BUILDER_CANNED.turns_entrevista,
        draft_ready: state.draft !== null,
        ...previewFields(),
      });
    }

    // 2+3. orçamento por tenant/dia + cap global (kill-switch), ANTES do custo de LLM. Vale MESMO
    // no "gerar agora" (guarda de custo é independente do teto de turns).
    const budget = await reserveMessageBudget(redis, slot);
    if (!budget.ok) {
      log.info({ slot, blocked: budget.reason }, 'prompt-builder bloqueado (guarda de custo)');
      const canned = PROMPT_BUILDER_CANNED[budget.reason ?? 'cap_global_diario'];
      return reply
        .code(200)
        .send({ reply: canned, draft_ready: state.draft !== null, ...previewFields() });
    }

    // Provider OpenAI: chave validada LAZY (boot nunca crasha sem ela).
    if (!config.OPENAI_API_KEY) {
      log.error('prompt-builder sem OPENAI_API_KEY provisionada — feature indisponível');
      return reply.code(503).send({ error: 'builder_indisponivel' });
    }

    // System prompt por MODO DA SESSÃO (SCRUM-153). 'melhoria' roda a V6 (sucedeu a V5 em 31/07)
    // com a persona atual + rótulos dos campos já configurados no contexto; qualquer outro valor
    // (inclusive estado antigo sem o campo) roda a V4 — o caminho de criação-do-zero, INALTERADO.
    const systemPrompt = emMelhoria
      ? metaEntrevistador.buildMelhoriaSystemPrompt({
          nomeNegocio: state.nomeNegocio,
          area: state.area || 'atendimento',
          modo: state.modo,
          personaAtual: state.personaAtual ?? '',
          camposConfigurados: state.camposConfigurados ?? [],
        })
      : metaEntrevistador.buildEntrevistadorSystemPrompt({
          nomeNegocio: state.nomeNegocio,
          area: state.area || 'atendimento',
          modo: state.modo,
        });
    const history: ChatTurn[] = state.turns
      .slice(-config.PROMPT_BUILDER_HISTORY_TURNS)
      .map(toChatTurn);

    const startedAt = Date.now();
    let replyText = FALLBACK_REPLY;
    let draftReady = state.draft !== null;
    try {
      const result = await withTimeout(
        openai.runAgent({
          systemPrompt, // FIXO no servidor; input do cliente vai como userMessage (role:user)
          history,
          userMessage,
          tools: [proporPromptTool],
          maxTurns: config.PROMPT_BUILDER_MAX_AGENT_TURNS,
          model: config.PROMPT_BUILDER_MODEL, // FORÇA gpt-4o (não herda bot_config do clone)
          temperature: config.PROMPT_BUILDER_TEMPERATURE,
          maxToolResultChars: 200,
          apiKey: config.OPENAI_API_KEY, // provider OpenAI; sem baseURL = endpoint default OpenAI
          // "gerar agora": obriga o modelo a chamar propor_prompt neste turno. Ausente no fluxo
          // normal (o modelo decide) — byte-a-byte pro caminho de entrevista comum.
          ...(forceGenerate
            ? { toolChoice: { forceFunction: metaEntrevistador.PROPOR_PROMPT_TOOL_NAME } }
            : {}),
        }),
        config.PROMPT_BUILDER_LLM_TIMEOUT_MS,
      );
      replyText = result.reply || FALLBACK_REPLY;

      // Captura da persona proposta: última chamada da tool propor_prompt.
      const calls = result.toolCalls.filter(
        (c) => c.name === metaEntrevistador.PROPOR_PROMPT_TOOL_NAME,
      );
      const lastCall = calls[calls.length - 1];
      if (lastCall) {
        const argsParsed = proporPromptArgsSchema.safeParse(lastCall.args);
        if (argsParsed.success) {
          const servicos = (await loadCloneContext(slot))?.servicos ?? [];
          const v = await validatePersonaComClassificacaoDeMoeda(
            stripPII(argsParsed.data.persona_prompt),
            { servicos },
          );
          // GUARDA DE PRESERVAÇÃO (SCRUM-153, só no modo melhoria): o approve SOBRESCREVE o
          // bot_prompt inteiro, então uma proposta que voltou pela metade faz o dono PERDER
          // texto que ele não pediu pra remover (regra de negócio 27). Se encolheu demais E ele
          // não pediu reescrita explícita nesta conversa, NÃO promovemos a rascunho: avisamos e
          // deixamos ele escolher. O draft anterior (se houver) fica intacto.
          const preserv = emMelhoria
            ? avaliarPreservacao(state.personaAtual ?? '', v.cleaned, reescritaPedida)
            : { ok: true, ratio: 1 };
          if (v.ok && preserv.ok) {
            state.draft = {
              persona: v.cleaned,
              nome_do_bot: argsParsed.data.nome_do_bot ?? null,
              resumo: argsParsed.data.resumo,
            };
            draftReady = true;
          } else if (v.ok && !preserv.ok) {
            // Observabilidade: só a RAZÃO de tamanho, nunca o texto (persona é durável/PII).
            log.warn(
              { slot, ratio: preserv.ratio },
              'prompt-builder melhoria: proposta encolheu demais — rascunho NÃO promovido',
            );
            draftReady = state.draft !== null;
            replyText =
              'Segurei essa versão: ela ficou bem menor que a persona que está no ar, e eu não ' +
              'quero apagar o que você já tinha. Quer que eu refaça mantendo o texto atual e só ' +
              'aplicando a mudança? Se preferir mesmo começar do zero, é só dizer "refaz tudo".';
          } else {
            // Refino que não passou na validação NÃO destrói um draft anterior já aprovável:
            // preserva o corrente e sinaliza draft_ready pelo que REALMENTE existe. Antes zerava
            // state.draft e o dono perdia o esboço bom (SCRUM-92 bug 1). Observabilidade: só tags
            // (ex.: 'moeda'/'horario') + tamanho — NUNCA o texto da persona (PII/durável).
            log.warn(
              { slot, removedTags: v.removedTags, cleanedLen: v.cleaned.length },
              'prompt-builder: persona rejeitada pelo validador',
            );
            draftReady = state.draft !== null;
            replyText = draftReady
              ? 'Não consegui aplicar esse ajuste, mas o texto anterior segue disponível pra você ' +
                'aprovar. Quer descrever a mudança de outro jeito?'
              : 'Consegui um esboço, mas preciso de mais alguns detalhes sobre o jeito de atender ' +
                'do seu negócio para deixar a persona completa. Pode me contar um pouco mais?';
          }
        } else {
          // A tool foi chamada mas os args não passaram no NOSSO Zod (o schema declarado ao modelo
          // não é confiável). Sem draft novo persistido -> NUNCA sinalizar prévia pronta; pede mais
          // um detalhe. Preserva um draft anterior, se houver (SCRUM-92 bug 3).
          log.warn(
            { slot, issues: argsParsed.error.issues.length },
            'prompt-builder: args da tool propor_prompt inválidos',
          );
          draftReady = state.draft !== null;
          replyText =
            'Quase lá! Me dá mais um detalhe sobre o jeito de atender do seu negócio pra eu ' +
            'finalizar a persona?';
        }
      }

      log.info(
        {
          slot,
          turns: userTurns + 1,
          draftReady,
          forceGenerate,
          sessaoModo: state.sessaoModo ?? 'criacao',
          reescritaPedida,
          tokens: result.usage.total,
          latencyMs: Date.now() - startedAt,
        },
        'prompt-builder turn ok',
      );
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      log.warn({ slot, err, latencyMs: Date.now() - startedAt }, 'prompt-builder turn falhou');
      // Fallback amigável; persiste o turno pra conversa seguir coerente (draft intacto).
    }

    state.turns.push({ role: 'user', content: userMessage });
    state.turns.push({ role: 'assistant', content: replyText });
    if (state.turns.length > MAX_STORED_TURNS) {
      state.turns = state.turns.slice(-MAX_STORED_TURNS);
    }
    await saveState(redis, state);

    // PREVIEW VIVO (31/07, ordem do Bruno): o rascunho corrente volta em TODO turno em que ele
    // EXISTA — antes o texto só saía num GET /draft separado e o dono conversava às cegas (a tela
    // precisava de scrollIntoView e o próprio prompt mandava "role a tela para baixo"). O custo
    // extra de token por turno foi aprovado por ele.
    //   persona_rascunho: a persona proposta (JÁ validada/limpa), sem o bloco estrutural.
    //   persona_base:     no modo MELHORIA, a persona que está NO AR (lado esquerdo do diff).
    // Contrato: os DOIS são string|null, NUNCA undefined (ver previewFields). `preview_final`
    // fica só no GET /draft (S1: ninguém consome no /message). `resumo`/`nome_do_bot` seguem
    // como estavam (undefined sem draft) pra não quebrar a UI atual.
    // ⚠️ previewFields lê `state.draft`, que só recebe proposta APROVADA pelo validador E pela
    // guarda de preservação — proposta barrada nunca vaza pro preview (regra de negócio 27).
    // NUNCA devolve o system prompt aqui.
    return reply.code(200).send({
      reply: replyText,
      draft_ready: draftReady,
      resumo: draftReady ? state.draft?.resumo : undefined,
      nome_do_bot: draftReady ? state.draft?.nome_do_bot : undefined,
      ...previewFields(),
    });
  });

  // ── GET /draft ────────────────────────────────────────────────────────────
  app.get('/portal/prompt-builder/draft', { preHandler: withTenant }, async (req, reply) => {
    if (!config.PROMPT_BUILDER_ENABLED)
      return reply.code(404).send({ error: 'recurso_indisponivel' });
    const { slot } = requireTenant(req);
    const state = await getState(getRedis(), slot);
    if (!state) {
      return reply
        .code(200)
        .send({ status: 'nao_iniciado', persona_rascunho: null, preview_final: null });
    }
    if (!state.draft) {
      return reply
        .code(200)
        .send({ status: 'sem_rascunho', persona_rascunho: null, preview_final: null });
    }
    return reply.code(200).send({
      status: 'pronto',
      persona_rascunho: state.draft.persona,
      nome_do_bot: state.draft.nome_do_bot,
      resumo: state.draft.resumo,
      preview_final: buildPreviewFinal(state),
    });
  });

  // ── POST /approve ────────────────────────────────────────────────────────────
  app.post('/portal/prompt-builder/approve', { preHandler: withTenant }, async (req, reply) => {
    if (!config.PROMPT_BUILDER_ENABLED)
      return reply.code(404).send({ error: 'recurso_indisponivel' });
    const { slot, username } = requireTenant(req);

    // Body sem campos — ver nota no schema acima. Client antigo mandando `persona_editada`
    // (ou qualquer outro campo) recebe 400 aqui, antes de tocar em Redis/DB.
    const parsedBody = approveBodySchema.safeParse(req.body ?? {});
    if (!parsedBody.success) return reply.code(400).send({ error: 'dados_invalidos' });

    const redis = getRedis();
    const state = await getState(redis, slot);
    if (!state || !state.draft) return reply.code(409).send({ error: 'sem_rascunho' });

    // Contexto FRESCO do clone (NÃO o cacheado no /start): serviços + modo/área ATUAIS.
    // Se o clone trocou de modo (atendente↔agenda) entre iniciar e aprovar, o bloco tem que
    // refletir o modo de AGORA — senão colaria a variante errada (ex.: bloco de atendente, sem
    // cartão/SIM, num clone que virou agenda), enfraquecendo a garantia (F1, security).
    // SCRUM-143: o reader interno é fail-CLOSED (failClosed:true) — num erro de DB ele RELANÇA e
    // aqui viramos 503 SEM tocar em nada. Fail-closed: melhor recusar o approve do que flipar um
    // clone prompt_custom=true pra runtime com estado indeterminado. (ctx=null = clone sumiu no
    // meio, caminho SOFT já tratado abaixo com fallback ao state — só o THROW vira 503.)
    let ctx: Awaited<ReturnType<typeof loadCloneContext>>;
    try {
      ctx = await loadCloneContext(slot);
    } catch (err) {
      log.error(
        { slot, err: err instanceof Error ? err.message : 'unknown' },
        'approve bloqueado: contexto do clone indeterminado (fail-closed, SCRUM-143)',
      );
      return reply.code(503).send({ error: 'estado_indeterminado' });
    }
    const servicos = ctx?.servicos ?? [];
    const modo = ctx?.modo ?? state.modo; // fallback ao state só se o clone sumiu no meio.
    const area = ctx?.area ?? state.area;
    const productType = ctx?.productType ?? state.productType ?? 'individual';

    // Persona a persistir: SEMPRE o rascunho gerado pela IA (state.draft.persona) — não existe
    // mais caminho de edição manual. Passa pelo MESMO pipeline de sempre (stripPII +
    // validatePersona) como defesa em profundidade (nunca confia cru nem no que veio do Redis).
    // O BLOCO_ESTRUTURAL vem por código depois.
    // ⚠️ ANTI-REFACTOR (ordem do Bruno 31/07): NÃO reintroduzir edição manual da persona aqui.
    // O motivo é comportamental, não técnico — o dono editando à mão conseguia colar horário de
    // funcionamento, endereço, preço etc. (dado operacional que JÁ existe personalizado em outra
    // tela do portal) e o `validatePersona` (regex) deixava passar frases como "de segunda a
    // sexta pela manhã" ou "o corte sai quarenta reais" sem avisar — apagava em silêncio ou
    // persistia divergente do resto do sistema. Só a IA escreve a persona; quem quer mudar,
    // conversa com ela (ela recusa dado operacional e manda pra tela própria).
    const v = await validatePersonaComClassificacaoDeMoeda(stripPII(state.draft.persona), {
      servicos,
    });
    if (!v.ok) return reply.code(422).send({ error: 'rascunho_insuficiente' });

    // Nome do ASSISTENTE = campo de 1ª classe, SEPARADO do nome do negócio (decisão de produto).
    // Capturado na entrevista; persistido em personalizacao.nome_assistente pra não ser jogado fora
    // (era dead-end: exibido e nunca salvo). Consumo pelo runtime = increment 2/ADR 0032. SCRUM-92 (bug 5).
    const nomeAssistente = state.draft.nome_do_bot?.trim() || null;

    // GARANTIA: a mecânica de agendamento (cartão + SIM) NUNCA vem da IA — entra por CÓDIGO.
    // Estabelecimento (agenda multi-profissional) usa a variante com 👤 PROFISSIONAL.
    const blocoModo = deriveBlocoModo(productType, modo);

    // ── Cartão BAKED vs RUNTIME (SCRUM-92 inc.2 / ADR 0032) — gate CARTAO_RUNTIME_ENABLED ──
    // OFF (default): cola o BLOCO_ESTRUTURAL na persona (cartão baked no bot_prompt) — comportamento
    //   atual byte-a-byte. cartao_mode fica 'baked'.
    // ON: a persona nasce PERSONA-ONLY (SEM o bloco) e o clone vira cartao_mode='runtime' na MESMA
    //   transação (applyGeneratedPrompt). O cartão passa a ser injetado por código em runtime
    //   (buildCartaoRuntimeBlock). Como a persona é FRESCA (nunca teve cartão), não há cartão duplo;
    //   o guard bakedMarker no data layer prova isso (aborta se o cartão vazar pro finalPrompt).
    //
    // RAIZ #2 (SCRUM-92, incidente Ingrid): mesmo com a flag GLOBAL OFF, se o clone JÁ é
    // cartao_mode='runtime' (ex.: migrado à mão), o approve NUNCA pode assar o bloco no bot_prompt
    // — o runtime injeta o cartão e teríamos CARTÃO-DUPLO. Runtime quando a flag global liga (clones
    // novos) OU o clone já está em runtime (preserva o modo, nunca REGRIDE pra baked).
    //
    // SCRUM-155 (caso Meduzza): o conceito "cartão em runtime/baked" só existe pros modos que TÊM
    // cartão de agendamento (agenda/estabelecimento) — blocoModo==='atendente' NUNCA teve, NUNCA
    // terá cartão (é pré-venda pura, escala pra humano). ⚠️ CUIDADO: buildBlocoEstrutural({modo:
    // 'atendente'}) AINDA contém BLOCO_ESTRUTURAL_MARKER — o marcador é o HEADER genérico
    // ('===== REGRAS DO SISTEMA...'), COMPARTILHADO pelas 3 variantes (agenda/estabelecimento/
    // atendente); ele não distingue "tem cartão" de "não tem". A proteção real NÃO é "o atendente
    // não tem o marcador" — é que, com cartaoRuntime=false, applyGeneratedPrompt() abaixo NUNCA
    // recebe opts.bakedMarker (só vai quando cartaoRuntime é true), então o BELT GUARD de
    // bot-prompt.ts (que rejeita finalPrompt contendo o marker quando cartaoMode='runtime') nunca
    // é sequer avaliado pro atendente. Pra um clone atendente, "flipar cartao_mode" não tem
    // sentido: não há cartão pra tirar do bot_prompt nem pra passar a injetar em runtime. Por isso
    // o cálculo de cartaoRuntime (e o guard abaixo) SÓ se aplica quando blocoModo !== 'atendente'
    // — nem toca a flag global, nem herda cartaoMode='runtime' antigo de uma migração de formato
    // anterior (agenda->atendente), que já teria zerado o bloco de qualquer forma (finalPrompt é
    // sempre regerado do zero pelo approve, nunca preserva cartão residual).
    // ⚠️ NÃO "consertar" isso passando bakedMarker incondicionalmente pro atendente também — o
    // BLOCO_ATENDENTE contém o HEADER (=marker) e o guard de bot-prompt.ts faria o approve
    // LANÇAR (throw) pra TODO clone atendente, sempre. A proteção mora na estrutura do IF acima
    // (cartaoRuntime=false ⇒ bakedMarker nunca é passado), não em o marcador estar ausente do texto.
    const cartaoRuntime =
      blocoModo !== 'atendente' && (config.CARTAO_RUNTIME_ENABLED || ctx?.cartaoMode === 'runtime');

    // INVARIANTE anti-cartão-duplo (SCRUM-120): MESMO guard do endpoint PUT /portal/cartao-config
    // (isCartaoRuntimeFlipBlocked, fonte única). Se o approve FLIPARIA pra runtime (cartaoRuntime)
    // um clone que é persona à mão (prompt_custom=true) AINDA baked, bloqueia com 409 — NÃO depende
    // do bakedMarker (heurística). Foi por aqui que o clone da Ingrid virou runtime (prompt_custom
    // baked + flag ON setava cartao_mode='runtime' na transação). Clone já-runtime e template
    // (prompt_custom=false) NÃO são bloqueados. O draft do Redis fica intacto (nada é perdido).
    // blocoModo==='atendente' NUNCA cai aqui (cartaoRuntime já é false acima) — elimina a CLASSE
    // do bug SCRUM-155 (não só a Meduzza): todo clone atendente self-service futuro com
    // prompt_custom=true segue liberado, sem depender de product_type.
    if (
      cartaoRuntime &&
      promptBuilder.isCartaoRuntimeFlipBlocked({
        promptCustom: ctx?.promptCustom ?? false,
        cartaoMode: ctx?.cartaoMode ?? 'baked',
      })
    ) {
      log.warn(
        { slot },
        'approve bloqueado: prompt_custom baked não pode flipar pra cartao_mode=runtime (SCRUM-120)',
      );
      return reply.code(409).send({ error: 'cartao_bloqueado', reason: 'prompt_custom' });
    }

    const bloco = cartaoRuntime
      ? ''
      : promptBuilder.buildBlocoEstrutural({ modo: blocoModo, area });
    const finalPrompt = sanitizeOrphanPlaceholders(
      cartaoRuntime ? v.cleaned : `${v.cleaned}\n\n${bloco}`,
    );
    if (finalPrompt.length > MAX_FINAL_PROMPT_CHARS) {
      return reply.code(422).send({ error: 'prompt_muito_longo' });
    }

    try {
      const result = await botPrompt.applyGeneratedPrompt(
        slot,
        finalPrompt,
        `portal:builder:${username}`,
        'prompt-builder',
        cartaoRuntime
          ? { cartaoMode: 'runtime', bakedMarker: promptBuilder.BLOCO_ESTRUTURAL_MARKER }
          : {},
      );

      // Best-effort: persistir o nome do assistente NÃO pode derrubar o approve (o prompt já foi
      // aplicado na transação acima). applyGeneratedPrompt já setou prompt_custom=true, então o
      // updateClone abaixo NÃO re-renderiza o bot_prompt (guard SCRUM-59/83) — só faz merge da chave
      // no personalizacao (sem clobber das outras chaves). SCRUM-92 (bug 5).
      if (nomeAssistente) {
        try {
          const cloneFull = await flowClones.getCloneBySlot(slot);
          if (cloneFull) {
            await flowClones.updateClone(cloneFull.id, {
              personalizacao: { ...cloneFull.personalizacao, nome_assistente: nomeAssistente },
            });
          }
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          log.warn(
            { slot, err },
            'prompt-builder: falha ao persistir nome_assistente (approve seguiu)',
          );
        }
      }

      await deleteState(redis, slot);
      log.info(
        {
          slot,
          versionSaved: result.version_saved,
          modo,
          blocoModo,
          cartaoRuntime,
          cartaoModeAtual: ctx?.cartaoMode,
          sessaoModo: state.sessaoModo ?? 'criacao',
          reescritaExplicita: state.reescritaExplicita === true,
        },
        'prompt-builder: persona aplicada (prompt_custom=true)',
      );
      return reply
        .code(200)
        .send({ ok: true, persona_aplicada: true, version_saved: result.version_saved });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      log.error({ slot, err }, 'prompt-builder approve falhou (transação)');
      return reply.code(500).send({ error: 'falha_ao_salvar' });
    }
  });

  // ── POST /reset (increment) ────────────────────────────────────────────────
  app.post('/portal/prompt-builder/reset', { preHandler: withTenant }, async (req, reply) => {
    if (!config.PROMPT_BUILDER_ENABLED)
      return reply.code(404).send({ error: 'recurso_indisponivel' });
    const { slot } = requireTenant(req);
    await deleteState(getRedis(), slot);
    return reply.code(200).send({ ok: true });
  });
};
