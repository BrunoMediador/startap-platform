/**
 * recent-contacts reimplementado limpo no portal-api (ADR 0012 / Missao 009).
 * NAO chama o endpoint do painel — replica a logica:
 *   1. tenta WAHA GET /api/{session}/chats (funciona quando store habilitado),
 *   2. fallback DB via message_log (chat_id = session) se WAHA falhar.
 *
 * Retorna { phone, name, last_interaction } — apenas individuais, sem grupos.
 * A session JA vem resolvida do clone do tenant (nunca de input do cliente).
 */
import { logger } from '@startap/core/logger';
import { query } from '@startap/db';

const log = logger.child({ service: 'portal-api', module: 'waha-contacts' });

const WAHA_URL = process.env.WAHA_URL ?? 'http://waha:3000';
const WAHA_API_KEY = process.env.WAHA_API_KEY ?? '';

const TIMEOUT_MS = 8_000;
const ENRICH_LIMIT = 30;
const RESPONSE_LIMIT = 100;

export interface RecentContact {
  phone: string;
  name: string | null;
  last_interaction: string; // ISO
}

interface WahaChat {
  id?: string;
  name?: string | null;
  conversationTimestamp?: number;
  timestamp?: number;
}

/** Fallback: telefones distintos que conversaram com a session em message_log. */
async function fallbackFromDB(session: string, days: number): Promise<RecentContact[]> {
  // Numero do PROPRIO bot (session), pra excluir da lista de contatos recentes.
  // Fonte correta: flow_clones.alert_owner_phone — autofilled com o me.id da sessao
  // ao conectar (alert-owner-autofill.ts), MESMO formato de digitos que message_log.phone
  // (extractPhone / meIdToDigits, com o 9). bot_config NAO tem coluna de numero (SCRUM-43:
  // 'SELECT waha_number FROM bot_config' era drift de schema e falhava ~26x/dia).
  let botPhone: string | null = null;
  try {
    const botRow = await query<{ alert_owner_phone: string | null }>(
      'SELECT alert_owner_phone FROM flow_clones WHERE waha_sessao = $1 LIMIT 1',
      [session],
    );
    botPhone = botRow.rows[0]?.alert_owner_phone ?? null;
  } catch {
    // fail-safe: sem o numero do bot, o filtro e ignorado (nao quebra recent-contacts)
  }

  const dbRows = await query<{ phone: string; last_at: Date }>(
    `SELECT phone, MAX(created_at) AS last_at
     FROM message_log
     WHERE chat_id = $1
       AND created_at > NOW() - ($2 || ' days')::interval
       AND LENGTH(phone) <= 15
       AND ($3::text IS NULL OR phone <> $3)
     GROUP BY phone
     ORDER BY last_at DESC
     LIMIT $4`,
    [session, String(days), botPhone, RESPONSE_LIMIT],
  );

  return dbRows.rows.map((row) => ({
    phone: row.phone,
    name: null,
    last_interaction: new Date(row.last_at).toISOString(),
  }));
}

/** Lista contatos recentes da session. days entre 1 e 30 (default 7). */
export async function getRecentContacts(
  session: string,
  days = 7,
): Promise<{ contacts: RecentContact[]; source: 'waha' | 'db' }> {
  // 1. tenta WAHA /chats
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let wahaOk = false;
  let chatsRaw: WahaChat[] = [];
  try {
    const r = await fetch(`${WAHA_URL}/api/${session}/chats`, {
      headers: WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {},
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (r.ok) {
      const json = (await r.json().catch(() => [])) as unknown;
      chatsRaw = Array.isArray(json) ? (json as WahaChat[]) : [];
      wahaOk = true;
    } else {
      log.info({ session, status: r.status }, 'WAHA /chats falhou — usando fallback DB');
    }
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : 'erro';
    log.info({ session, err: msg }, 'WAHA /chats erro — usando fallback DB');
  }

  if (!wahaOk) {
    const contacts = await fallbackFromDB(session, days);
    return { contacts, source: 'db' };
  }

  // 2. caminho WAHA: filtra individuais dentro da janela
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoffSec = nowSec - days * 86_400;

  const mapped = chatsRaw
    .filter((chat) => {
      const id = chat.id ?? '';
      if (id.endsWith('@g.us')) return false;
      if (!id.endsWith('@s.whatsapp.net') && !id.endsWith('@c.us')) return false;
      let ts = chat.conversationTimestamp ?? chat.timestamp ?? 0;
      if (ts > 1e12) ts = Math.floor(ts / 1000);
      return ts >= cutoffSec;
    })
    .map((chat) => {
      const id = chat.id ?? '';
      const phone = id.replace(/@s\.whatsapp\.net$|@c\.us$/, '');
      let ts = chat.conversationTimestamp ?? chat.timestamp ?? 0;
      if (ts > 1e12) ts = Math.floor(ts / 1000);
      return { phone, chatId: id, ts, name: chat.name ?? null };
    });

  mapped.sort((a, b) => b.ts - a.ts);
  const limited = mapped.slice(0, RESPONSE_LIMIT);

  // 3. enriquece pushName para os primeiros ENRICH_LIMIT chats
  const enrichBatch = limited.slice(0, ENRICH_LIMIT);
  const enrichResults = await Promise.allSettled(
    enrichBatch.map(async (item) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3_000);
      try {
        const r = await fetch(
          `${WAHA_URL}/api/${session}/chats/${encodeURIComponent(item.chatId)}`,
          { headers: WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {}, signal: ctrl.signal },
        );
        clearTimeout(t);
        if (!r.ok) return null;
        const data = (await r.json().catch(() => null)) as {
          name?: string;
          pushName?: string;
        } | null;
        return data?.name ?? data?.pushName ?? null;
      } catch {
        clearTimeout(t);
        return null;
      }
    }),
  );

  const contacts: RecentContact[] = limited.map((item, idx) => {
    let resolvedName = item.name;
    if (idx < ENRICH_LIMIT) {
      const settled = enrichResults[idx];
      if (settled?.status === 'fulfilled' && settled.value) resolvedName = settled.value;
    }
    return {
      phone: item.phone,
      name: resolvedName ?? null,
      last_interaction: new Date(item.ts * 1000).toISOString(),
    };
  });

  return { contacts, source: 'waha' };
}
