/**
 * Autenticação do webhook WAHA (P0 security — review do PR #268 + spike 2026-06-11).
 *
 * Dois mecanismos, em ordem de precedência (decisão do spike — HMAC = plano A):
 *
 *  1. HMAC nativo do WAHA (`WAHA_WEBHOOK_HMAC_KEY`): a sessão WAHA é configurada com
 *     `webhooks[].hmac.key` e o WAHA assina o RAW BODY de cada POST (doc indica
 *     header X-Webhook-Hmac em hex + X-Webhook-Hmac-Algorithm: sha512; nomes
 *     configuráveis porque o OpenAPI da versão congelada 2026.3.2 não os crava —
 *     runbook confirma na cobaia). HMAC autentica E garante integridade do body;
 *     o secret NÃO viaja em cada request. HMAC sozinho BASTA: com a key
 *     configurada, o header estático é IGNORADO (mesmo se a env dele existir).
 *  2. Header estático (`WAHA_WEBHOOK_SECRET`, plano B): X-Webhook-Secret via
 *     `webhooks[].customHeaders`, match exato constant-time.
 *  3. Nenhuma env -> aceita tudo (comportamento atual) + warn no boot.
 *
 * Design RETROCOMPATÍVEL (lição do incidente #247: env nova JAMAIS obrigatória no
 * boot). Falha em qualquer modo -> 401 SEM processar nada.
 *
 * Ativação em prod: docs/runbooks/runbook-waha-webhook-auth.md. O nome do header
 * estático é contrato NOSSO — se mudar aqui, mudar também no painel-admin
 * (server.js — buildWahaWebhooks) e na config de cada sessão WAHA.
 *
 * Lógica pura (sem Fastify) pra teste unit. Espelho do safeEqual de
 * packages/integrations/src/abacatepay/webhook.ts — NÃO importamos de lá pra não
 * acoplar o webhook WAHA ao módulo de pagamento (subpath isolado por design, C10).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Nome do header que carrega o secret estático (lowercase — Fastify normaliza headers). */
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
 * Decide se a request do webhook WAHA está autorizada (modo header estático, plano B).
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

/** Modo de auth efetivo do webhook, derivado das envs (precedência: HMAC > estático). */
export type WahaWebhookAuthMode = 'hmac' | 'static-header' | 'open';

export function resolveWahaWebhookAuthMode(
  hmacKey: string | undefined,
  staticSecret: string | undefined,
): WahaWebhookAuthMode {
  if (hmacKey) return 'hmac';
  if (staticSecret) return 'static-header';
  return 'open';
}

/**
 * Verifica a assinatura HMAC nativa do WAHA sobre o RAW BODY (modo plano A).
 *
 * O digest esperado é hex (doc do WAHA); a comparação normaliza pra lowercase
 * (hex é case-insensitive) e usa safeEqual (constant-time). Qualquer byte do
 * body alterado em trânsito invalida a assinatura — integridade de graça.
 *
 * @param rawBody bytes CRUS da request, exatamente como chegaram (antes de QUALQUER parse)
 * @param provided valor cru do header da assinatura (string | string[] | undefined)
 * @param key WAHA_WEBHOOK_HMAC_KEY (a mesma de webhooks[].hmac.key na sessão WAHA)
 * @param algorithm 'sha512' (default da doc WAHA) ou 'sha256' (config de contingência)
 * @returns true = assinatura válida; false = 401 sem processar nada
 */
export function verifyWahaHmacSignature(
  rawBody: Buffer,
  provided: string | string[] | undefined,
  key: string,
  algorithm: 'sha256' | 'sha512',
): boolean {
  const value = Array.isArray(provided) ? provided[0] : provided;
  if (!value) return false;
  const expected = createHmac(algorithm, key).update(rawBody).digest('hex');
  return safeEqual(value.toLowerCase(), expected);
}
