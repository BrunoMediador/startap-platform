/**
 * per-clone.ts — resolve o GoogleCalendarClient correto para um slot de clone.
 *
 * Por que existe: cada clone tem Service Account própria gravada em flow_clones.
 * Este helper faz o lookup SOMENTE em flow_clones e retorna o client já bound ao
 * calendarId correto, ou null quando o clone ainda não tem gcal configurado.
 *
 * ISOLAMENTO: NÃO há fallback para bot_config (matriz). Se o clone não tiver
 * gcal_status='active' + gcal_credentials_json + gcal_calendar_id em flow_clones,
 * retorna null. Isso evita que clones sem GCal próprio usem silenciosamente a
 * agenda da matriz (vazamento cross-tenant). Callers já tratam null retornando
 * mensagem de erro ao usuário (ver teste_barbearia.ts e teste_vendas_barbearia.ts).
 *
 * Cache em memória de 5 minutos por slot evita SELECT a cada turno de chat.
 * Invalidação acontece quando recebemos erro 401/403 do Google (ver invalidateGcalCache).
 */
import { query } from '@startap/db';
import { decryptSecret } from '@startap/core';
import { GoogleCalendarClient } from './client.js';

interface CacheEntry {
  client: GoogleCalendarClient | null;
  expiresAt: number;
}

// Chave: slot → entry. null significa "slot sem gcal configurado".
const cache = new Map<string, CacheEntry>();

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

interface GcalRow {
  gcal_credentials_json: string | null;
  gcal_calendar_id: string | null;
  gcal_status: string | null;
}

/**
 * Retorna GoogleCalendarClient bound ao slot do clone, ou null se:
 * - O slot não existe em flow_clones.
 * - gcal_status != 'active'.
 * - gcal_credentials_json ou gcal_calendar_id estão ausentes.
 *
 * NUNCA faz fallback para bot_config (matriz): cada clone deve ter suas próprias
 * credenciais GCal. Sem isso, clones sem GCal próprio usariam silenciosamente a
 * agenda da matriz — vazamento cross-tenant inaceitável.
 */
export async function getGcalForSlot(slot: string): Promise<GoogleCalendarClient | null> {
  const now = Date.now();
  const cached = cache.get(slot);
  if (cached && cached.expiresAt > now) {
    return cached.client;
  }

  // Lookup exclusivo em flow_clones — sem fallback para bot_config.
  const result = await query<GcalRow>(
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
    credentialsJson: decryptSecret(row.gcal_credentials_json),
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
