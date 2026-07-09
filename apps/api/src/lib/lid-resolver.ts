/**
 * Resolução LID → telefone E.164 para o ramo fromMe do modo atendente (SCRUM-63).
 *
 * PROBLEMA: pós-migração LID do WhatsApp, o store da engine NOWEB fica LID-first —
 * contatos migrados são endereçados por `<lid>@lid` (identificador opaco, NÃO telefone).
 * O eco fromMe do bot (e respostas manuais do dono) a um contato migrado chega por `@lid`
 * SEM o `remoteJidAlt`; extractPhone cai no pseudo-número do lid. Consequência (evidência
 * de prod, Meduzza): (a) a marca anti-eco (por E.164) NÃO casa → eco vira 'human' → pausa
 * human_reply FANTASMA pro pseudo-lid; (b) resposta manual real a contato migrado cria a
 * pausa na chave errada → o bot NÃO pausa de verdade.
 *
 * SOLUÇÃO: resolver `@lid`→E.164 ANTES de qualquer decisão do ramo fromMe (self-chat, eco,
 * keyword, pausa), na ordem:
 *   1) payload-first — o par lid/pn que o Baileys moderno anexa (remoteJidAlt/senderPn/…);
 *   2) cache Redis (mapeamento estável, TTL 24h) + cache NEGATIVO curto (60s);
 *   3) fallback REST `GET /api/{session}/lids/{lid}` (timeout curto);
 *   4) falhou tudo → FAIL-SAFE: retorna phone=null; o chamador NÃO cria pausa nenhuma.
 *
 * Envio NÃO muda: o bot segue enviando pro chatId original (telefone@c.us / o `@lid`), a
 * engine resolve sozinha. Este módulo só corrige a IDENTIDADE usada nas decisões de pausa.
 */
import { logger } from '@startap/core/logger';
import { extractLidDigits, extractPnFromPayload } from '@startap/core/phone';
import type { WahaWebhookBody } from '@startap/core/types';
import { waha } from '@startap/integrations';
import { getRedis } from './redis.js';

const log = logger.child({ module: 'lid-resolver' });

/** TTL do cache POSITIVO lid→pn. O mapeamento é estável (não muda para o contato). */
const POSITIVE_TTL_SECONDS = 24 * 60 * 60;
/** TTL do cache NEGATIVO (não resolveu): curto, para retomar rápido quando a WAHA voltar. */
const NEGATIVE_TTL_SECONDS = 60;
/** Timeout da chamada REST /lids/{lid} — curto, hot path do webhook. */
const LID_LOOKUP_TIMEOUT_MS = 1_500;
/** Marcador de cache negativo (distingue "não resolve" de "cache vazio"). */
const NEG_MARKER = '__none__';
/** Timeout do Redis — nunca pendurar o webhook num hiccup de cache. */
const REDIS_TIMEOUT_MS = 500;

export interface FromMeIdentity {
  /**
   * Telefone E.164 (só dígitos) pronto para TODAS as decisões do ramo fromMe (self-chat,
   * eco, keyword, pausa). `null` = o chat era `@lid` e NÃO deu para resolver o pn →
   * FAIL-SAFE: o chamador NÃO deve criar pausa nenhuma.
   */
  phone: string | null;
  /** true se o chat era endereçado por `@lid` (contato migrado pós-LID). */
  wasLid: boolean;
  /** Como resolveu (observabilidade): not-lid | payload | cache | cache-neg | rest | none. */
  via: 'not-lid' | 'payload' | 'cache' | 'cache-neg' | 'rest' | 'none';
}

function cacheKey(session: string, lid: string): string {
  return `lid-pn:${session}:${lid}`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Hint mascarado do lid para log (não é PII de telefone, mas evitamos vazar o id inteiro). */
function lidHint(lid: string): string {
  return lid.length <= 6 ? '••••' : `${lid.slice(0, 4)}…${lid.slice(-2)}`;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function getCached(session: string, lid: string): Promise<string | null> {
  try {
    const redis = getRedis();
    return await withTimeout(redis.get(cacheKey(session, lid)), REDIS_TIMEOUT_MS, 'redis.get');
  } catch (err) {
    log.warn({ err: errMsg(err), session }, 'lid-resolver: cache get falhou (segue sem cache)');
    return null;
  }
}

async function setCached(
  session: string,
  lid: string,
  value: string,
  ttlSeconds: number,
): Promise<void> {
  try {
    const redis = getRedis();
    await withTimeout(
      redis.set(cacheKey(session, lid), value, 'EX', ttlSeconds),
      REDIS_TIMEOUT_MS,
      'redis.set',
    );
  } catch (err) {
    log.warn({ err: errMsg(err), session }, 'lid-resolver: cache set falhou (best-effort)');
  }
}

/**
 * Resolve a identidade (telefone E.164) de uma mensagem fromMe, tratando contato migrado
 * (`@lid`). Ver o cabeçalho do módulo para a estratégia. `extractedPhone` é o resultado
 * de extractPhone (usado como está quando NÃO é lid → byte-idêntico ao comportamento atual).
 */
export async function resolveFromMeIdentity(
  session: string,
  body: WahaWebhookBody,
  extractedPhone: string,
): Promise<FromMeIdentity> {
  const lid = extractLidDigits(body);

  // Não é `@lid` → o telefone já veio real do extractPhone (inbound resolve por
  // remoteJidAlt). Byte-idêntico para TODO contato não-migrado.
  if (!lid) return { phone: extractedPhone, wasLid: false, via: 'not-lid' };

  // (1) payload-first: o par lid/pn que o Baileys moderno anexa ao webhook.
  const pnFromPayload = extractPnFromPayload(body);
  if (pnFromPayload) return { phone: pnFromPayload, wasLid: true, via: 'payload' };

  // (2) cache Redis (mapeamento estável) — inclui cache NEGATIVO curto.
  const cached = await getCached(session, lid);
  if (cached === NEG_MARKER) return { phone: null, wasLid: true, via: 'cache-neg' };
  if (cached) return { phone: cached, wasLid: true, via: 'cache' };

  // (3) fallback REST GET /api/{session}/lids/{lid} → { lid, pn }. Timeout curto; null-safe.
  let pn: string | null = null;
  try {
    pn = await waha.sessions.resolveLidToPn(session, lid, { timeoutMs: LID_LOOKUP_TIMEOUT_MS });
  } catch (err) {
    log.warn(
      { err: errMsg(err), session },
      'lid-resolver: lookup /lids lançou (tratado como null)',
    );
    pn = null;
  }
  if (pn) {
    await setCached(session, lid, pn, POSITIVE_TTL_SECONDS);
    return { phone: pn, wasLid: true, via: 'rest' };
  }

  // (4) fail-safe: sem pn → NÃO cria pausa. Cache negativo curto evita marretar a WAHA.
  await setCached(session, lid, NEG_MARKER, NEGATIVE_TTL_SECONDS);
  log.warn(
    { session, lidHint: lidHint(lid) },
    'lid-resolver: não resolveu @lid→telefone (fail-safe: sem pausa)',
  );
  return { phone: null, wasLid: true, via: 'none' };
}
