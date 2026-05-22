/**
 * per-clone.ts — resolve o GoogleCalendarClient correto para um slot (clone ou matriz).
 *
 * REGRA DE ROTEAMENTO (dois caminhos distintos):
 *
 * 1. CLONES (slot começa com "clone_"):
 *    Lookup SOMENTE em flow_clones. Se não achar gcal_status='active' +
 *    gcal_credentials_json + gcal_calendar_id, retorna null.
 *    SEM fallback para bot_config — evita que clone sem GCal próprio use
 *    silenciosamente a agenda da matriz (vazamento cross-tenant inaceitável).
 *    Cirilo e Ricardo continuam isolados.
 *
 * 2. MATRIZES / BOTS INTERNOS (slot NÃO começa com "clone_"):
 *    Lookup em bot_config WHERE slot=$1. Matrizes (teste_barbearia,
 *    teste_vendas_barbearia, etc.) e bots internos (startap) têm GCal
 *    configurado diretamente nessa tabela. Não há risco cross-tenant porque
 *    bot_config é keyed por slot — não existe "outra fonte" que vaze.
 *    Se gcal_status != 'active' ou creds ausentes, retorna null normalmente.
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
 * Retorna GoogleCalendarClient bound ao slot, ou null se GCal não configurado.
 *
 * - Clones (slot começa com "clone_"): busca em flow_clones. Sem fallback.
 * - Matrizes/bots internos (demais slots): busca em bot_config.
 *
 * Retorna null se gcal_status != 'active' ou creds ausentes (em qualquer caminho).
 */
export async function getGcalForSlot(slot: string): Promise<GoogleCalendarClient | null> {
  const now = Date.now();
  const cached = cache.get(slot);
  if (cached && cached.expiresAt > now) {
    return cached.client;
  }

  const isClone = slot.startsWith('clone_');

  let row: GcalRow | undefined;

  if (isClone) {
    // Clones: lookup exclusivo em flow_clones — sem fallback para bot_config.
    // Garante isolamento: clone sem GCal próprio nunca usa agenda da matriz.
    const result = await query<GcalRow>(
      `SELECT gcal_credentials_json, gcal_calendar_id, gcal_status
       FROM flow_clones
       WHERE slot = $1
       LIMIT 1`,
      [slot],
    );
    row = result.rows[0];
  } else {
    // Matrizes e bots internos: lookup em bot_config.
    // Não há risco cross-tenant — bot_config é keyed por slot único.
    const result = await query<GcalRow>(
      `SELECT gcal_credentials_json, gcal_calendar_id, gcal_status
       FROM bot_config
       WHERE slot = $1
       LIMIT 1`,
      [slot],
    );
    row = result.rows[0];
  }

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
