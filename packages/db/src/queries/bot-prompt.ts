import { query } from '../client.js';

/**
 * bot_prompt — prompts editáveis por slot, salvos no banco.
 *
 * Bots lêem o prompt no startup + cache de 30s.
 * Painel atualiza o prompt via PUT /api/bots/:slot/prompt.
 */

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { prompt: string; expiresAt: number }>();

export async function getPrompt(slot: string): Promise<string | null> {
  const cached = cache.get(slot);
  if (cached && cached.expiresAt > Date.now()) return cached.prompt;

  const r = await query<{ prompt: string }>(
    `SELECT prompt FROM bot_prompt WHERE slot = $1`,
    [slot],
  );
  const prompt = r.rows[0]?.prompt ?? null;
  if (prompt !== null) {
    cache.set(slot, { prompt, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return prompt;
}

export async function setPrompt(slot: string, prompt: string): Promise<void> {
  await query(
    `INSERT INTO bot_prompt (slot, prompt, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (slot) DO UPDATE SET prompt = EXCLUDED.prompt, updated_at = NOW()`,
    [slot, prompt],
  );
  cache.delete(slot);
}

export function invalidatePromptCache(slot?: string): void {
  if (slot) cache.delete(slot);
  else cache.clear();
}
