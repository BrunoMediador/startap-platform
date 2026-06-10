/**
 * Validacao e parsing do webhook AbacatePay (ADR 0013, F2).
 *
 * Controles do threat-model implementados aqui (logica pura, testavel sem HTTP):
 *   - C3/C6: HMAC-SHA256 base64 sobre o RAW BODY (buffer cru), comparacao timing-safe.
 *   - C6:    query secret comparado timing-safe.
 *   - C5:    redacao de PII do payload antes de persistir (sem CPF/email/telefone/brCode).
 *
 * O handler HTTP (apps/api) preserva o raw body (parser escopado), chama
 * verifyWebhookSecret + verifyWebhookSignature ANTES de tocar o banco, e usa
 * redactWebhookPayload no que vai pra billing_webhook_events.
 *
 * NUNCA loga brCode/CPF/email/telefone. Mensagens de erro nao revelam qual etapa
 * falhou (C6 — 401 sem distinguir secret de assinatura).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Compara dois segredos em tempo constante (anti-timing-attack). Strings de
 * tamanhos diferentes retornam false sem vazar o tamanho via early-return de
 * timingSafeEqual (que lanca em buffers de tamanhos distintos).
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Ainda faz uma comparacao pra nao criar um early-return distinguivel por timing
    // sobre conteudo; o tamanho ja vazaria de qualquer forma. Resultado: false.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Valida o query secret (?webhookSecret=) contra o segredo esperado (timing-safe).
 * Retorna false se qualquer um for vazio/ausente.
 */
export function verifyWebhookSecret(
  provided: string | undefined,
  expected: string | undefined,
): boolean {
  if (!provided || !expected) return false;
  return safeEqual(provided, expected);
}

/**
 * Valida o header X-Webhook-Signature: HMAC-SHA256 base64 do RAW BODY com a chave
 * compartilhada (timing-safe).
 *
 * @param rawBody Buffer cru do corpo (NUNCA o JSON re-serializado — C3).
 * @param signatureHeader valor recebido em X-Webhook-Signature (base64).
 * @param secret chave compartilhada do AbacatePay (ABACATEPAY_WEBHOOK_SECRET / publica do webhook).
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string | undefined,
): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
  return safeEqual(signatureHeader, expected);
}

// ─── C5: redacao de PII do payload antes de persistir ──────────────────────────

/**
 * Chaves que NUNCA podem ser persistidas em billing_webhook_events (LGPD — C5).
 * Cobre variacoes de casing/idioma vistas em gateways. Comparacao case-insensitive.
 */
const PII_KEYS = new Set(
  [
    'brcode',
    'brcodebase64',
    'br_code',
    'br_code_base64',
    'pixqrcode',
    'qrcode',
    'taxid',
    'tax_id',
    'cpf',
    'cnpj',
    'document',
    'email',
    'e_mail',
    'phone',
    'telephone',
    'cellphone',
    'celular',
    'telefone',
    'name',
    'fullname',
    'customername',
    'payername',
    'receipturl',
    'receipt_url',
  ].map((k) => k.toLowerCase()),
);

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;

/**
 * Redige recursivamente PII de um payload arbitrario (objeto/array/primitivo).
 * Chaves sensiveis (PII_KEYS) viram '[REDACTED]'; o resto e mantido pra auditoria.
 * Defensivo contra payload profundo/ciclico (MAX_DEPTH).
 *
 * Retorna uma COPIA — nao muta a entrada.
 */
export function redactWebhookPayload(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((v) => redactWebhookPayload(v, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (PII_KEYS.has(key.toLowerCase())) {
      out[key] = REDACTED;
    } else {
      out[key] = redactWebhookPayload(v, depth + 1);
    }
  }
  return out;
}

// ─── Parsing do envelope do evento ──────────────────────────────────────────────

export interface ParsedWebhookEvent {
  /** envelope.id — chave de dedupe (C4). */
  eventId: string;
  /** tipo do evento (ex 'transparent.completed'). */
  event: string;
  /** status normalizado em minusculas (ex 'paid'). */
  status: string;
  /** id da cobranca no gateway ('pix_char_*') — casa com billing_charges. */
  abacateChargeId: string | null;
  /** externalId enviado na criacao ("{slot}-{cycle}") — gancho secundario. */
  externalId: string | null;
  /** valor pago em centavos (paidAmount) — usado na reconciliacao (C2). */
  paidAmountCents: number | null;
  /** receipt_url (dado restrito). */
  receiptUrl: string | null;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function intOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)))
    return Math.round(Number(v));
  return null;
}

/**
 * Extrai os campos relevantes do envelope do webhook AbacatePay de forma tolerante.
 * O AbacatePay aninha a cobranca em data.transparent (transparent.completed); aceita
 * tambem data.charge / data plano (resiliencia a variacoes de envelope/mocks).
 *
 * Retorna null se faltar o id do evento — sem id de evento nao ha dedupe (C4).
 */
export function parseWebhookEvent(body: unknown): ParsedWebhookEvent | null {
  const root = asObj(body);
  if (!root) return null;

  const eventId = str(root.id) ?? str(root.event_id) ?? str(root.eventId);
  const event = str(root.event) ?? str(root.type) ?? 'unknown';
  if (!eventId) return null;

  const data = asObj(root.data) ?? root;
  const charge = asObj(data.transparent) ?? asObj(data.charge) ?? asObj(data.pixQrCode) ?? data;

  const status = (str(charge.status) ?? str(data.status) ?? str(root.status) ?? '').toLowerCase();

  const abacateChargeId = str(charge.id) ?? str(data.id);
  const externalId = str(charge.externalId) ?? str(data.externalId) ?? str(charge.external_id);
  const paidAmountCents =
    intOrNull(charge.paidAmount) ??
    intOrNull(charge.paid_amount) ??
    intOrNull(data.paidAmount) ??
    intOrNull(charge.amount) ??
    intOrNull(data.amount);
  const receiptUrl = str(charge.receiptUrl) ?? str(data.receiptUrl) ?? str(charge.receipt_url);

  return {
    eventId,
    event,
    status,
    abacateChargeId,
    externalId,
    paidAmountCents,
    receiptUrl,
  };
}
