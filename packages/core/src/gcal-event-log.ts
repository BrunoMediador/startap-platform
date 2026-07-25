/**
 * SCRUM-90/91 (jurídico, LGPD art. 12 §2) — hash one-way do gcal_event_id para os LOGS
 * DURÁVEIS/exportáveis (worker + portal-api). O log NUNCA carrega o id cru; o BANCO mantém o
 * id CRU na linha (soft-deletada ou ativa), então a investigação continua possível cruzando
 * valor/forma/data + este hash. Determinístico (mesmo id → mesmo hash), sha256 hex truncado a
 * 16 chars com prefixo `sha256:`.
 *
 * Fonte ÚNICA da função (antes vivia só em apps/worker/src/jobs/gcal-atend-sync.ts) — o portal-api
 * logava o eventId CRU em ~16 pontos (SCRUM-91). Extraída pra cá pra os dois consumidores usarem
 * a MESMA transformação.
 *
 * NOTA (residual jurídico — item 2 do SCRUM-91): sha256 puro é reversível por dicionário/rainbow
 * se o espaço de ids for pequeno/enumerável. Para pseudonimização forte (HMAC com segredo), ver
 * SCRUM-91 item 2 (requer 1 chave secret) — fora do escopo desta entrega.
 */
import { createHash } from 'node:crypto';

/** Hash one-way (sha256 hex, 16 chars, prefixo `sha256:`) do gcal_event_id para logs duráveis. */
export function hashEventIdForLog(gcalEventId: string): string {
  return `sha256:${createHash('sha256').update(gcalEventId).digest('hex').slice(0, 16)}`;
}
