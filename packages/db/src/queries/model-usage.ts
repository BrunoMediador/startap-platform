import { query } from '../client.js';
import type { Provider } from './bot-config.js';
import { isTenantReadCutoverEnabled, resolveTenantId } from './tenant.js';

/**
 * model_usage — log de cada chamada ao LLM, com tokens e custo estimado.
 *
 * Pricing em USD por 1M tokens. Fonte oficial: https://openai.com/api/docs/pricing
 * (confirmado em 2026-06-13). `cached` = preço do input em cache-hit (prompt
 * caching automático >= 1024 tokens), ~10x mais barato que o input normal.
 *   gpt-4o            → in: $2.50,  cached: $1.25,  out: $10.00
 *   gpt-4o-mini       → in: $0.15,  cached: $0.075, out: $0.60
 *   gpt-4-turbo       → in: $10.00,                 out: $30.00 (sem cache)
 *   gpt-3.5-turbo     → in: $0.50,                  out: $1.50  (sem cache)
 *   gpt-5.4           → in: $2.50,  cached: $0.25,  out: $15.00 (OFICIAL — 2026-06-13)
 *   gpt-5.5           → in: $5.00,  cached: $0.50,  out: $30.00 (OFICIAL — 2026-06-13)
 *   deepseek-chat     → in: $0.27,                  out: $1.10  (oficial deepseek.com)
 *   deepseek-reasoner → in: $0.55,                  out: $2.19  (oficial deepseek.com)
 *
 * BUG corrigido (ADR 0021): o `cost_usd` superestimava ~70x a conta REAL da
 * OpenAI. Três erros multiplicativos, do mais ao menos grave:
 *   1. CACHING IGNORADO (dominante): nosso uso é input-dominado (agenda GCal
 *      re-injetada por turno = prefixo estável, sempre cache-hit). O código
 *      antigo cobrava TODO input à tarifa cheia; o real é ~10x menor na parte
 *      cacheada. `cached_tokens` (subconjunto de prompt) agora é cobrado à
 *      tarifa `cached`.
 *   2. PREÇO DE INPUT ERRADO: gpt-5.4 estava como $5.00 (estimativa); o oficial
 *      é $2.50 → 2x de inflação.
 *   3. PREÇO DE OUTPUT ERRADO: estava $20.00; o oficial é $15.00 → 1.33x.
 */

export interface PriceTable {
  /** USD per 1M input tokens (uncached) */
  in: number;
  /** USD per 1M output tokens */
  out: number;
  /**
   * USD per 1M cached input tokens (prompt caching cache-hit). Ausente = modelo
   * sem caching; cache-hits caem para a tarifa `in` normal.
   */
  cached?: number;
  /**
   * true quando o pricing nao tem fonte oficial publicada pelo provedor.
   * Mantido por compat com o endpoint de pricing-info do frontend.
   */
  isEstimate?: true;
}

/** Exportado para endpoints que precisam expor metadados de pricing ao frontend. */
export const PRICING: Record<string, PriceTable> = {
  'gpt-4o': { in: 2.5, out: 10.0, cached: 1.25 },
  'gpt-4o-mini': { in: 0.15, out: 0.6, cached: 0.075 },
  'gpt-4-turbo': { in: 10.0, out: 30.0 },
  'gpt-3.5-turbo': { in: 0.5, out: 1.5 },
  // Pricing OFICIAL da OpenAI (confirmado em 2026-06-13). NÃO é mais estimativa.
  'gpt-5.4': { in: 2.5, out: 15.0, cached: 0.25 },
  'gpt-5.5': { in: 5.0, out: 30.0, cached: 0.5 },
  'deepseek-chat': { in: 0.27, out: 1.1 },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
};

/**
 * Custo USD da chamada. `cached` = quantos dos `prompt` tokens foram cache-hit
 * (subconjunto de prompt). A parte cacheada usa a tarifa `cached` (fallback pra
 * `in` se o modelo não tiver caching); o restante do input usa `in`.
 */
export function estimateCost(
  model: string,
  prompt: number,
  completion: number,
  cached = 0,
): number {
  const p = PRICING[model];
  if (!p) return 0;
  const cachedTokens = Math.min(Math.max(cached, 0), prompt);
  const uncachedTokens = prompt - cachedTokens;
  const cachedRate = p.cached ?? p.in;
  return (uncachedTokens * p.in + cachedTokens * cachedRate + completion * p.out) / 1_000_000;
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
  /**
   * Tokens de input em cache-hit (subconjunto de `prompt`). Opcional: ausente/0
   * = nenhum cache (comportamento de cobrança = tarifa cheia, como antes).
   */
  cached?: number;
  telefone?: string;
}

export async function logUsage(input: LogUsageInput): Promise<void> {
  const cost = estimateCost(input.model, input.prompt, input.completion, input.cached ?? 0);
  // Dual-write tenant_id (ADR 0018, Fase 2). HOT PATH: resolveTenantId é cacheado
  // (TTL 60s por slot) — no pior caso 1 SELECT por slot/TTL, NUNCA 1 por chamada de
  // LLM. Fail-safe: resolução nunca lança; null grava tenant_id NULL (slot de
  // plataforma como `startap`/`teste_barbearia` resolve null de propósito).
  const tenantId = await resolveTenantId(input.slot);
  await query(
    `INSERT INTO model_usage
       (slot, project_id, flow_id, provider, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, telefone, tenant_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
      tenantId,
    ],
  );
}

export interface UsageSummaryRow {
  slot: string;
  /**
   * tenant_id (UUID) do clone. Presente SÓ com o READ CUTOVER ligado
   * (TENANT_READ_CUTOVER=true); null no modo slot (atual) e em slot de plataforma
   * sem clone. NUNCA muda o `slot`, que segue sendo a chave legível do agrupamento.
   */
  tenant_id?: string | null;
  provider: string;
  model: string;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

interface UsageSummaryRaw {
  slot: string;
  tenant_id?: string | null;
  provider: string;
  model: string;
  calls: string;
  prompt_tokens: string;
  completion_tokens: string;
  total_tokens: string;
  cost_usd: string | null;
}

const SUMMARY_AGG = `COUNT(*)::text AS calls,
            SUM(prompt_tokens)::text     AS prompt_tokens,
            SUM(completion_tokens)::text AS completion_tokens,
            SUM(total_tokens)::text      AS total_tokens,
            SUM(cost_usd)::text          AS cost_usd`;

/**
 * Rollup de uso de IA por período.
 *
 * READ CUTOVER (ADR 0018, Fase 2b) flag-gated, safe-by-construction:
 * - `TENANT_READ_CUTOVER` OFF (default): query IDÊNTICA à de hoje — agrupa por
 *   (slot, provider, model), saída sem tenant_id. Comportamento inalterado.
 * - ON: LEFT JOIN com flow_clones traz o tenant_id e o agrupamento passa a chavear
 *   por tenant_id (com o slot do clone como rótulo). Slot de plataforma sem clone
 *   (tenant_id NULL) continua agrupando por slot — não some do relatório.
 *
 * NÃO toca o hot path por-conversa. `env` injetável só para teste.
 */
export async function summaryByPeriod(
  daysBack: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UsageSummaryRow[]> {
  const cutover = isTenantReadCutoverEnabled(env);

  const sql = cutover
    ? // Modo tenant_id: agrupa por COALESCE(tenant_id do clone, slot). MAX(slot) dá um
      // rótulo legível estável (1 tenant_id = 1 clone = 1 slot). Plataforma (sem clone)
      // cai no slot, idêntico ao modo OFF para essas linhas.
      `SELECT MAX(mu.slot) AS slot, fc.tenant_id::text AS tenant_id, mu.provider, mu.model,
              ${SUMMARY_AGG}
       FROM model_usage mu
       LEFT JOIN flow_clones fc ON fc.slot = mu.slot
       WHERE mu.created_at > NOW() - ($1 || ' days')::INTERVAL
       GROUP BY COALESCE(fc.tenant_id::text, mu.slot), fc.tenant_id, mu.provider, mu.model
       ORDER BY SUM(mu.total_tokens) DESC`
    : `SELECT slot, provider, model,
              ${SUMMARY_AGG}
       FROM model_usage
       WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
       GROUP BY slot, provider, model
       ORDER BY SUM(total_tokens) DESC`;

  const r = await query<UsageSummaryRaw>(sql, [String(daysBack)]);
  return r.rows.map((row) => ({
    slot: row.slot,
    ...(cutover ? { tenant_id: row.tenant_id ?? null } : {}),
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

/**
 * Retorna metadados de pricing por modelo, incluindo flag isEstimate.
 * Usado pelo endpoint /api/usage/pricing-info para que o frontend
 * possa exibir aviso visual nos modelos sem pricing oficial.
 */
export function getPricingInfo(): Record<string, PriceTable> {
  return PRICING;
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
