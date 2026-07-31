/**
 * "Testar conversa" — SANDBOX da persona REAL do clone no portal (SCRUM-101).
 *
 *   GET  /portal/sandbox/status  -> a UI se auto-gateia (404 = flag OFF); reporta se há persona
 *   POST /portal/sandbox/chat    -> 1 turno de conversa com o assistente do PRÓPRIO clone
 *
 * O DONO logado conversa com o assistente dele rodando a PERSONA (bot_prompt), o TOM
 * (bot_config.temperature) e o CARTÃO (cartao_config) REAIS do clone — mas em SANDBOX:
 *
 *  ── GARANTIA DE ZERO EFEITO COLATERAL (requisito duro do card) ──────────────────────
 *  O runtime real do bot (apps/api/src/bots/teste_barbearia.ts) registra tools de ESCRITA
 *  — inserir_agendamento (GCal), escalar_para_humano/escalar_cancelamento (pausa+DB),
 *  registrar_interesse (DB). NENHUMA delas é importada aqui: este módulo vive no portal-api
 *  e NÃO tem acesso a elas. Além disso chamamos openai.runAgent com `tools: []` — array
 *  VAZIO, nenhuma função ofertada ao modelo (o loop de tool nem liga). Logo o modelo NÃO
 *  PODE agendar, pausar, escalar nem gravar nada, e nada sai por WAHA. É read-only POR
 *  CONSTRUÇÃO, não por mock. Também NÃO usamos runAgentConfigured (que faz INSERT em
 *  model_usage) — zero escrita em DB, nem de telemetria.
 *
 *  ── ISOLAMENTO MULTI-TENANT ─────────────────────────────────────────────────────────
 *  Toda leitura é escopada pelo slot de requireTenant(req) (withTenant), derivado da SESSÃO —
 *  NUNCA de body/query/params. O body é .strict(): um campo `slot` no payload = 400. O dono
 *  só consegue testar o PRÓPRIO clone.
 *
 *  ── CUSTO DE LLM CONTROLADO ─────────────────────────────────────────────────────────
 *  Zod limita nº de mensagens e chars; teto de turns por sessão + orçamento tenant/dia + cap
 *  global (Redis, fail-closed) cortam ANTES do LLM; histórico enviado é aparado; maxTurns:1.
 *
 * ── CONTEXTO REAL, MENOS A AGENDA (SCRUM-158) ─────────────────────────────────────────
 * O [CONTEXTO] do bot (buildContextBlock: [NEGOCIO]/[OBSERVACOES]/[FAQ]/[FUNCIONAMENTO]/
 * [SERVICOS E PRECOS]) É injetado aqui — mesmo formato do bot real (teste_barbearia). É o
 * que o Bruno pediu: "horários, comportamento, tudo certo" pro dono testar de verdade. O
 * bloco [HORARIOS DISPONIVEIS - ATUALIZADO AGORA] (agenda em tempo real) fica DE FORA por
 * decisão de LGPD INEGOCIÁVEL: ele é calculado a partir dos agendamentos REAIS de clientes
 * finais — expor isso no sandbox vazaria PII de terceiros pro dono só de ele digitar "oi".
 * `agendaFormatada` é opcional em ContextBlockOpts (free-slots.ts) e o bloco só renderiza
 * se ela vier (free-slots.ts:529) — aqui ela nunca é passada. O cliente do bloco [DADOS DO
 * CLIENTE] é sempre FICTÍCIO (nome "Cliente Teste", tel +5511900000000) — nunca derivado da
 * sessão/request, pra não sugerir que existe um cliente final por trás do teste. O override
 * de emojis do cartão BAKED por área fica de fora (vive no apps/api); pro cartão RUNTIME
 * reproduzimos o bloco real.
 *
 * FLAGS (lição #247 — nada obrigatório no boot): SANDBOX_ENABLED ausente/false -> 404. Sem a
 * chave do provider do clone -> 503 (validação LAZY no uso). LGPD: NUNCA loga o conteúdo da
 * conversa — só slot, turns, tokens, latency, blocked_reason.
 */
import { isAgendaAutomaticaIntent } from '@startap/core';
import { logger } from '@startap/core/logger';
import { botConfig, botPrompt, cloneColaboradores, flowClones } from '@startap/db';
import type { ChatTurn } from '@startap/db';
import { openai } from '@startap/integrations';
import { buildCartaoRuntimeBlock } from '@startap/integrations/prompt-builder';
import { buildContextBlock } from '@startap/integrations/scheduling';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { SANDBOX_CANNED, reserveSandboxBudget } from '../lib/sandbox-guards.js';
import { getRedis } from '../lib/session.js';
import { requireTenant, withTenant } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'sandbox-chat' });

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

/** Resposta defensiva quando o LLM falha/timeout (nunca expõe erro técnico). */
const SANDBOX_FALLBACK_REPLY = 'Tive um soluço aqui :) Pode mandar de novo?';

// Cliente FICTÍCIO do [DADOS DO CLIENTE] injetado pelo buildContextBlock (SCRUM-158).
// NUNCA derivar de req/sessão/dado real — o dono logado testa o próprio bot, não um
// cliente final de verdade. Constantes fixas de propósito (não há PII real envolvida).
const SANDBOX_FAKE_CLIENT_NAME = 'Cliente Teste';
const SANDBOX_FAKE_CLIENT_PHONE = '+5511900000000';

// .strict(): campo desconhecido => 400 (anti mass-assignment; um `slot` no body é REJEITADO —
// o slot vem SÓ da sessão). `role` do cliente só pode ser 'user'|'assistant' (nunca 'system':
// a persona é montada no servidor, o dono não injeta system).
const sandboxMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(config.SANDBOX_MAX_INPUT_CHARS),
});

const sandboxChatSchema = z
  .object({
    messages: z.array(sandboxMessageSchema).min(1).max(60),
  })
  .strict();

/** Mapeia o contrato do front -> ChatTurn do agente (user->human, assistant->ai). */
function toChatTurn(role: 'user' | 'assistant', content: string): ChatTurn {
  return { role: role === 'user' ? 'human' : 'ai', content };
}

/** Sanitiza o texto do dono antes de virar role:user (strip {{ }} + colapsa quebras + trunca). */
function sanitizeInput(raw: string): string {
  const stripped = raw
    .replace(/\{\{|\}\}/g, '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  const max = config.SANDBOX_MAX_INPUT_CHARS;
  return stripped.length > max ? stripped.slice(0, max) : stripped;
}

/** Timeout duro na chamada do modelo (regra 7: nunca aguardar infinito). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('sandbox_llm_timeout')), ms),
    ),
  ]);
}

/** Provider resolvido do clone (para a chamada LLM + a validação lazy da chave). */
interface SandboxProvider {
  model: string;
  temperature: number;
  apiKey: string | undefined;
  baseURL: string | undefined;
}

/**
 * Monta o systemPrompt do SANDBOX a partir do estado REAL do clone (slot da sessão):
 * persona (bot_prompt) + [CONTEXTO] real (negócio/observações/FAQ/funcionamento/serviços,
 * SEM agenda) + cartão em RUNTIME quando aplicável. Espelha a montagem do bot real
 * (teste_barbearia) menos a agenda (ver cabeçalho). Null quando não há persona cadastrada.
 */
async function buildSandboxSystemPrompt(slot: string): Promise<string | null> {
  const persona = await botPrompt.getPrompt(slot);
  if (!persona || persona.trim() === '') return null;

  // Cartão em RUNTIME (SCRUM-92 inc.2 / ADR 0032): só é NÃO-vazio com a flag global ON E o
  // clone em cartao_mode='runtime'. Clone BAKED -> o cartão já vive dentro da persona (bot_prompt),
  // então não há nada a injetar (byte-a-byte com o que o dono já tem).
  const { area, cartaoMode, cartaoConfig, nomeNegocio } =
    await cloneColaboradores.getAreaPromptCustomCartao(slot);

  // Fuso do clone (migration 068) — só pro cálculo de [DATA ATUAL], DEFAULT São Paulo quando
  // o clone não existir/não tiver fuso (mesma leitura cacheada usada pelo cartão runtime abaixo).
  const clone = await flowClones.getCloneBySlot(slot);
  const cloneTz = clone?.timezone ?? 'America/Sao_Paulo';
  const now = new Date();
  const dataAtual = now.toLocaleDateString('pt-BR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: cloneTz,
  });

  // [CONTEXTO] real do clone MENOS a agenda (ver cabeçalho — LGPD, agendamentos de clientes
  // finais nunca entram no sandbox). Cliente FICTÍCIO fixo — nunca da sessão/request.
  const contextBlock = await buildContextBlock({
    slot,
    nomeCliente: SANDBOX_FAKE_CLIENT_NAME,
    telefoneCliente: SANDBOX_FAKE_CLIENT_PHONE,
    dataAtual,
    ano: String(now.getFullYear()),
    // agendaFormatada OMITIDO DE PROPÓSITO: opcional em ContextBlockOpts; o bloco [HORARIOS
    // DISPONIVEIS - ATUALIZADO AGORA] só renderiza se vier (free-slots.ts:529).
    faqSlotsConfig: config.FAQ_PERSONALIZADO_SLOTS,
  });

  let runtimeCartao = '';
  if (config.CARTAO_RUNTIME_ENABLED && cartaoMode === 'runtime') {
    // Modo REAL do runtime (mesma decisão do prompt-builder/loadCloneContext): atendente só
    // quando a flag de atendente está ON E agenda_automatica != true. Estabelecimento em agenda
    // usa a variante com 👤 profissional. Isso evita colar um cartão de agenda num clone atendente.
    const modoAtendenteFlag = await flowClones.resolveModoAtendenteEnabledForSlot(
      slot,
      config.MODO_ATENDENTE_SLOTS,
    );
    const agendaIntent = isAgendaAutomaticaIntent(clone?.personalizacao?.agenda_automatica);
    const atendente = modoAtendenteFlag && !agendaIntent;
    const productType = await cloneColaboradores.getProductType(slot);
    const blocoModo: 'agenda' | 'atendente' | 'estabelecimento' = atendente
      ? 'atendente'
      : productType === 'estabelecimento'
        ? 'estabelecimento'
        : 'agenda';
    runtimeCartao = buildCartaoRuntimeBlock({
      modo: blocoModo,
      area,
      config: cartaoConfig,
      nomeNegocio: nomeNegocio ?? undefined,
    });
  }

  return [persona, contextBlock, runtimeCartao].filter((b) => b !== '').join('\n\n');
}

/**
 * Resolve provider/model/tom REAIS do clone (bot_config). NÃO loga uso (nenhuma escrita em DB).
 * Null quando o clone não tem bot_config/model — trata como "não configurado" (409).
 */
async function resolveSandboxProvider(slot: string): Promise<SandboxProvider | null> {
  const cfg = await botConfig.getConfig(slot);
  if (!cfg || !cfg.model || cfg.model.trim() === '') return null;
  if (cfg.provider === 'deepseek') {
    return {
      model: cfg.model,
      temperature: cfg.temperature,
      apiKey: config.DEEPSEEK_API_KEY,
      baseURL: DEEPSEEK_BASE_URL,
    };
  }
  // OpenAI (default): sem baseURL. A chave da stack OpenAI do portal-api.
  return {
    model: cfg.model,
    temperature: cfg.temperature,
    apiKey: config.OPENAI_API_KEY,
    baseURL: undefined,
  };
}

export const sandboxChatRoutes: FastifyPluginAsync = async (app) => {
  // ── GET /status ───────────────────────────────────────────────────────────────
  // Auto-gate da UI (mesmo padrão de prompt-builder/lembretes): flag OFF -> 404 -> a seção some
  // sem flash. `persona_configurada` deixa a UI mostrar "configure a persona antes" em vez de erro.
  app.get('/portal/sandbox/status', { preHandler: withTenant }, async (req, reply) => {
    if (!config.SANDBOX_ENABLED) return reply.code(404).send({ error: 'recurso_indisponivel' });
    const { slot } = requireTenant(req);
    const persona = await botPrompt.getPrompt(slot).catch(() => null);
    return reply.code(200).send({
      available: true,
      persona_configurada: !!persona && persona.trim() !== '',
    });
  });

  // ── POST /chat ────────────────────────────────────────────────────────────────
  app.post('/portal/sandbox/chat', { preHandler: withTenant }, async (req, reply) => {
    if (!config.SANDBOX_ENABLED) return reply.code(404).send({ error: 'recurso_indisponivel' });
    const { slot } = requireTenant(req);

    const parsed = sandboxChatSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'dados_invalidos' });
    const { messages } = parsed.data;

    // A última mensagem TEM que ser do dono (é o turn a responder).
    const last = messages[messages.length - 1];
    if (last.role !== 'user') {
      return reply.code(400).send({ error: 'ultima_mensagem_deve_ser_do_usuario' });
    }

    // 1. teto de turns por sessão de teste (corta simulação cara) — sem chamar o LLM.
    const userTurns = messages.filter((m) => m.role === 'user').length;
    if (userTurns > config.SANDBOX_MAX_TURNS) {
      return reply.code(200).send({ reply: SANDBOX_CANNED.turns_sessao, simulated: true });
    }

    const redis = getRedis();

    // 2+3. orçamento por tenant/dia + cap global (kill-switch), ANTES do custo de LLM. Fail-closed.
    const budget = await reserveSandboxBudget(redis, slot);
    if (!budget.ok) {
      log.info({ slot, blocked: budget.reason }, 'sandbox bloqueado (guarda de custo)');
      const canned = SANDBOX_CANNED[budget.reason ?? 'cap_global_diario'];
      return reply.code(200).send({ reply: canned, simulated: true });
    }

    // Persona REAL do clone (+ cartão runtime). Sem persona cadastrada -> 409 (a UI orienta a
    // montar o assistente antes de testar). Leitura escopada pelo slot da SESSÃO.
    const systemPrompt = await buildSandboxSystemPrompt(slot);
    if (systemPrompt === null) {
      return reply.code(409).send({ error: 'persona_nao_configurada' });
    }

    // Provider/model/tom REAIS do clone (bot_config). Chave validada LAZY (boot nunca crasha).
    const provider = await resolveSandboxProvider(slot);
    if (!provider) return reply.code(409).send({ error: 'assistente_nao_configurado' });
    if (!provider.apiKey) {
      log.error({ slot }, 'sandbox sem chave do provider provisionada — feature indisponível');
      return reply.code(503).send({ error: 'sandbox_indisponivel' });
    }

    // Sanitiza o input do dono e monta o history (sempre role:user pro turn corrente).
    const userMessage = sanitizeInput(last.content);
    if (!userMessage) return reply.code(400).send({ error: 'mensagem_vazia' });
    const priorTurns = messages.slice(0, -1).slice(-config.SANDBOX_HISTORY_TURNS);
    const history: ChatTurn[] = priorTurns.map((m) => toChatTurn(m.role, sanitizeInput(m.content)));

    const startedAt = Date.now();
    try {
      const result = await withTimeout(
        openai.runAgent({
          systemPrompt, // persona+cartão REAIS do clone (montados no servidor)
          history,
          userMessage,
          // ── ZERO EFEITO COLATERAL: nenhuma tool registrada. As write-tools do bot real NÃO
          //    são alcançáveis aqui — o modelo não pode agendar/pausar/escalar/gravar nada. ──
          tools: [],
          maxTurns: 1,
          model: provider.model, // modelo REAL do clone
          temperature: provider.temperature, // tom REAL do clone (bot_config.temperature)
          maxToolResultChars: 0,
          apiKey: provider.apiKey,
          baseURL: provider.baseURL,
        }),
        config.SANDBOX_LLM_TIMEOUT_MS,
      );

      log.info(
        {
          slot,
          turns: userTurns,
          tokens: result.usage.total,
          latencyMs: Date.now() - startedAt,
        },
        'sandbox turn ok',
      );

      const replyText = result.reply || SANDBOX_FALLBACK_REPLY;
      return reply.code(200).send({ reply: replyText, simulated: true });
    } catch (e) {
      // Timeout/erro do provider: nunca vaza detalhe técnico; devolve fallback amigável.
      // Loga SEM conteúdo nem PII.
      const err = e instanceof Error ? e.message : String(e);
      log.warn({ slot, err, latencyMs: Date.now() - startedAt }, 'sandbox turn falhou (provider)');
      return reply.code(200).send({ reply: SANDBOX_FALLBACK_REPLY, simulated: true });
    }
  });
};
