import { describe, expect, it } from 'vitest';
import { extractPhone, toChatId } from './phone.js';
import type { WahaWebhookBody } from './types.js';

const base = {
  event: 'message',
  session: 'TESTE_STARTAP',
  payload: {
    id: 'abc',
    fromMe: false,
  },
} satisfies Partial<WahaWebhookBody>;

describe('extractPhone', () => {
  it('lê do `from` quando addressingMode = pn', () => {
    const body = {
      ...base,
      payload: {
        ...base.payload,
        from: '5535999998888@c.us',
        _data: { key: { addressingMode: 'pn' } },
      },
    } as WahaWebhookBody;
    expect(extractPhone(body)).toBe('5535999998888');
  });

  it('lê de remoteJidAlt quando addressingMode = lid', () => {
    const body = {
      ...base,
      payload: {
        ...base.payload,
        from: '30777769214195@lid',
        _data: {
          key: { addressingMode: 'lid', remoteJidAlt: '553598877248@s.whatsapp.net' },
        },
      },
    } as WahaWebhookBody;
    expect(extractPhone(body)).toBe('553598877248');
  });

  it('retorna null quando nada plausível', () => {
    const body = { ...base, payload: { ...base.payload } } as WahaWebhookBody;
    expect(extractPhone(body)).toBeNull();
  });
});

describe('toChatId', () => {
  it('formata número limpo em chat_id', () => {
    expect(toChatId('55 35 99999-8888')).toBe('5535999998888@c.us');
  });
});
