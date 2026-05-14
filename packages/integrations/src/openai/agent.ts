import { logger } from '@startap/core/logger';
import type { ChatTurn } from '@startap/db';
/**
 * Agente OpenAI com tool-calling.
 *
 * Substitui o nó "AI Agent" (LangChain) do n8n. Implementação minimalista
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

const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

export interface ToolDefinition<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: TArgs) => Promise<TResult>;
}

export interface RunAgentOpts {
  systemPrompt: string;
  history: ChatTurn[];
  userMessage: string;
  tools?: ToolDefinition[];
  model?: string;
  maxTurns?: number;
  temperature?: number;
  /** Provider compatível com OpenAI (DeepSeek etc). */
  apiKey?: string;
  baseURL?: string;
}

export interface RunAgentResult {
  reply: string;
  toolCalls: Array<{ name: string; args: unknown; result: unknown }>;
  usage: { prompt: number; completion: number; total: number };
}

export async function runAgent(opts: RunAgentOpts): Promise<RunAgentResult> {
  const { systemPrompt, history, userMessage, tools = [], maxTurns = 5 } = opts;
  const model = opts.model ?? DEFAULT_MODEL;
  const temperature = opts.temperature ?? 0.4;
  const client = getClient(opts.apiKey, opts.baseURL);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...history.map((t) =>
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

  const trace: RunAgentResult['toolCalls'] = [];
  const usage = { prompt: 0, completion: 0, total: 0 };

  for (let turn = 0; turn < maxTurns; turn++) {
    const completion = await client.chat.completions.create({
      model,
      temperature,
      messages,
      tools: openAiTools.length > 0 ? openAiTools : undefined,
    });

    if (completion.usage) {
      usage.prompt += completion.usage.prompt_tokens ?? 0;
      usage.completion += completion.usage.completion_tokens ?? 0;
      usage.total += completion.usage.total_tokens ?? 0;
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
            content: JSON.stringify(result),
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
