/**
 * Dedup de evento de mensagem WAHA (ADR 0019, passo 2).
 *
 * O ADR documentou que o comentario em webhook-waha.ts afirmava existir um
 * "dedupe de event.id" que NA REALIDADE nunca foi implementado. Este modulo e a
 * implementacao real, atras da flag IDEMPOTENCY_DEDUP (default OFF).
 *
 * Primitivo: SET dedup:msg:<sessao>:<messageId> 1 NX EX <ttl>.
 *  - chave NOVA  -> SET retorna 'OK'  -> primeira vez vendo este evento -> PROCESSA.
 *  - chave EXISTE -> SET retorna null -> retry/duplicata da WAHA          -> PULA.
 *
 * FAIL-OPEN (regra dura do ADR): se o Redis estiver inacessivel, der timeout ou
 * qualquer erro, retornamos { duplicate: false, degraded: true } -> o chamador
 * PROCESSA a mensagem mesmo assim. Idempotencia e protecao contra duplicata, nao
 * pode virar ponto de falha que silencia o bot de um cliente. Vira fail-closed
 * so no scale-out (passo 5 do ADR, decisao do Bruno).
 *
 * Com 1 instancia o SET NX sempre adquire (nunca ha corrida real), entao isto e
 * funcionalmente inocuo — serve pra OBSERVAR quantos retries a WAHA reenvia hoje
 * (dado que nao temos) via o log reason=dedup.
 */
import { logger } from '@startap/core/logger';
import { config } from '../config.js';
import { getRedis } from './redis.js';

const log = logger.child({ module: 'idempotency' });

export interface DedupResult {
  /** true = evento ja visto (retry/duplicata) -> chamador deve PULAR. */
  duplicate: boolean;
  /** true = check nao pode ser feito (Redis down/timeout/sem id) -> fail-open. */
  degraded: boolean;
}

/** Envolve uma promise com timeout; rejeita se estourar. */
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

/**
 * Marca um evento de mensagem como processado de forma atomica (SET NX EX).
 * Retorna se e duplicata. NUNCA lanca — em qualquer falha, fail-open.
 *
 * @param sessao    sessao WAHA (parte da chave de granularidade do evento)
 * @param messageId id estavel do evento WAHA (payload.id)
 */
export async function checkAndMarkDuplicate(
  sessao: string,
  messageId: string,
): Promise<DedupResult> {
  // Sem id estavel nao da pra deduplicar com seguranca — fail-open (processa).
  // Algumas engines/eventos podem nao trazer payload.id; nunca dropamos por isso.
  if (!messageId) {
    return { duplicate: false, degraded: true };
  }

  const key = `dedup:msg:${sessao}:${messageId}`;
  try {
    const redis = getRedis();
    // SET key 1 NX EX <ttl>: atomico. 'OK' = setou agora (novo); null = ja existia.
    const res = await withTimeout(
      redis.set(key, '1', 'EX', config.IDEMPOTENCY_DEDUP_TTL_SECONDS, 'NX'),
      config.IDEMPOTENCY_REDIS_TIMEOUT_MS,
      'redis.set',
    );
    const isNew = res === 'OK';
    return { duplicate: !isNew, degraded: false };
  } catch (err) {
    // Redis indisponivel/timeout: FAIL-OPEN. Loga warn e deixa processar.
    log.warn(
      { err: err instanceof Error ? err.message : String(err), sessao },
      'Dedup Redis indisponivel — fail-open (processando mensagem)',
    );
    return { duplicate: false, degraded: true };
  }
}
