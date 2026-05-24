import { describe, expect, it } from 'vitest';
import { extractPhone, isGroupChat, toChatId } from './phone.js';
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

describe('isGroupChat', () => {
  function makeBody(overrides: Partial<NonNullable<WahaWebhookBody['payload']>>): WahaWebhookBody {
    return {
      event: 'message',
      session: 'test',
      payload: {
        id: 'msg-1',
        fromMe: false,
        ...overrides,
      },
    };
  }

  it('detecta grupo por @g.us no from', () => {
    expect(isGroupChat(makeBody({ from: '120363141126402430@g.us' }))).toBe(true);
  });

  it('detecta grupo por prefixo 120363 no from (sem sufixo @g.us)', () => {
    expect(isGroupChat(makeBody({ from: '120363049484570625' }))).toBe(true);
  });

  it('detecta grupo por campo participant preenchido', () => {
    const body = makeBody({ from: '5592813522781591200729' }) as Record<string, unknown>;
    (body['payload'] as Record<string, unknown>)['participant'] = '55928135@c.us';
    expect(isGroupChat(body as WahaWebhookBody)).toBe(true);
  });

  it('detecta grupo por LID de 22+ digitos com participant (NOWEB bug)', () => {
    const body = makeBody({ from: '5592813522781591200729' }) as Record<string, unknown>;
    (body['payload'] as Record<string, unknown>)['participant'] = '5592813522781@s.whatsapp.net';
    expect(isGroupChat(body as WahaWebhookBody)).toBe(true);
  });

  it('nao detecta grupo em conversa 1:1 com @c.us', () => {
    expect(isGroupChat(makeBody({ from: '5535999998888@c.us' }))).toBe(false);
  });

  it('nao detecta grupo em conversa 1:1 com @s.whatsapp.net', () => {
    expect(isGroupChat(makeBody({ from: '553598877248@s.whatsapp.net' }))).toBe(false);
  });

  it('nao detecta grupo em LID 1:1 sem campo participant', () => {
    expect(isGroupChat(makeBody({ from: '30777769214195@lid' }))).toBe(false);
  });

  it('nao detecta grupo quando payload e null', () => {
    const body: WahaWebhookBody = { event: 'message', session: 'test', payload: null };
    expect(isGroupChat(body)).toBe(false);
  });

  it('nao detecta grupo com participant vazio string', () => {
    const body = makeBody({ from: '5535999998888@c.us' }) as Record<string, unknown>;
    (body['payload'] as Record<string, unknown>)['participant'] = '';
    expect(isGroupChat(body as WahaWebhookBody)).toBe(false);
  });
});
