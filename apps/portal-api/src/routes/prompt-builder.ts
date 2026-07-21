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
 *   POST /portal/prompt-builder/approve  -> persiste (transação SCRUM-83) + prompt_custom=true
 *   POST /portal/prompt-builder/reset    -> recomeça do zero (increment)
 *
 * GARANTIA INEGOCIÁVEL: o meta-agente gera SÓ a persona; a mecânica de agendamento (cartão +
 * exigir SIM antes de inserir_agendamento) é o BLOCO_ESTRUTURAL colado pelo SERVIDOR no approve
 * — a IA nunca a escreve, então nunca pode removê-la. Validador determinístico limpa dados
 * operacionais/PII/tokens estruturais ANTES de persistir.
 *
 * Meta-agente roda SEMPRE no DeepSeek (deepseek-chat) — NÃO herda bot_config do clone.
 * Estado da entrevista é efêmero no Redis (TTL). Guardas de custo/abuso no Redis (fail-closed).
 * LGPD: NUNCA loga conteúdo da conversa nem a persona — só slot, tokens, latency, blocked_reason.
 */
import { logger } from '@startap/core/logger';
import type { ChatTurn } from '@startap/db';
import { botPrompt, cloneColaboradores, flowClones } from '@startap/db';
import { metaEntrevistador, openai, promptBuilder } from '@startap/integrations';
import type { ToolDefinition } from '@startap/integrations/openai';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { PROMPT_BUILDER_CANNED, reserveMessageBudget } from '../lib/prompt-builder-guards.js';
import {
  type PromptBuilderState,
  deleteState,
  getState,
  saveState,
} from '../lib/prompt-builder-state.js';
import {
  MAX_FINAL_PROMPT_CHARS,
  sanitizeOrphanPlaceholders,
  stripPII,
  validatePersona,
} from '../lib/prompt-builder-validator.js';
import { getRedis } from '../lib/session.js';
import { requireTenant, withTenant } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'prompt-builder' });

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
const FALLBACK_REPLY = 'Tive um soluço aqui :) Pode mandar de novo?';
/** Teto defensivo de turns guardados no estado (history enviada ao modelo é bem menor). */
const MAX_STORED_TURNS = 80;

// Body do /message: .strict() => campo desconhecido = 400 (anti mass-assignment). `role` só pode
// ser 'user' (o system prompt é FIXO no servidor; o cliente NUNCA injeta system/assistant).
const messageSchema = z
  .object({
    content: z.string().min(1).max(config.PROMPT_BUILDER_MAX_INPUT_CHARS),
    role: z.literal('user').optional(),
  })
  .strict();

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

/** Sanitiza o texto do dono antes de virar role:user (strip {{ }} + colapsa quebras + trunca). */
function sanitizeInput(raw: string): string {
  const stripped = raw
    .replace(/\{\{|\}\}/g, '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  const max = config.PROMPT_BUILDER_MAX_INPUT_CHARS;
  return stripped.length > max ? stripped.slice(0, max) : stripped;
}

/** Resolve o contexto do clone (nome/área/modo) da sessão — NUNCA de input. */
async function loadCloneContext(slot: string): Promise<{
  nomeNegocio: string;
  area: string;
  modo: 'agenda' | 'atendente';
  servicos: string[];
} | null> {
  const clone = await flowClones.getCloneBySlot(slot);
  if (!clone) return null;
  const { area } = await cloneColaboradores.getAreaAndPromptCustom(slot);
  const modoAtendente = await flowClones.resolveModoAtendenteEnabledForSlot(
    slot,
    config.MODO_ATENDENTE_SLOTS,
  );
  const nomeNegocio = clone.display_name?.trim() || clone.cliente_nome?.trim() || 'seu negócio';
  const servicos = (clone.servicos ?? []).map((s) => s.nome).filter((n) => typeof n === 'string');
  return { nomeNegocio, area: area ?? '', modo: modoAtendente ? 'atendente' : 'agenda', servicos };
}

/** ChatTurn do agente a partir do turno guardado (user->human, assistant->ai). */
function toChatTurn(t: { role: 'user' | 'assistant'; content: string }): ChatTurn {
  return { role: t.role === 'user' ? 'human' : 'ai', content: t.content };
}

/** Prévia read-only do que SERÁ persistido: persona + bloco estrutural colado por código. */
function buildPreviewFinal(state: PromptBuilderState): string | null {
  if (!state.draft) return null;
  const bloco = promptBuilder.buildBlocoEstrutural({ modo: state.modo, area: state.area });
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
      // Idempotente: entrevista viva -> devolve a corrente (não recomeça sem reset).
      const abertura = existing.turns.find((t) => t.role === 'assistant')?.content ?? '';
      return reply.code(200).send({
        session_id: slot,
        pergunta: abertura,
        draft_ready: existing.draft !== null,
        retomada: true,
      });
    }

    const ctx = await loadCloneContext(slot);
    if (!ctx) return reply.code(404).send({ error: 'clone_nao_encontrado' });

    const pergunta = metaEntrevistador.primeiraPergunta({
      nomeNegocio: ctx.nomeNegocio,
      area: ctx.area || 'atendimento',
      modo: ctx.modo,
    });
    const state: PromptBuilderState = {
      slot,
      nomeNegocio: ctx.nomeNegocio,
      area: ctx.area,
      modo: ctx.modo,
      turns: [{ role: 'assistant', content: pergunta }],
      draft: null,
      updatedAt: Date.now(),
    };
    await saveState(redis, state);
    log.info({ slot, modo: ctx.modo }, 'prompt-builder: entrevista iniciada');
    return reply
      .code(200)
      .send({ session_id: slot, pergunta, draft_ready: false, retomada: false });
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

    // 1. teto de turns por entrevista (corta loop de refino infinito) — sem chamar o LLM.
    const userTurns = state.turns.filter((t) => t.role === 'user').length;
    if (userTurns >= config.PROMPT_BUILDER_MAX_TURNS) {
      return reply
        .code(200)
        .send({ reply: PROMPT_BUILDER_CANNED.turns_entrevista, draft_ready: state.draft !== null });
    }

    // 2+3. orçamento por tenant/dia + cap global (kill-switch), ANTES do custo de LLM.
    const budget = await reserveMessageBudget(redis, slot);
    if (!budget.ok) {
      log.info({ slot, blocked: budget.reason }, 'prompt-builder bloqueado (guarda de custo)');
      const canned = PROMPT_BUILDER_CANNED[budget.reason ?? 'cap_global_diario'];
      return reply.code(200).send({ reply: canned, draft_ready: state.draft !== null });
    }

    // Provider DeepSeek: chave validada LAZY (boot nunca crasha sem ela).
    if (!config.DEEPSEEK_API_KEY) {
      log.error('prompt-builder sem DEEPSEEK_API_KEY provisionada — feature indisponível');
      return reply.code(503).send({ error: 'builder_indisponivel' });
    }

    const userMessage = sanitizeInput(parsed.data.content);
    if (!userMessage) return reply.code(400).send({ error: 'mensagem_vazia' });

    const systemPrompt = metaEntrevistador.buildEntrevistadorSystemPrompt({
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
          model: config.PROMPT_BUILDER_MODEL, // FORÇA deepseek-chat (não herda bot_config)
          temperature: config.PROMPT_BUILDER_TEMPERATURE,
          maxToolResultChars: 200,
          apiKey: config.DEEPSEEK_API_KEY,
          baseURL: DEEPSEEK_BASE_URL, // FORÇA provider DeepSeek
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
          const v = validatePersona(stripPII(argsParsed.data.persona_prompt), { servicos });
          if (v.ok) {
            state.draft = {
              persona: v.cleaned,
              nome_do_bot: argsParsed.data.nome_do_bot ?? null,
              resumo: argsParsed.data.resumo,
            };
            draftReady = true;
          } else {
            // Sobrou pouco após limpar dados operacionais -> pede mais detalhes (sem quebrar).
            state.draft = null;
            draftReady = false;
            replyText =
              'Consegui um esboço, mas preciso de mais uns detalhes do jeito de vocês pra ' +
              'deixar a persona completa. Pode me contar um pouco mais?';
          }
        }
      }

      log.info(
        {
          slot,
          turns: userTurns + 1,
          draftReady,
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

    // NUNCA devolve o system prompt nem a persona crua aqui (só sinal + resumo). Preview via GET.
    return reply.code(200).send({
      reply: replyText,
      draft_ready: draftReady,
      resumo: draftReady ? state.draft?.resumo : undefined,
      nome_do_bot: draftReady ? state.draft?.nome_do_bot : undefined,
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
    const redis = getRedis();
    const state = await getState(redis, slot);
    if (!state || !state.draft) return reply.code(409).send({ error: 'sem_rascunho' });

    // Contexto FRESCO do clone (NÃO o cacheado no /start): serviços + modo/área ATUAIS.
    // Se o clone trocou de modo (atendente↔agenda) entre iniciar e aprovar, o bloco tem que
    // refletir o modo de AGORA — senão colaria a variante errada (ex.: bloco de atendente, sem
    // cartão/SIM, num clone que virou agenda), enfraquecendo a garantia (F1, security).
    const ctx = await loadCloneContext(slot);
    const servicos = ctx?.servicos ?? [];
    const modo = ctx?.modo ?? state.modo; // fallback ao state só se o clone sumiu no meio.
    const area = ctx?.area ?? state.area;

    // Re-valida a persona server-side (defesa em profundidade — nunca confia no draft do Redis).
    const v = validatePersona(stripPII(state.draft.persona), { servicos });
    if (!v.ok) return reply.code(422).send({ error: 'rascunho_insuficiente' });

    // GARANTIA: cola o BLOCO_ESTRUTURAL (cartão + SIM) DEPOIS da persona, no SERVIDOR.
    const bloco = promptBuilder.buildBlocoEstrutural({ modo, area });
    const finalPrompt = sanitizeOrphanPlaceholders(`${v.cleaned}\n\n${bloco}`);
    if (finalPrompt.length > MAX_FINAL_PROMPT_CHARS) {
      return reply.code(422).send({ error: 'prompt_muito_longo' });
    }

    try {
      const result = await botPrompt.applyGeneratedPrompt(
        slot,
        finalPrompt,
        `portal:builder:${username}`,
      );
      await deleteState(redis, slot);
      log.info(
        { slot, versionSaved: result.version_saved, modo },
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
