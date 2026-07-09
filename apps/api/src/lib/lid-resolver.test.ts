/**
 * Unit da resolução @lid→telefone (SCRUM-63): resolveFromMeIdentity.
 * Mocka os helpers puros de phone (extractLidDigits/extractPnFromPayload), o client WAHA
 * (waha.sessions.resolveLidToPn) e ./redis.js (getRedis) — foco na ORQUESTRAÇÃO
 * (payload-first → cache → REST → fail-safe), não nos helpers puros (testados em phone.test).
 */
import type { WahaWebhookBody } from '@startap/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  extractLidDigits: vi.fn(),
  extractPnFromPayload: vi.fn(),
  resolveLidToPn: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock('@startap/core/phone', () => ({
  extractLidDigits: mocks.extractLidDigits,
  extractPnFromPayload: mocks.extractPnFromPayload,
}));

vi.mock('@startap/integrations', () => ({
  waha: { sessions: { resolveLidToPn: mocks.resolveLidToPn } },
}));

vi.mock('./redis.js', () => ({
  getRedis: () => ({ get: mocks.get, set: mocks.set }),
}));

const { resolveFromMeIdentity } = await import('./lid-resolver.js');

const SESSION = 'TESTE_STARTAP';
const LID = '100206033039600';
const PN = '5519981018908';
const PSEUDO = '100206033039600'; // o que extractPhone daria pro contato migrado
const body = { event: 'message', session: SESSION, payload: { id: 'm' } } as WahaWebhookBody;

describe('resolveFromMeIdentity (SCRUM-63)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue(null);
    mocks.set.mockResolvedValue('OK');
    mocks.resolveLidToPn.mockResolvedValue(null);
  });

  it('contato NÃO migrado (não-@lid) → passthrough do extractedPhone, byte-idêntico (sem cache/REST)', async () => {
    mocks.extractLidDigits.mockReturnValue(null);
    const r = await resolveFromMeIdentity(SESSION, body, '553598877248');
    expect(r).toEqual({ phone: '553598877248', wasLid: false, via: 'not-lid' });
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.resolveLidToPn).not.toHaveBeenCalled();
  });

  it('payload-first: pn direto no webhook → resolve sem tocar cache nem REST', async () => {
    mocks.extractLidDigits.mockReturnValue(LID);
    mocks.extractPnFromPayload.mockReturnValue(PN);
    const r = await resolveFromMeIdentity(SESSION, body, PSEUDO);
    expect(r).toEqual({ phone: PN, wasLid: true, via: 'payload' });
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.resolveLidToPn).not.toHaveBeenCalled();
  });

  it('cache HIT positivo → devolve o pn cacheado e NÃO chama a REST (economiza o lookup)', async () => {
    mocks.extractLidDigits.mockReturnValue(LID);
    mocks.extractPnFromPayload.mockReturnValue(null);
    mocks.get.mockResolvedValue(PN);
    const r = await resolveFromMeIdentity(SESSION, body, PSEUDO);
    expect(r).toEqual({ phone: PN, wasLid: true, via: 'cache' });
    expect(mocks.get).toHaveBeenCalledWith(`lid-pn:${SESSION}:${LID}`);
    expect(mocks.resolveLidToPn).not.toHaveBeenCalled();
  });

  it('cache NEGATIVO → fail-safe (phone null) sem chamar a REST', async () => {
    mocks.extractLidDigits.mockReturnValue(LID);
    mocks.extractPnFromPayload.mockReturnValue(null);
    mocks.get.mockResolvedValue('__none__');
    const r = await resolveFromMeIdentity(SESSION, body, PSEUDO);
    expect(r).toEqual({ phone: null, wasLid: true, via: 'cache-neg' });
    expect(mocks.resolveLidToPn).not.toHaveBeenCalled();
  });

  it('REST resolve → via=rest e grava cache POSITIVO (TTL 24h)', async () => {
    mocks.extractLidDigits.mockReturnValue(LID);
    mocks.extractPnFromPayload.mockReturnValue(null);
    mocks.get.mockResolvedValue(null);
    mocks.resolveLidToPn.mockResolvedValue(PN);
    const r = await resolveFromMeIdentity(SESSION, body, PSEUDO);
    expect(r).toEqual({ phone: PN, wasLid: true, via: 'rest' });
    expect(mocks.resolveLidToPn).toHaveBeenCalledWith(SESSION, LID, { timeoutMs: 1500 });
    expect(mocks.set).toHaveBeenCalledWith(`lid-pn:${SESSION}:${LID}`, PN, 'EX', 24 * 60 * 60);
  });

  it('REST falha (null) + cache vazio → FAIL-SAFE: phone null + cache NEGATIVO (TTL 60s)', async () => {
    mocks.extractLidDigits.mockReturnValue(LID);
    mocks.extractPnFromPayload.mockReturnValue(null);
    mocks.get.mockResolvedValue(null);
    mocks.resolveLidToPn.mockResolvedValue(null);
    const r = await resolveFromMeIdentity(SESSION, body, PSEUDO);
    expect(r).toEqual({ phone: null, wasLid: true, via: 'none' });
    expect(mocks.set).toHaveBeenCalledWith(`lid-pn:${SESSION}:${LID}`, '__none__', 'EX', 60);
  });

  it('Redis get lança (cache indisponível) → segue pro REST (não trava o hot path)', async () => {
    mocks.extractLidDigits.mockReturnValue(LID);
    mocks.extractPnFromPayload.mockReturnValue(null);
    mocks.get.mockRejectedValue(new Error('redis down'));
    mocks.resolveLidToPn.mockResolvedValue(PN);
    const r = await resolveFromMeIdentity(SESSION, body, PSEUDO);
    expect(r).toEqual({ phone: PN, wasLid: true, via: 'rest' });
    expect(mocks.resolveLidToPn).toHaveBeenCalledTimes(1);
  });
});
