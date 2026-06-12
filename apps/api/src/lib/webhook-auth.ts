/**
 * Autenticação do webhook WAHA por secret compartilhado (P0 security — review do PR #268).
 *
 * Design RETROCOMPATÍVEL (lição do incidente #247: env nova JAMAIS obrigatória no boot):
 *  - WAHA_WEBHOOK_SECRET AUSENTE  -> comportamento atual (aceita tudo) + warn no boot.
 *  - WAHA_WEBHOOK_SECRET PRESENTE -> exige header X-Webhook-Secret com match exato
 *    (comparação constant-time). Mismatch/ausente -> 401 SEM processar nada.
 *
 * O WAHA envia o header via `webhooks[].customHeaders` na config de cada sessão
 * (ativação em prod: docs/runbooks/runbook-waha-webhook-auth.md). O nome do header é
 * contrato NOSSO — se mudar aqui, mudar também no painel-admin (server.js —
 * buildWahaWebhooks) e na config de cada sessão WAHA.
 *
 * Lógica pura (sem Fastify) pra teste unit. Espelho do safeEqual de
 * packages/integrations/src/abacatepay/webhook.ts — NÃO importamos de lá pra não
 * acoplar o webhook WAHA ao módulo de pagamento (subpath isolado por design, C10).
 */
import { timingSafeEqual } from 'node:crypto';

/** Nome do header que carrega o secret (lowercase — Fastify normaliza headers). */
export const WAHA_WEBHOOK_SECRET_HEADER = 'x-webhook-secret';

/**
 * Compara dois segredos em tempo constante (anti-timing-attack). Tamanhos
 * diferentes retornam false sem early-return distinguível por timing sobre o
 * conteúdo (timingSafeEqual lança em buffers de tamanhos distintos).
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Comparação dummy pra manter custo ~constante; o tamanho já vazaria de
    // qualquer forma. Resultado: false.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Decide se a request do webhook WAHA está autorizada.
 *
 * @param provided valor cru do header como vem de req.headers (string | string[] | undefined)
 * @param expected WAHA_WEBHOOK_SECRET do ambiente (undefined/vazio = auth DESLIGADA)
 * @returns true = processa; false = 401 sem processar nada
 */
export function isWahaWebhookAuthorized(
  provided: string | string[] | undefined,
  expected: string | undefined,
): boolean {
  // Retrocompat: sem env, aceita tudo (warn discreto no boot do server.ts).
  if (!expected) return true;
  const value = Array.isArray(provided) ? provided[0] : provided;
  if (!value) return false;
  return safeEqual(value, expected);
}
