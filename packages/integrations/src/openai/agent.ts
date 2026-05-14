/**
 * Agente OpenAI com tool-calling.
 *
 * Substitui o nó "AI Agent" (LangChain) do n8n. Implementação minimalista
 * usando OpenAI SDK direto + memória Postgres.
 *
 * Loop: chamada -> se tool_call -> executa tool -> resposta -> repete (até max_turns).
 */
import OpenAI from 'openai';
import type { ChatTurn } from '@startap/db';
import { logger } from '@startap/core/logger';

const log = logger.child({ module: 'openai-agent' });

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

export interface ToolDefinition<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  /** Schema JSON dos argumentos (formato OpenAI function calling). */
  parameters: Record<string, unknown>;
  /** Execução real da tool. */
  run: (args: TArgs) => Promise<TResult>;
}

export interface RunAgentOpts {
  systemPrompt: string;
  /** Mensagens passadas (do banco de memória) */
  history: ChatTurn[];
  /** Mensagem nova do usuário */
  userMessage: string;
  tools?: ToolDefinition[];
  model?: string;
  /** Limite de iterações tool-call. Default 5. */
  maxTurns?: number;
  temperature?: number;
}

export interface RunAgentResult {
  /** Resposta final do agente (texto para enviar ao usuário). */
  reply: string;
  /** Trace das tool calls (debug). */
  toolCalls: Array<{ name: string; args: unknown; result: unknown }>;
  /** Tokens usados (custo). */
  usage: { prompt: number; completion: number; total: number };
}

export async function runAgent(opts: RunAgentOpts): Promise<RunAgentResult> {
  const { systemPrompt, history, userMessage, tools = [], maxTurns = 5 } = opts;
  const model = opts.model ?? DEFAULT_MODEL;
  const temperature = opts.temperature ?? 0.4;

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

    // Tool calls?
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
      continue; // Pede nova chamada com os resultados
    }

    // Sem tool call → resposta final
    return { reply: (msg.content ?? '').trim(), toolCalls: trace, usage };
  }

  log.warn({ turns: maxTurns }, 'Agent atingiu max_turns sem resposta final');
  return { reply: 'Desculpe, tive uma falha. Pode repetir?', toolCalls: trace, usage };
}
