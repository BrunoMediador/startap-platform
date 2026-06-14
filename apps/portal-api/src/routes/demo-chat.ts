/**
 * POST /demo/chat — demo PÚBLICA e ANÔNIMA de IA na landing (Missão 023 W6).
 *
 * Conversa com IA real (DeepSeek deepseek-chat, sandbox "Studio Alpha") via o SDK
 * existente (openai.runAgent com baseURL DeepSeek). Endpoint próprio, ISOLADO de
 * prod: system prompt FIXO no código, tools:[] (a demo NUNCA agenda), sem
 * bot_config, sem GCal, sem buildContextBlock.
 *
 * Contrato (casa com o frontend W6):
 *   req.body  = { messages: [{ role:'user'|'assistant', content }], session_id? }
 *   resposta  = { reply: string, demo_booking: boolean }
 *     - reply: texto do atendente (ou resposta canned quando uma guarda corta).
 *     - demo_booking: true quando o visitante demonstrou intenção de MARCAR; o
 *       front então exibe o aviso "isto é demonstração" + CTA de cadastro. A IA
 *       NUNCA agenda nada — é só um sinal visual.
 *
 * GUARDAS (endpoint anônimo = maior risco de custo): rate-limit por IP (janela +
 * burst), teto por sessão, hard cap GLOBAL diário, sanitização de input (sempre
 * role:user), anti-vazamento (no prompt). Contadores no Redis — ver demo-guards.ts.
 *
 * FLAGS (lição #247 — nada obrigatório no boot):
 *   - DEMO_ENABLED ausente/false -> 404 (front esconde a demo).
 *   - DEEPSEEK_API_KEY ausente com a flag ON -> 503 (validação LAZY no uso).
 *
 * LGPD: NUNCA loga o conteúdo da conversa nem o IP em claro. Só ip_hash,
 * session_id, turns, blocked_reason, demo_booking, latency_ms, usage.
 *
 * "Agendamento fake": NÃO existe store. A IA não escreve nada; o "cartão marcado"
 * da UI é estado efêmero do front. Os contadores no Redis auto-expiram por TTL
 * nativo (nada a limpar). O cron horário pedido pelo Bruno seria pra limpar um
 * store inexistente -> documentado como desnecessário (no-op), não criado.
 */
import { randomUUID } from 'node:crypto';
import { logger } from '@startap/core/logger';
import type { ChatTurn } from '@startap/db';
import { openai } from '@startap/integrations';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import {
  checkIpAndSession,
  ipHash,
  reserveDailyCall,
  sanitizeDemoInput,
} from '../lib/demo-guards.js';
import { getRedis } from '../lib/session.js';
import { DEMO_CANNED, DEMO_SYSTEM_PROMPT, detectBookingIntent } from './demo-prompt.js';

const log = logger.child({ service: 'portal-api', module: 'demo-chat' });

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

// Resposta defensiva quando o LLM falha/timeout (nunca expõe erro técnico).
const DEMO_FALLBACK_REPLY = 'Tive um soluço aqui :) Pode mandar de novo?';

// .strict(): campo desconhecido => 400 (anti mass-assignment). A demo NÃO aceita
// role 'system' do cliente (anti-injection: o system prompt é fixo no servidor).
const demoMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(4000),
});

const demoChatSchema = z
  .object({
    messages: z.array(demoMessageSchema).min(1).max(40),
    // sessionId opaco do visitante (cookie/efêmero do front). Bounded e
    // sanitizado; ausente => o servidor gera um (mas aí o teto por sessão não
    // persiste entre requests — o front DEVE mandar um id estável).
    session_id: z.string().trim().min(8).max(64).optional(),
  })
  .strict();

/** Mapeia o contrato do front -> ChatTurn do agente (user->human, assistant->ai). */
function toChatTurn(role: 'user' | 'assistant', content: string): ChatTurn {
  return { role: role === 'user' ? 'human' : 'ai', content };
}

/** Timeout duro na chamada do modelo (regra 7: nunca aguardar infinito). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('demo_llm_timeout')), ms)),
  ]);
}

export const demoChatRoutes: FastifyPluginAsync = async (app) => {
  app.post('/demo/chat', async (req, reply) => {
    // ── Flag OFF -> 404 (mesmo padrão de signup/reconexão: front esconde tudo) ──
    if (!config.DEMO_ENABLED) {
      return reply.code(404).send({ error: 'recurso_indisponivel' });
    }

    const parsed = demoChatSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'dados_invalidos' });
    }
    const { messages } = parsed.data;

    // A última mensagem TEM que ser do visitante (é o turn a responder).
    const last = messages[messages.length - 1];
    if (last.role !== 'user') {
      return reply.code(400).send({ error: 'ultima_mensagem_deve_ser_do_usuario' });
    }

    const ipHashed = ipHash(req.ip);
    // session_id: do front (estável) ou gerado (degrada o teto por sessão, mas o
    // rate-limit por IP segura). NUNCA usado pra nada além de chave de contador.
    const sessionId = parsed.data.session_id ?? `anon-${randomUUID()}`;
    const redis = getRedis();

    // ── Guardas 1+2 (IP + sessão), ANTES de qualquer custo de LLM ──────────────
    const guard = await checkIpAndSession(redis, ipHashed, sessionId);
    if (!guard.ok) {
      log.info(
        { ipHash: ipHashed, sessionId, blocked: guard.reason, turns: messages.length },
        'demo bloqueada (guarda IP/sessão)',
      );
      const canned =
        guard.reason === 'session_cap' ? DEMO_CANNED.sessionCap : DEMO_CANNED.rateLimited;
      // 200 com mensagem canned (UX: abuso vira conversão, não erro feio). O front
      // detecta o CTA pela própria copy; sem expor o motivo técnico ao visitante.
      return reply.code(200).send({ reply: canned, demo_booking: false });
    }

    // Sinal de intenção de marcar (determinístico, sem custo) — vai pro front
    // mesmo quando o LLM falha (a resposta canned/fallback ainda carrega o CTA).
    const demoBooking = detectBookingIntent(last.content);

    // ── Guarda 3: hard cap GLOBAL diário (só conta quando o turn VAI chamar o LLM)
    const daily = await reserveDailyCall(redis);
    if (daily.shouldAlert) {
      log.warn(
        { count: daily.count, cap: config.DEMO_DAILY_CALL_CAP },
        'demo: alerta de gasto diário',
      );
    }
    if (!daily.ok) {
      log.warn(
        { ipHash: ipHashed, count: daily.count, cap: config.DEMO_DAILY_CALL_CAP },
        'demo em modo offline (cap diário atingido)',
      );
      return reply.code(200).send({ reply: DEMO_CANNED.dailyCap, demo_booking: demoBooking });
    }

    // ── Provider DeepSeek: chave validada LAZY (boot nunca crasha sem ela) ──────
    if (!config.DEEPSEEK_API_KEY) {
      log.error('demo chamada sem DEEPSEEK_API_KEY provisionada — feature indisponível');
      return reply.code(503).send({ error: 'demo_indisponivel' });
    }

    // Sanitiza o input do visitante e monta history (sempre role:user pro turn).
    const userMessage = sanitizeDemoInput(last.content);
    if (!userMessage) {
      return reply.code(400).send({ error: 'mensagem_vazia' });
    }
    const priorTurns = messages.slice(0, -1).slice(-config.DEMO_HISTORY_TURNS);
    const history: ChatTurn[] = priorTurns.map((m) =>
      toChatTurn(m.role, sanitizeDemoInput(m.content)),
    );

    const startedAt = Date.now();
    try {
      const result = await withTimeout(
        openai.runAgent({
          systemPrompt: DEMO_SYSTEM_PROMPT,
          history,
          userMessage,
          tools: [], // a demo NUNCA agenda — sem tools, loop de tool desligado
          maxTurns: 1,
          model: config.DEMO_MODEL,
          temperature: config.DEMO_TEMPERATURE,
          maxToolResultChars: 0,
          // teto de tokens de saída: passado via OpenAI SDK não é exposto pelo
          // RunAgentOpts; o custo de saída fica limitado pela persona (3 linhas) +
          // o cap diário global. O input é bounded por DEMO_MAX_INPUT_CHARS +
          // DEMO_HISTORY_TURNS. (max_tokens duro = melhoria futura no runAgent.)
          apiKey: config.DEEPSEEK_API_KEY,
          baseURL: DEEPSEEK_BASE_URL,
        }),
        config.DEMO_LLM_TIMEOUT_MS,
      );

      log.info(
        {
          ipHash: ipHashed,
          sessionId,
          turns: messages.length,
          demoBooking,
          dailyCount: daily.count,
          tokens: result.usage.total,
          latencyMs: Date.now() - startedAt,
        },
        'demo turn ok',
      );

      const replyText = result.reply || DEMO_FALLBACK_REPLY;
      return reply.code(200).send({ reply: replyText, demo_booking: demoBooking });
    } catch (e) {
      // Timeout/erro do provider: nunca vaza detalhe técnico; devolve fallback
      // amigável (o front mostra "tentar de novo"). Loga SEM conteúdo nem PII.
      const err = e instanceof Error ? e.message : String(e);
      log.warn(
        { ipHash: ipHashed, sessionId, err, latencyMs: Date.now() - startedAt },
        'demo turn falhou (provider)',
      );
      return reply.code(200).send({ reply: DEMO_FALLBACK_REPLY, demo_booking: demoBooking });
    }
  });
};
