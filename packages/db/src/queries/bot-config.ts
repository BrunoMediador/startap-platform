import { query } from '../client.js';

/**
 * bot_config — configuração runtime de cada "slot" (bot ou sub-bot).
 *
 * Slots conhecidos:
 *   barbearia-cirilo, elenildo-ricardo, startap-ai-lola, startap-ai-samuel
 */

export type Provider = 'openai' | 'deepseek';

export interface BotConfigRow {
  slot: string;
  display_name: string;
  provider: Provider;
  model: string;
  temperature: number;
  updated_at: Date;
}

const CACHE_TTL_MS = 2_000;
const cache = new Map<string, { row: BotConfigRow; expiresAt: number }>();

export async function getConfig(slot: string): Promise<BotConfigRow | null> {
  const cached = cache.get(slot);
  if (cached && cached.expiresAt > Date.now()) return cached.row;

  const r = await query<BotConfigRow & { temperature: string }>(
    `SELECT slot, display_name, provider, model, temperature::float AS temperature, updated_at
     FROM bot_config WHERE slot = $1`,
    [slot],
  );
  const row = r.rows[0];
  if (!row) return null;
  const normalized: BotConfigRow = {
    ...row,
    temperature: Number(row.temperature),
  };
  cache.set(slot, { row: normalized, expiresAt: Date.now() + CACHE_TTL_MS });
  return normalized;
}

export async function listConfigs(): Promise<BotConfigRow[]> {
  const r = await query<BotConfigRow & { temperature: string }>(
    `SELECT slot, display_name, provider, model, temperature::float AS temperature, updated_at
     FROM bot_config ORDER BY slot`,
  );
  return r.rows.map((row) => ({ ...row, temperature: Number(row.temperature) }));
}

export async function updateConfig(
  slot: string,
  patch: { provider?: Provider; model?: string; temperature?: number },
): Promise<BotConfigRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (patch.provider) {
    sets.push(`provider = $${i++}`);
    vals.push(patch.provider);
  }
  if (patch.model) {
    sets.push(`model = $${i++}`);
    vals.push(patch.model);
  }
  if (patch.temperature !== undefined) {
    sets.push(`temperature = $${i++}`);
    vals.push(patch.temperature);
  }
  if (sets.length === 0) return getConfig(slot);
  sets.push('updated_at = NOW()');
  vals.push(slot);
  await query(`UPDATE bot_config SET ${sets.join(', ')} WHERE slot = $${i}`, vals);
  cache.delete(slot);
  return getConfig(slot);
}

export function invalidateCache(slot?: string): void {
  if (slot) cache.delete(slot);
  else cache.clear();
}
