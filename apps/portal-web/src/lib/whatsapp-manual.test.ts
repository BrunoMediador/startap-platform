import { describe, expect, it } from 'vitest';
import {
  WHATSAPP_MANUAL_MESSAGE_MAX_LENGTH,
  canReviewWhatsAppManualMessage,
  normalizeWhatsAppManualMessage,
} from './whatsapp-manual';

describe('WhatsApp manual helpers', () => {
  it('só libera a confirmação para uma mensagem não vazia dentro do limite', () => {
    expect(normalizeWhatsAppManualMessage('  Olá!\r\nTudo bem?  ')).toBe('Olá!\nTudo bem?');
    expect(canReviewWhatsAppManualMessage('   ')).toBe(false);
    expect(canReviewWhatsAppManualMessage('Olá!')).toBe(true);
    expect(canReviewWhatsAppManualMessage('a'.repeat(WHATSAPP_MANUAL_MESSAGE_MAX_LENGTH + 1))).toBe(
      false,
    );
  });
});
