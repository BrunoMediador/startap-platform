/**
 * Wrapper de openai.runAgent que lê config do banco (slot) e loga uso.
 *
 * Uso típico dentro de um bot:
 *
 *   const result = await runAgentConfigured({
 *     slot: 'barbearia-cirilo',
 *     telefone: ctx.message.telefone,
 *     systemPrompt,
 *     history,
 *     userMessage: texto,
 *     tools,
 *   });
 */
import { logger } from '@startap/core/logger';
import { botConfig, modelUsage } from '@startap/db';
import { openai } from '@startap/integrations';
import type { RunAgentOpts, RunAgentResult } from '@startap/integrations/openai';
import { config } from '../config.js';

const log = logger.child({ module: 'run-agent-configured' });

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

export interface RunAgentConfiguredOpts extends Omit<RunAgentOpts, 'model' | 'apiKey' | 'baseURL'> {
  /** Slot em bot_config (ex: 'barbearia-cirilo') */
  slot: string;
  /** Projeto logico dono da conversa/uso. */
  projectId?: string;
  /** Workflow/fluxo dono da conversa/uso. */
  flowId?: string | null;
  /** Telefone do cliente (para auditoria de uso) */
  telefone?: string;
}

export async function runAgentConfigured(opts: RunAgentConfiguredOpts): Promise<RunAgentResult> {
  const cfg = await botConfig.getConfig(opts.slot);

  if (!cfg) {
    // Sem config no banco: lançar erro explícito — não chamar runAgent com model undefined.
    throw new Error(
      `Modelo OpenAI ausente para o slot '${opts.slot}' — bot_config sem entry. Configure no painel antes de ativar`,
    );
  }

  if (!cfg.model || cfg.model.trim() === '') {
    throw new Error(
      `Modelo OpenAI ausente para o slot '${opts.slot}' — configure bot_config.model no painel antes de ativar`,
    );
  }

  const model = cfg.model;
  let apiKey: string | undefined;
  let baseURL: string | undefined;
  let provider: 'openai' | 'deepseek' = 'openai';
  const temperature = opts.temperature ?? cfg?.temperature ?? 0.3;

  provider = cfg.provider;
  if (cfg.provider === 'deepseek') {
    apiKey = config.DEEPSEEK_API_KEY;
    baseURL = DEEPSEEK_BASE_URL;
  }

  const result = await openai.runAgent({
    ...opts,
    model,
    apiKey,
    baseURL,
    temperature,
  });

  // Loga uso assíncrono (não bloqueia a resposta se DB cair)
  if (cfg && result.usage.total > 0) {
    modelUsage
      .logUsage({
        slot: opts.slot,
        projectId: opts.projectId,
        flowId: opts.flowId ?? undefined,
        provider,
        model: cfg.model,
        prompt: result.usage.prompt,
        completion: result.usage.completion,
        total: result.usage.total,
        telefone: opts.telefone,
      })
      .catch((e) => log.warn({ err: e, slot: opts.slot }, 'log usage falhou'));
  }

  return result;
}
