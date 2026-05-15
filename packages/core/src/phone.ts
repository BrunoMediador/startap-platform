/**
 * Parser de telefone a partir do payload WAHA.
 *
 * Por que existe: WhatsApp tem 2 modos de endereçamento ("addressingMode"):
 *  - "pn"  → payload.from contém o número de telefone direto
 *  - "lid" → payload.from contém um LID opaco; o número real está em
 *           payload._data.key.remoteJidAlt
 *
 * Esta função abstrai essa lógica. Sempre retorna apenas dígitos (com DDI).
 */
import type { WahaWebhookBody } from './types.js';

/** Extrai telefone "real" do payload WAHA. Retorna string de dígitos (ex: 5535999998888) ou null. */
export function extractPhone(body: WahaWebhookBody): string | null {
  const payload = body.payload;
  if (!payload) return null;

  const mode = payload._data?.key?.addressingMode;
  const raw =
    mode === 'pn' ? (payload.from ?? '') : (payload._data?.key?.remoteJidAlt ?? payload.from ?? '');

  const cleaned = raw
    .replace('@c.us', '')
    .replace('@s.whatsapp.net', '')
    .replace('@lid', '')
    .replace(/\D/g, '');

  return cleaned.length >= 10 ? cleaned : null;
}

/** Retorna o chat_id original (do campo `from`), preservando @c.us / @lid. */
export function extractChatId(body: WahaWebhookBody): string {
  return body.payload?.from ?? '';
}

/** Formata um telefone bruto para um chat_id válido WhatsApp (`5535...@c.us`). */
export function toChatId(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `${digits}@c.us`;
}
