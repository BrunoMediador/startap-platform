import { logger } from '@startap/core/logger';
import type { ChatTurn } from '@startap/db';
/**
 * Agente OpenAI com tool-calling.
 *
 * Substitui o nó "AI Agent" (LangChain) do automação visual antiga. Implementação minimalista
 * usando OpenAI SDK direto + memória Postgres.
 *
 * Suporta providers compatíveis (DeepSeek, etc) via apiKey/baseURL opcionais.
 */
import OpenAI from 'openai';

const log = logger.child({ module: 'openai-agent' });

const defaultClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const clientCache = new Map<string, OpenAI>();

function getClient(apiKey?: string, baseURL?: string): OpenAI {
  if (!apiKey && !baseURL) return defaultClient;
  const key = `${apiKey ?? ''}|${baseURL ?? ''}`;
  let c = clientCache.get(key);
  if (!c) {
    c = new OpenAI({ apiKey: apiKey ?? process.env.OPENAI_API_KEY, baseURL });
    clientCache.set(key, c);
  }
  return c;
}

/**
 * EXAMPLE_MODEL — referência documental apenas.
 * NÃO usar em runtime como fallback: se opts.model for undefined/null,
 * runAgent lança erro explícito para forçar configuração correta no banco.
 * @see run-agent.ts que lê bot_config.model antes de chamar runAgent
 */
export const EXAMPLE_MODEL = 'gpt-4o';
const DEFAULT_HISTORY_MAX_CHARS = Number.parseInt(
  process.env.AGENT_HISTORY_MAX_CHARS ?? '12000',
  10,
);
const DEFAULT_TOOL_RESULT_MAX_CHARS = Number.parseInt(
  process.env.AGENT_TOOL_RESULT_MAX_CHARS ?? '6000',
  10,
);

export interface ToolDefinition<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: TArgs) => Promise<TResult>;
}

/**
 * Controle de `tool_choice` na chamada OpenAI.
 * - AUSENTE (undefined): não passa `tool_choice` — comportamento atual, byte-a-byte
 *   inalterado (o modelo decide se e quando chama uma tool).
 * - `'auto'`: idem, porém explícito (o modelo decide).
 * - `{ forceFunction: '<nome>' }`: OBRIGA o modelo a chamar aquela função NESTE turno
 *   (mapeado para `{ type:'function', function:{ name } }`). Usado pelo caminho
 *   determinístico "gerar agora" do builder — a geração não depende mais da vontade do
 *   modelo. A força vale só até a tool ser chamada uma vez; depois libera pra resposta final.
 */
export type ToolChoice = 'auto' | { forceFunction: string };

export interface RunAgentOpts {
  systemPrompt: string;
  history: ChatTurn[];
  userMessage: string;
  tools?: ToolDefinition[];
  model?: string;
  maxTurns?: number;
  maxHistoryChars?: number;
  maxToolResultChars?: number;
  temperature?: number;
  /** Ver {@link ToolChoice}. Ausente = comportamento atual (sem `tool_choice`). */
  toolChoice?: ToolChoice;
  /** Provider compatível com OpenAI (DeepSeek etc). */
  apiKey?: string;
  baseURL?: string;
}

export interface RunAgentResult {
  reply: string;
  toolCalls: Array<{ name: string; args: unknown; result: unknown }>;
  /**
   * `cached` = subconjunto de `prompt` que foi cache-hit de prompt caching
   * (usage.prompt_tokens_details.cached_tokens). Caching é automático para
   * prompts >= 1024 tokens (nosso caso: agenda GCal re-injetada por turno é um
   * prefixo estável). Tokens cacheados são ~10x mais baratos — sem isso o custo
   * estimado fica inflado (ADR 0021 / fix do model_usage.cost_usd).
   */
  usage: { prompt: number; completion: number; total: number; cached: number };
}

export async function runAgent(opts: RunAgentOpts): Promise<RunAgentResult> {
  const { systemPrompt, history, userMessage, tools = [], maxTurns = 5 } = opts;

  if (!opts.model || opts.model.trim() === '') {
    throw new Error(
      'Modelo OpenAI ausente — configure bot_config.model no painel antes de ativar o bot',
    );
  }
  const model = opts.model;
  const temperature = opts.temperature ?? 0.4;
  const client = getClient(opts.apiKey, opts.baseURL);
  const compactHistory = limitHistoryByChars(
    history,
    opts.maxHistoryChars ?? DEFAULT_HISTORY_MAX_CHARS,
  );
  if (compactHistory.length < history.length) {
    log.info(
      { originalTurns: history.length, sentTurns: compactHistory.length },
      'Historico aparado antes de chamar o modelo',
    );
  }

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...compactHistory.map((t) =>
      t.role === 'human'
        ? ({ role: 'user', content: t.content } as const)
        : t.role === 'ai'
          ? ({ role: 'assistant', content: t.content } as const)
          : ({ role: 'system', content: t.content } as const),
    ),
    { role: 'user', content: userMessage },
  ];

  const openAiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters as never },
  }));

  // `tool_choice` só faz sentido se há tools ofertadas. Ausente/undefined = não passamos o
  // campo (byte-a-byte pro caminho atual). Forçar uma função é resolvido 1x aqui.
  const forcedToolChoice = openAiTools.length > 0 ? resolveToolChoice(opts.toolChoice) : undefined;

  const trace: RunAgentResult['toolCalls'] = [];
  const usage = { prompt: 0, completion: 0, total: 0, cached: 0 };

  for (let turn = 0; turn < maxTurns; turn++) {
    // Força a tool APENAS até ela ser chamada uma vez (trace vazio). Depois libera pra o
    // modelo escrever a mensagem final — senão forçaríamos a tool em loop até esgotar turns.
    const toolChoice = trace.length === 0 ? forcedToolChoice : undefined;
    const completion = await client.chat.completions.create({
      model,
      temperature,
      messages,
      tools: openAiTools.length > 0 ? openAiTools : undefined,
      ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    });

    if (completion.usage) {
      usage.prompt += completion.usage.prompt_tokens ?? 0;
      usage.completion += completion.usage.completion_tokens ?? 0;
      usage.total += completion.usage.total_tokens ?? 0;
      // cached_tokens é subconjunto de prompt_tokens (não soma a parte). DeepSeek
      // e modelos sem caching reportam 0/ausente — fica zerado, sem efeito.
      usage.cached += completion.usage.prompt_tokens_details?.cached_tokens ?? 0;
    }

    const msg = completion.choices[0]?.message;
    if (!msg) throw new Error('OpenAI sem resposta');

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      messages.push(msg as OpenAI.Chat.ChatCompletionMessageParam);
      for (const call of msg.tool_calls) {
        const tool = tools.find((t) => t.name === call.function.name);
        if (!tool) {
          log.warn({ tool: call.function.name }, 'Tool desconhecida; ignorando');
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ error: 'tool desconhecida' }),
          });
          continue;
        }
        let args: unknown;
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          args = {};
        }
        try {
          const result = await tool.run(args as never);
          trace.push({ name: tool.name, args, result });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: stringifyToolResult(
              result,
              opts.maxToolResultChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS,
            ),
          });
        } catch (e) {
          const err = (e as Error).message;
          log.error({ tool: tool.name, err }, 'Tool failed');
          trace.push({ name: tool.name, args, result: { error: err } });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ error: err }),
          });
        }
      }
      continue;
    }

    return { reply: (msg.content ?? '').trim(), toolCalls: trace, usage };
  }

  log.warn({ turns: maxTurns }, 'Agent atingiu max_turns sem resposta final');
  return { reply: 'Desculpe, tive uma falha. Pode repetir?', toolCalls: trace, usage };
}

/**
 * Traduz {@link ToolChoice} para o parâmetro `tool_choice` do OpenAI SDK.
 * undefined -> undefined (não enviar o campo); 'auto' -> 'auto'; forçar função ->
 * `{ type:'function', function:{ name } }`.
 */
function resolveToolChoice(
  tc: ToolChoice | undefined,
): OpenAI.Chat.ChatCompletionToolChoiceOption | undefined {
  if (!tc) return undefined;
  if (tc === 'auto') return 'auto';
  return { type: 'function', function: { name: tc.forceFunction } };
}

function limitHistoryByChars(history: ChatTurn[], maxChars: number): ChatTurn[] {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return [];

  const selected: ChatTurn[] = [];
  let used = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    const content = turn.content.trim();
    if (!content) continue;

    const remaining = maxChars - used;
    if (remaining <= 0) break;

    if (content.length <= remaining) {
      selected.push({ ...turn, content });
      used += content.length;
      continue;
    }

    if (selected.length === 0) {
      selected.push({ ...turn, content: content.slice(-remaining) });
    }
    break;
  }

  return selected.reverse();
}

function stringifyToolResult(result: unknown, maxChars: number): string {
  const text = JSON.stringify(result);
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  return JSON.stringify({
    truncated: true,
    content: text.slice(0, maxChars),
  });
}
