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

/**
 * Detecta se um payload WAHA é de um grupo (não chat 1:1).
 *
 * Critérios (qualquer um basta):
 *  1. payload.from termina em @g.us  — chatId explícito de grupo
 *  2. payload.from começa com 120363 — JID de grupo padrão NOWEB/Baileys
 *  3. payload.participant está presente e não vazio — campo só existe em msgs de grupo
 *
 * IDs de ~22+ dígitos (ex: 5592813522781591200729) são LIDs malformados gerados
 * pelo NOWEB para participantes de grupo — eles SEMPRE vêm acompanhados de
 * `participant`, portanto já são capturados pelo critério 3.
 *
 * @returns true se for mensagem de grupo — deve ser ignorada pelo router.
 */
export function isGroupChat(body: WahaWebhookBody): boolean {
  const payload = body.payload;
  if (!payload) return false;

  const from = payload.from ?? '';

  // Critério 1: @g.us explícito
  if (from.endsWith('@g.us')) return true;

  // Critério 2: JID de grupo NOWEB começa com 120363 (antes de @)
  const jidLocal = from.split('@')[0] ?? '';
  if (jidLocal.startsWith('120363')) return true;

  // Critério 3: campo participant presente — exclusivo de mensagens em grupo
  const p = payload as Record<string, unknown>;
  const participant = p['participant'];
  if (typeof participant === 'string' && participant.length > 0) return true;

  return false;
}
