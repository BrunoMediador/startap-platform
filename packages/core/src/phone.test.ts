import { describe, expect, it } from 'vitest';
import { canonicalE164, extractPhone, isGroupChat, phoneHint, toChatId } from './phone.js';
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

// ── canonicalE164 / phoneHint (Missão 020 F1 — identidade do trial) ───────────

describe('canonicalE164', () => {
  it('canonicaliza móvel BR de 13 dígitos removendo o 9º dígito', () => {
    expect(canonicalE164('5531999998842')).toBe('553199998842');
  });

  it('mantém BR de 12 dígitos (sem o 9) como canônico', () => {
    expect(canonicalE164('553199998842')).toBe('553199998842');
  });

  it('13 e 12 dígitos do MESMO número convergem (Baileys ora manda com, ora sem o 9)', () => {
    expect(canonicalE164('5531999998842')).toBe(canonicalE164('553199998842'));
  });

  it('aceita máscara BR sem DDI e prefixa 55', () => {
    expect(canonicalE164('(31) 99999-8842')).toBe('553199998842');
  });

  it('aceita local BR de 10 dígitos (fixo, sem 9) e prefixa 55', () => {
    expect(canonicalE164('3133334444')).toBe('553133334444');
  });

  it('corta sufixos de me.id do WAHA (":device" e "@dominio")', () => {
    expect(canonicalE164('5531999998842:12@s.whatsapp.net')).toBe('553199998842');
    expect(canonicalE164('553199998842@c.us')).toBe('553199998842');
  });

  it('remove prefixo tronco 0 (discagem com operadora)', () => {
    expect(canonicalE164('031999998842')).toBe('553199998842');
  });

  it('número internacional não-BR (12+ dígitos) passa como dígitos', () => {
    expect(canonicalE164('447911123456')).toBe('447911123456');
  });

  it('10/11 dígitos são SEMPRE tratados como BR local (produto BR)', () => {
    // 11 dígitos ambíguos (poderia ser +1 US) viram BR — decisão de domínio.
    expect(canonicalE164('31999998842')).toBe('553199998842');
  });

  it('rejeita entradas irrecuperáveis', () => {
    expect(canonicalE164('')).toBeNull();
    expect(canonicalE164('abc')).toBeNull();
    expect(canonicalE164('999')).toBeNull();
    expect(canonicalE164('55319')).toBeNull();
  });
});

describe('phoneHint', () => {
  it('mascara BR: só DDD + 2 últimos dígitos visíveis', () => {
    expect(phoneHint('553199998842')).toBe('+55 31 •••••-••42');
  });

  it('nunca contém o número completo', () => {
    const hint = phoneHint('553199998842');
    expect(hint).not.toContain('99998842');
  });
});
