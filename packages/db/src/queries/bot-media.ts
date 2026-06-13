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
  context: string | null;
  position_order: number;
  enabled: boolean;
  /** Slug do curso ao qual esta mídia pertence. NULL = mídia livre (sem vínculo a curso). */
  course_slug: string | null;
  /** Indica se esta mídia é o vídeo de apresentação do curso (intro). Só 1 por (slot, course_slug). */
  is_course_intro: boolean;
  updated_at: Date;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { rows: BotMediaRow[]; expiresAt: number }>();

export async function listBySlot(slot: string): Promise<BotMediaRow[]> {
  const cached = cache.get(slot);
  if (cached && cached.expiresAt > Date.now()) return cached.rows;

  const r = await query<BotMediaRow & { id: string; position_order: string }>(
    `SELECT id, slot, position, media_type, url, caption, context, position_order, enabled,
            course_slug, is_course_intro, updated_at
     FROM bot_media
     WHERE slot = $1
     ORDER BY position_order, id`,
    [slot],
  );
  const rows = r.rows.map((row) => ({
    ...row,
    id: Number(row.id),
    position_order: Number(row.position_order),
    course_slug: row.course_slug ?? null,
    is_course_intro: row.is_course_intro ?? false,
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
  context?: string | null;
  position_order?: number;
  enabled?: boolean;
  course_slug?: string | null;
  is_course_intro?: boolean;
}): Promise<BotMediaRow> {
  // Dual-write tenant_id (ADR 0018, Fase 2): subselect inline em flow_clones —
  // resolve NULL sozinho p/ slot sem clone, nunca derruba o INSERT. Não-quente.
  const r = await query<BotMediaRow & { id: string; position_order: string }>(
    `INSERT INTO bot_media
       (slot, position, media_type, url, caption, context, position_order, enabled,
        course_slug, is_course_intro, updated_at, tenant_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(),
        (SELECT tenant_id FROM flow_clones WHERE slot = $1))
     ON CONFLICT (slot, position) DO UPDATE SET
       media_type     = EXCLUDED.media_type,
       url            = EXCLUDED.url,
       caption        = EXCLUDED.caption,
       context        = EXCLUDED.context,
       position_order = EXCLUDED.position_order,
       enabled        = EXCLUDED.enabled,
       course_slug    = EXCLUDED.course_slug,
       is_course_intro = EXCLUDED.is_course_intro,
       updated_at     = NOW(),
       tenant_id      = COALESCE(bot_media.tenant_id, EXCLUDED.tenant_id)
     RETURNING *`,
    [
      input.slot,
      input.position,
      input.media_type ?? 'video',
      input.url ?? null,
      input.caption ?? null,
      input.context ?? null,
      input.position_order ?? 0,
      input.enabled ?? true,
      input.course_slug ?? null,
      input.is_course_intro ?? false,
    ],
  );
  cache.delete(input.slot);
  const row = r.rows[0];
  return {
    ...row,
    id: Number(row.id),
    position_order: Number(row.position_order),
    course_slug: row.course_slug ?? null,
    is_course_intro: row.is_course_intro ?? false,
  } as BotMediaRow;
}

export async function deleteById(id: number): Promise<void> {
  const r = await query<{ slot: string }>('DELETE FROM bot_media WHERE id = $1 RETURNING slot', [
    id,
  ]);
  if (r.rows[0]) cache.delete(r.rows[0].slot);
}

export function invalidateMediaCache(slot?: string): void {
  if (slot) cache.delete(slot);
  else cache.clear();
}

export async function formatContextForPrompt(slot: string): Promise<string | null> {
  const rows = (await listBySlot(slot)).filter(
    (row) => row.enabled && (row.context || row.caption),
  );
  if (!rows.length) return null;

  return rows
    .map((row) => {
      const details = [
        `- ${row.position} (${row.media_type})`,
        row.context ? `contexto interno: ${row.context}` : null,
        row.caption ? `caption visivel: ${row.caption}` : null,
      ].filter(Boolean);
      return details.join('\n  ');
    })
    .join('\n');
}
