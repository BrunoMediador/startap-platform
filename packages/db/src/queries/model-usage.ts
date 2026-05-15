import { query } from '../client.js';
import type { Provider } from './bot-config.js';

/**
 * model_usage — log de cada chamada ao LLM, com tokens e custo estimado.
 *
 * Pricing aproximado em USD por 1M tokens (atualizar conforme provedor):
 *   gpt-4o            → in: $2.50, out: $10.00
 *   gpt-4o-mini       → in: $0.15, out: $0.60
 *   gpt-5.4           → in: $5.00, out: $20.00  (estimativa - ajustar quando lancado)
 *   deepseek-chat     → in: $0.27, out: $1.10
 *   deepseek-reasoner → in: $0.55, out: $2.19
 */

interface PriceTable {
  /** USD per 1M input tokens */
  in: number;
  /** USD per 1M output tokens */
  out: number;
}

const PRICING: Record<string, PriceTable> = {
  'gpt-4o': { in: 2.5, out: 10.0 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4-turbo': { in: 10.0, out: 30.0 },
  'gpt-3.5-turbo': { in: 0.5, out: 1.5 },
  'gpt-5.4': { in: 5.0, out: 20.0 },
  'deepseek-chat': { in: 0.27, out: 1.1 },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
};

function estimateCost(model: string, prompt: number, completion: number): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (prompt * p.in + completion * p.out) / 1_000_000;
}

export interface LogUsageInput {
  slot: string;
  projectId?: string;
  flowId?: string;
  provider: Provider;
  model: string;
  prompt: number;
  completion: number;
  total: number;
  telefone?: string;
}

export async function logUsage(input: LogUsageInput): Promise<void> {
  const cost = estimateCost(input.model, input.prompt, input.completion);
  await query(
    `INSERT INTO model_usage
       (slot, project_id, flow_id, provider, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, telefone)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.slot,
      input.projectId ?? null,
      input.flowId ?? null,
      input.provider,
      input.model,
      input.prompt,
      input.completion,
      input.total,
      cost,
      input.telefone ?? null,
    ],
  );
}

export interface UsageSummaryRow {
  slot: string;
  provider: string;
  model: string;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

export async function summaryByPeriod(daysBack: number): Promise<UsageSummaryRow[]> {
  const r = await query<{
    slot: string;
    provider: string;
    model: string;
    calls: string;
    prompt_tokens: string;
    completion_tokens: string;
    total_tokens: string;
    cost_usd: string | null;
  }>(
    `SELECT slot, provider, model,
            COUNT(*)::text AS calls,
            SUM(prompt_tokens)::text     AS prompt_tokens,
            SUM(completion_tokens)::text AS completion_tokens,
            SUM(total_tokens)::text      AS total_tokens,
            SUM(cost_usd)::text          AS cost_usd
     FROM model_usage
     WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
     GROUP BY slot, provider, model
     ORDER BY SUM(total_tokens) DESC`,
    [String(daysBack)],
  );
  return r.rows.map((row) => ({
    slot: row.slot,
    provider: row.provider,
    model: row.model,
    calls: Number(row.calls),
    prompt_tokens: Number(row.prompt_tokens),
    completion_tokens: Number(row.completion_tokens),
    total_tokens: Number(row.total_tokens),
    cost_usd: Number(row.cost_usd ?? 0),
  }));
}

export async function dailyTotals(
  daysBack: number,
): Promise<Array<{ day: string; total_tokens: number; cost_usd: number }>> {
  const r = await query<{ day: string; total_tokens: string; cost_usd: string | null }>(
    `SELECT TO_CHAR(DATE_TRUNC('day', created_at), 'YYYY-MM-DD') AS day,
            SUM(total_tokens)::text AS total_tokens,
            SUM(cost_usd)::text     AS cost_usd
     FROM model_usage
     WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
     GROUP BY 1
     ORDER BY 1`,
    [String(daysBack)],
  );
  return r.rows.map((row) => ({
    day: row.day,
    total_tokens: Number(row.total_tokens),
    cost_usd: Number(row.cost_usd ?? 0),
  }));
}

export async function recentCalls(limit = 50): Promise<
  Array<{
    id: number;
    slot: string;
    model: string;
    total_tokens: number;
    cost_usd: number;
    telefone: string | null;
    created_at: Date;
  }>
> {
  const r = await query<{
    id: string;
    slot: string;
    model: string;
    total_tokens: string;
    cost_usd: string | null;
    telefone: string | null;
    created_at: Date;
  }>(
    `SELECT id::text, slot, model, total_tokens::text, cost_usd::text, telefone, created_at
     FROM model_usage
     ORDER BY id DESC
     LIMIT $1`,
    [limit],
  );
  return r.rows.map((row) => ({
    id: Number(row.id),
    slot: row.slot,
    model: row.model,
    total_tokens: Number(row.total_tokens),
    cost_usd: Number(row.cost_usd ?? 0),
    telefone: row.telefone,
    created_at: row.created_at,
  }));
}
