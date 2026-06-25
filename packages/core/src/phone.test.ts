import { describe, expect, it } from 'vitest';
import {
  canonicalE164,
  ensureDddBr,
  extractPhone,
  isGroupChat,
  meIdToDigits,
  phoneHint,
  toChatId,
} from './phone.js';
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

describe('meIdToDigits — autofill do alert_owner_phone (preserva o 9, NÃO canonicaliza)', () => {
  it('PRESERVA o 9 do me.id de 13 dígitos (formato gravado nos pagantes)', () => {
    // canonicalE164 removeria o 9 (-> 12 díg); meIdToDigits NÃO — bate com o Cirilo.
    expect(meIdToDigits('5511979630828@c.us')).toBe('5511979630828');
  });

  it('mantém 12 dígitos sem o 9 como estão (me.id ao vivo do Samuel)', () => {
    expect(meIdToDigits('553591746797@c.us')).toBe('553591746797');
  });

  it('corta sufixo de device (":12") e domínio (@s.whatsapp.net)', () => {
    expect(meIdToDigits('5531999998842:12@s.whatsapp.net')).toBe('5531999998842');
  });

  it('remove o "+" inicial (me.id do Vitor vem com +)', () => {
    expect(meIdToDigits('+556599453860@c.us')).toBe('556599453860');
  });

  it('aceita máscara BR e devolve só dígitos (sem prefixar 55 — preserva o que veio)', () => {
    expect(meIdToDigits('(11) 97963-0828')).toBe('11979630828');
  });

  it('remove prefixo tronco 0 à esquerda', () => {
    expect(meIdToDigits('031999998842')).toBe('31999998842');
  });

  it('rejeita entrada curta/vazia/inválida -> null', () => {
    expect(meIdToDigits('')).toBeNull();
    expect(meIdToDigits('abc')).toBeNull();
    expect(meIdToDigits('123')).toBeNull();
  });
});

describe('ensureDddBr — DDI 55 conservador p/ pareamento (NÃO toca no 9)', () => {
  it('prefixa 55 em nacional de 10/11 díg SEM DDI (dragon: 3599247411 -> 553599247411)', () => {
    expect(ensureDddBr('3599247411')).toBe('553599247411');
  });

  it('NÃO toca em pagante de 13 díg COM o 9 (Cirilo 5511979630828 inalterado)', () => {
    expect(ensureDddBr('5511979630828')).toBe('5511979630828');
  });

  it('NÃO toca em pagante de 13 díg COM o 9 (Samuel 5535991746797 inalterado)', () => {
    expect(ensureDddBr('5535991746797')).toBe('5535991746797');
  });

  it('NÃO toca em 12 díg SEM o 9 com DDI (Seven7 556599453860 inalterado)', () => {
    expect(ensureDddBr('556599453860')).toBe('556599453860');
  });

  it('mantém qualquer número que já começa com 55 e tem 12-13 díg (não adiciona 9)', () => {
    expect(ensureDddBr('553599247411')).toBe('553599247411');
  });

  it('limpa envelope/máscara antes (mesma limpeza do meIdToDigits)', () => {
    expect(ensureDddBr('(11) 97963-0828')).toBe('5511979630828');
    expect(ensureDddBr('+556599453860@c.us')).toBe('556599453860');
    expect(ensureDddBr('031999998842')).toBe('5531999998842');
  });

  it('JID de grupo (18 díg, 120363...) -> null (não adivinha DDI)', () => {
    expect(ensureDddBr('120363141126402430')).toBeNull();
  });

  it('prefixo/comprimento estrangeiro inválido -> null', () => {
    // 13 díg começando com 44 (UK) não bate 55 nem é nacional de 10/11 -> null.
    expect(ensureDddBr('4479111234567')).toBeNull();
    // 12 díg com DDI 55 mas DDD inexistente (20) -> null.
    expect(ensureDddBr('552012345678')).toBeNull();
    // 10 díg nacional com DDD inexistente (00) -> null.
    expect(ensureDddBr('0012345678')).toBeNull();
  });

  it('vazio/curto/irrecuperável -> null', () => {
    expect(ensureDddBr('')).toBeNull();
    expect(ensureDddBr('abc')).toBeNull();
    expect(ensureDddBr('123')).toBeNull();
    expect(ensureDddBr('5535')).toBeNull();
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
