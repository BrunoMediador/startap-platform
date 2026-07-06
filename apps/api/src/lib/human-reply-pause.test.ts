/**
 * Unit do anti-eco (SCRUM-59): registerBotReplyEcho / isBotEcho / isSelfChat.
 * Mocka ./redis.js (getRedis) pra não tocar Redis real nem carregar config. canonicalE164
 * é o real (@startap/core/phone) — comparação de identidade determinística.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  set: vi.fn(),
  get: vi.fn(),
}));

vi.mock('./redis.js', () => ({
  getRedis: () => ({ set: mocks.set, get: mocks.get }),
}));

const { HUMAN_REPLY_PAUSE_TTL_MS, isBotEcho, isSelfChat, registerBotReplyEcho } = await import(
  './human-reply-pause.js'
);

describe('registerBotReplyEcho + isBotEcho', () => {
  beforeEach(() => {
    mocks.store.clear();
    // set grava na store; get lê da store (comportamento in-memory por padrão).
    mocks.set.mockReset().mockImplementation(async (key: string, val: string) => {
      mocks.store.set(key, val);
      return 'OK';
    });
    mocks.get.mockReset().mockImplementation(async (key: string) => mocks.store.get(key) ?? null);
  });

  it('TTL constante = 60 min', () => {
    expect(HUMAN_REPLY_PAUSE_TTL_MS).toBe(60 * 60 * 1000);
  });

  it('registra o eco e isBotEcho reconhece a MESMA resposta (session+telefone+texto)', async () => {
    await registerBotReplyEcho('sess', '5535999998888', 'Oi! O corte sai R$40.');
    // marca com TTL curto (EX segundos).
    expect(mocks.set).toHaveBeenCalledWith(expect.any(String), '1', 'EX', expect.any(Number));
    expect(await isBotEcho('sess', '5535999998888', 'Oi! O corte sai R$40.')).toBe('echo');
  });

  it('P3a: a chave NÃO carrega o telefone em claro (PII hasheada)', async () => {
    await registerBotReplyEcho('sess', '5535999998888', 'Oi!');
    const key = mocks.set.mock.calls[0]![0] as string;
    expect(key).toMatch(/^bot-echo:sess:/);
    expect(key).not.toContain('5535999998888');
  });

  it('P3a: casa envio↔eco mesmo com/sem o 9º dígito (canonicalE164 antes do hash)', async () => {
    // registra com 13 díg (com 9); confere com 12 díg (sem 9) = MESMA identidade canônica.
    await registerBotReplyEcho('sess', '5535991746797', 'resposta');
    expect(await isBotEcho('sess', '553591746797', 'resposta')).toBe('echo');
  });

  it('normaliza espaço/caixa: eco casa mesmo com espaçamento/caixa diferentes', async () => {
    await registerBotReplyEcho('sess', '55351111', 'Bom  dia,  tudo bem?');
    expect(await isBotEcho('sess', '55351111', 'bom dia, TUDO bem?')).toBe('echo');
  });

  it('texto diferente → human (não é eco)', async () => {
    await registerBotReplyEcho('sess', '55351111', 'resposta do bot');
    expect(await isBotEcho('sess', '55351111', 'ja te respondo')).toBe('human');
  });

  it('telefone/sessão diferentes não colidem (chave escopada)', async () => {
    await registerBotReplyEcho('sessA', '55351111', 'igual');
    expect(await isBotEcho('sessB', '55351111', 'igual')).toBe('human');
    expect(await isBotEcho('sessA', '55352222', 'igual')).toBe('human');
  });

  it('registerBotReplyEcho no-op para texto vazio (mídia sem texto não gera eco)', async () => {
    await registerBotReplyEcho('sess', '55351111', '   ');
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('Redis fora no CHECK → degraded (fail-safe: chamador NÃO auto-pausa)', async () => {
    mocks.get.mockRejectedValueOnce(new Error('redis down'));
    expect(await isBotEcho('sess', '55351111', 'qualquer')).toBe('degraded');
  });

  it('registerBotReplyEcho NUNCA lança (best-effort) mesmo com Redis fora', async () => {
    mocks.set.mockRejectedValueOnce(new Error('redis down'));
    await expect(registerBotReplyEcho('sess', '55351111', 'texto')).resolves.toBeUndefined();
  });
});

describe('isSelfChat', () => {
  it('true quando o número bate (identidade canônica, ignora 9º dígito BR)', () => {
    // 13 díg com 9 vs 12 díg sem 9 = MESMA identidade (canonicalE164 remove o 9).
    expect(isSelfChat('5535991746797', '553591746797')).toBe(true);
    expect(isSelfChat('5535991746797', '5535991746797')).toBe(true);
  });

  it('false quando é outro número (cliente comum)', () => {
    expect(isSelfChat('5535999998888', '5535991746797')).toBe(false);
  });

  it('false quando ownNumber é null/vazio (sem me.id conhecido → não bloqueia)', () => {
    expect(isSelfChat('5535999998888', null)).toBe(false);
    expect(isSelfChat('5535999998888', '')).toBe(false);
  });
});
