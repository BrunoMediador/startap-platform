export const WHATSAPP_MANUAL_MESSAGE_MAX_LENGTH = 1000;

export function normalizeWhatsAppManualMessage(message: string): string {
  return message.trim().replace(/\r\n/g, '\n');
}

export function canReviewWhatsAppManualMessage(message: string): boolean {
  const normalized = normalizeWhatsAppManualMessage(message);
  return normalized.length > 0 && normalized.length <= WHATSAPP_MANUAL_MESSAGE_MAX_LENGTH;
}
