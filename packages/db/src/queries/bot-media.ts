import { query } from '../client.js';

/**
 * bot_media — mídias enviadas por bots (videos/imagens/arquivos).
 *
 * Cada linha tem uma posição (ex: V1, V2, V3, POS_VIDEOS) e o slot do bot.
 * Painel adiciona/remove/edita; bots leem com cache de 30s.
 */

export type MediaType = 'video' | 'image' | 'file' | 'text';

export interface BotMediaRow {
  id: number;
  slot: string;
  position: string;
  media_type: MediaType;
  url: string | null;
  caption: string | null;
  position_order: number;
  enabled: boolean;
  updated_at: Date;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { rows: BotMediaRow[]; expiresAt: number }>();

export async function listBySlot(slot: string): Promise<BotMediaRow[]> {
  const cached = cache.get(slot);
  if (cached && cached.expiresAt > Date.now()) return cached.rows;

  const r = await query<BotMediaRow & { id: string; position_order: string }>(
    `SELECT id, slot, position, media_type, url, caption, position_order, enabled, updated_at
     FROM bot_media
     WHERE slot = $1
     ORDER BY position_order, id`,
    [slot],
  );
  const rows = r.rows.map((row) => ({
    ...row,
    id: Number(row.id),
    position_order: Number(row.position_order),
  })) as BotMediaRow[];
  cache.set(slot, { rows, expiresAt: Date.now() + CACHE_TTL_MS });
  return rows;
}

export async function getByPosition(slot: string, position: string): Promise<BotMediaRow | null> {
  const all = await listBySlot(slot);
  return all.find((m) => m.position === position && m.enabled) ?? null;
}

export async function upsertMedia(input: {
  slot: string;
  position: string;
  media_type?: MediaType;
  url?: string | null;
  caption?: string | null;
  position_order?: number;
  enabled?: boolean;
}): Promise<BotMediaRow> {
  const r = await query<BotMediaRow & { id: string; position_order: string }>(
    `INSERT INTO bot_media (slot, position, media_type, url, caption, position_order, enabled, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (slot, position) DO UPDATE SET
       media_type   = EXCLUDED.media_type,
       url          = EXCLUDED.url,
       caption      = EXCLUDED.caption,
       position_order = EXCLUDED.position_order,
       enabled      = EXCLUDED.enabled,
       updated_at   = NOW()
     RETURNING *`,
    [
      input.slot,
      input.position,
      input.media_type ?? 'video',
      input.url ?? null,
      input.caption ?? null,
      input.position_order ?? 0,
      input.enabled ?? true,
    ],
  );
  cache.delete(input.slot);
  const row = r.rows[0];
  return { ...row, id: Number(row.id), position_order: Number(row.position_order) } as BotMediaRow;
}

export async function deleteById(id: number): Promise<void> {
  const r = await query<{ slot: string }>(`DELETE FROM bot_media WHERE id = $1 RETURNING slot`, [id]);
  if (r.rows[0]) cache.delete(r.rows[0].slot);
}

export function invalidateMediaCache(slot?: string): void {
  if (slot) cache.delete(slot);
  else cache.clear();
}
