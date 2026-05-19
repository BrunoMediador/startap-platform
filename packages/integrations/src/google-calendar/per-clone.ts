/**
 * per-clone.ts — resolve o GoogleCalendarClient correto para um slot clone.
 *
 * Por que existe: bots-matriz usam OAuth global (legacy). Clones usam Service Account
 * própria gravada em flow_clones.gcal_credentials_json. Este helper faz o lookup e
 * retorna o client já bound ao calendarId do clone, ou null quando o slot é uma
 * matriz / ainda não tem gcal configurado.
 *
 * Cache em memória de 5 minutos por slot evita SELECT a cada turno de chat.
 * Invalidação acontece quando recebemos erro 401/403 do Google (ver invalidateGcalCache).
 */
import { query } from '@startap/db';
import { GoogleCalendarClient } from './client.js';

interface CacheEntry {
  client: GoogleCalendarClient | null;
  expiresAt: number;
}

// Chave: slot → entry. null significa "slot sem gcal configurado".
const cache = new Map<string, CacheEntry>();

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

interface GcalCloneRow {
  gcal_credentials_json: string | null;
  gcal_calendar_id: string | null;
  gcal_status: string | null;
}

/**
 * Retorna GoogleCalendarClient bound ao slot clone, ou null se:
 * - O slot não existe em flow_clones (é uma matriz ou entrada inválida).
 * - gcal_status != 'active'.
 * - gcal_credentials_json ou gcal_calendar_id estão ausentes.
 */
export async function getGcalForSlot(slot: string): Promise<GoogleCalendarClient | null> {
  const now = Date.now();
  const cached = cache.get(slot);
  if (cached && cached.expiresAt > now) {
    return cached.client;
  }

  const result = await query<GcalCloneRow>(
    `SELECT gcal_credentials_json, gcal_calendar_id, gcal_status
     FROM flow_clones
     WHERE slot = $1
     LIMIT 1`,
    [slot],
  );

  const row = result.rows[0];

  if (!row || row.gcal_status !== 'active' || !row.gcal_credentials_json || !row.gcal_calendar_id) {
    cache.set(slot, { client: null, expiresAt: now + CACHE_TTL_MS });
    return null;
  }

  const client = new GoogleCalendarClient({
    credentialsJson: row.gcal_credentials_json,
    calendarId: row.gcal_calendar_id,
  });

  cache.set(slot, { client, expiresAt: now + CACHE_TTL_MS });
  return client;
}

/**
 * Invalida a entrada de cache para o slot informado.
 * Deve ser chamado quando operações gcal retornam 401/403, forçando
 * re-leitura das credenciais no próximo turno.
 */
export function invalidateGcalCache(slot: string): void {
  cache.delete(slot);
}
