/**
 * bot-detect-llm — classificador LLM da ZONA-CINZA (SCRUM-4 PR-D).
 *
 * O QUE FAZ: dado um número que a heurística do bot-detect (PR-C) deixou AMBÍGUO (zona-cinza =
 * exatamente 1 eixo ortogonal disparou), decide bot vs humano via LLM. Roda SÓ quando o job chama
 * (gated por BOT_DETECT_LLM no orquestrador) — este módulo nunca decide se a zona-cinza existe.
 *
 * ISOLAMENTO (crítico): a entrada são as últimas N mensagens `human` lidas por
 * `botDetect.getHumanMessages(chatTable, SLOT, telefone, N)` — JÁ ancorada por slot (#404 A1). Nunca
 * montamos query de conteúdo sem o slot. O conteúdo da conversa vai pro LLM (é o sinal); o número
 * NUNCA aparece em claro no log (phoneHint) nem é gravado no custo.
 *
 * DEFAULT SEGURO: marca 'bot' SÓ se o modelo retornar is_bot=true E confidence ≥ 0.85 (limiar da
 * spec). Qualquer outra coisa COM resposta do modelo (confiança baixa, is_bot=false, JSON
 * malformado) = 'human'. Sem resposta (timeout/erro/nenhuma mensagem) = null → o orquestrador
 * mantém a heurística (não-bot). Falso-positivo (pausar/alertar cliente real) é o erro mais caro.
 *
 * CUSTO: cada chamada loga uso por SLOT via modelUsage.logUsage (mesmo caminho de run-agent.ts) →
 * $/classificação por slot medível desde o dia 1. Sem telefone (PII) — a métrica é por slot.
 *
 * PADRÕES LLM: reusa o cliente OpenAI já existente do projeto (openai.runAgent, sem novo SDK);
 * temperatura 0 explícita; timeout duro (BOT_DETECT_LLM_TIMEOUT_MS); saída validada por zod.
 */
import { logger } from '@startap/core/logger';
import { phoneHint } from '@startap/core/phone';
import { botDetect, modelUsage } from '@startap/db';
import { openai } from '@startap/integrations';
import { z } from 'zod';
import { config } from '../config.js';

const log = logger.child({ job: 'bot-detect', stage: 'llm' });

/**
 * System prompt v1 — espelho EXATO de `prompts/bot-detect/v1.md` (persona-free, temp 0). O .md é a
 * fonte versionada/changelog; o runtime embute o texto. Ao mudar o prompt, atualizar o .md (+ bump
 * de changelog) E esta constante juntos.
 */
export const BOT_DETECT_SYSTEM_PROMPT_V1 = `Você é um classificador. Sua única tarefa é decidir se as mensagens abaixo foram
escritas por um SER HUMANO real (cliente) ou por um BOT/sistema automatizado/empresa
de marketing.

Contexto: as mensagens chegaram a um atendimento automatizado de WhatsApp de uma
barbearia/PME brasileira. Clientes humanos escrevem de forma curta, informal, com
gírias e erros de português, perguntas simples (ex.: marcar horário, preço, "tem vaga?"),
áudios, e cadência irregular. Bots/empresas mandam texto com formatação de marketing
(negrito com asteriscos, blocos de emoji, links, CTAs como "clique", "junte-se",
"promo", "sorteio"), mensagens repetidas/templated, e respondem de forma regular.

Sinais de BOT: formatação de campanha, links/CTAs, texto idêntico repetido, tom de
marca/empresa, frases genéricas de divulgação, ausência total de gíria/erro humano.
Sinais de HUMANO: mensagens curtas e informais, gíria e erro de PT-BR, perguntas
diretas sobre agendamento/preço, referência a áudio, variação natural.

REGRAS:
- Responda APENAS com um objeto JSON válido, nada antes ou depois.
- Formato EXATO: {"is_bot": boolean, "confidence": number, "reason": string}
- "confidence" é de 0 a 1 (sua certeza na classificação, não a probabilidade de ser bot).
- "reason" é curto (1 frase, em pt-BR), citando o sinal decisivo.
- Na dúvida genuína, prefira is_bot=false com confidence baixa — marcar um cliente real
  como bot é o erro mais caro.
- NÃO invente conteúdo; julgue só pelas mensagens dadas.`;

/**
 * Limiar de decisão (alinhado à regra dura de docs/bot-detect/sinais.md e prompts/bot-detect/v1.md):
 * marca bot por LLM SÓ se is_bot === true && confidence >= 0.85.
 */
export const LLM_CONFIDENCE_THRESHOLD = 0.85;

/** Schema estrito da saída do LLM. Parse-fail ⇒ tratado como humano (default seguro). */
export const botDetectLlmSchema = z.object({
  is_bot: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(280),
});
export type BotDetectLlmOutput = z.infer<typeof botDetectLlmSchema>;

/** Trunca mensagens longas no prompt (a spec pede "truncar mensagens longas"). */
const MAX_MSG_CHARS = 500;

/** Monta a user message do prompt v1 (mensagens em ordem cronológica, só o lado do número). */
export function buildUserMessage(messages: string[]): string {
  const lines = messages
    .map((m, i) => {
      const text = m.length > MAX_MSG_CHARS ? `${m.slice(0, MAX_MSG_CHARS)}…` : m;
      return `${i + 1}. ${text}`;
    })
    .join('\n');
  return `Mensagens do número (cronológico, só o lado dele):\n${lines}\n\nClassifique.`;
}

/**
 * Extrai e valida o JSON da resposta do modelo. Tolera cercas/markdown ao redor (pega do 1º `{` ao
 * último `}`). Retorna null se não for JSON válido OU não casar o schema → o chamador trata como
 * humano (nunca pausa por saída malformada).
 */
export function parseLlmOutput(reply: string): BotDetectLlmOutput | null {
  if (!reply || typeof reply !== 'string') return null;
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = botDetectLlmSchema.safeParse(obj);
  return parsed.success ? parsed.data : null;
}

export interface GrayZoneVerdict {
  verdict: 'bot' | 'human';
  confidence: number;
  signals: Record<string, unknown>;
}

/** Promise.race com timeout duro (regra 7) — nunca aguardar o provider infinito. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('llm timeout')), ms)),
  ]);
}

/**
 * Classifica um número da ZONA-CINZA via LLM (gpt-4o-mini, temp 0). Self-contained: lê as próprias
 * mensagens (isolado por slot) e loga o custo. Nunca lança.
 *
 * Retorna:
 *  - `{ verdict:'bot' }`  → SÓ se is_bot && confidence ≥ LLM_CONFIDENCE_THRESHOLD.
 *  - `{ verdict:'human' }` → qualquer outra resposta do modelo (conf baixa, is_bot=false, parse-fail).
 *  - `null` → sem mensagens OU chamada falhou/timeout: o chamador mantém a heurística (não-bot).
 */
export async function classifyGrayZone(args: {
  slot: string;
  telefone: string;
  chatTable: string;
}): Promise<GrayZoneVerdict | null> {
  const { slot, telefone, chatTable } = args;

  // Entrada SEMPRE via getHumanMessages com o SLOT (isolamento #404 A1). DESC (recente→antigo).
  let recent: string[];
  try {
    recent = await botDetect.getHumanMessages(
      chatTable,
      slot,
      telefone,
      config.BOT_DETECT_LLM_MAX_MSGS,
    );
  } catch (e) {
    log.warn(
      { slot, telefone: phoneHint(telefone), err: e instanceof Error ? e.message : String(e) },
      'bot-detect: erro ao ler mensagens da zona-cinza — mantém heurística',
    );
    return null;
  }
  if (recent.length === 0) return null;

  // v1 pede ordem cronológica (antigo→recente).
  const chronological = [...recent].reverse();
  const model = config.BOT_DETECT_LLM_MODEL;
  const startedAt = Date.now();

  let result: Awaited<ReturnType<typeof openai.runAgent>>;
  try {
    result = await withTimeout(
      openai.runAgent({
        systemPrompt: BOT_DETECT_SYSTEM_PROMPT_V1,
        history: [],
        userMessage: buildUserMessage(chronological),
        model,
        temperature: 0, // classificação determinística (regra de ouro 4)
        maxTurns: 1, // 1 turno, sem tools — saída JSON direta
      }),
      config.BOT_DETECT_LLM_TIMEOUT_MS,
    );
  } catch (e) {
    log.warn(
      { slot, telefone: phoneHint(telefone), err: e instanceof Error ? e.message : String(e) },
      'bot-detect: chamada LLM falhou/timeout — mantém heurística',
    );
    return null;
  }

  const latencyMs = Date.now() - startedAt;

  // Custo por SLOT (mesmo caminho de run-agent.ts). Sem telefone (PII): a métrica é por slot. Não
  // bloqueia o veredito se o log de custo cair.
  if (result.usage.total > 0) {
    modelUsage
      .logUsage({
        slot,
        flowId: slot,
        provider: 'openai',
        model,
        prompt: result.usage.prompt,
        completion: result.usage.completion,
        total: result.usage.total,
        cached: result.usage.cached,
      })
      .catch((e) =>
        log.warn(
          { slot, err: e instanceof Error ? e.message : String(e) },
          'bot-detect: log de custo (modelUsage) falhou',
        ),
      );
  }

  const parsed = parseLlmOutput(result.reply);
  const isBot = parsed?.is_bot === true && parsed.confidence >= LLM_CONFIDENCE_THRESHOLD;

  // Observabilidade (v1.md §Observabilidade): model, tokens, latency, slot, phone(mascarado),
  // is_bot, confidence. NUNCA o conteúdo da conversa nem o telefone em claro.
  log.info(
    {
      slot,
      telefone: phoneHint(telefone),
      model,
      input_tokens: result.usage.prompt,
      output_tokens: result.usage.completion,
      cached_tokens: result.usage.cached,
      latency_ms: latencyMs,
      msgs: chronological.length,
      is_bot: parsed?.is_bot ?? null,
      confidence: parsed?.confidence ?? null,
      verdict: isBot ? 'bot' : 'human',
      parseOk: parsed != null,
    },
    'bot-detect: zona-cinza classificada por LLM',
  );

  return {
    verdict: isBot ? 'bot' : 'human',
    confidence: parsed?.confidence ?? 0,
    signals: {
      llm: {
        model,
        is_bot: parsed?.is_bot ?? null,
        confidence: parsed?.confidence ?? null,
        reason: parsed?.reason ?? null,
        threshold: LLM_CONFIDENCE_THRESHOLD,
        parseOk: parsed != null,
      },
    },
  };
}
