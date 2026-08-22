import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ debug: vi.fn(), error: vi.fn() }) },
}));

import { WahaRequestError, sendText } from './client.js';

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.WAHA_URL = 'http://waha.test';
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.WAHA_URL = undefined;
});

describe('WAHA sendText', () => {
  it('não lê nem propaga sentinela PII do body WAHA', async () => {
    const pii = 'PHONE_5531999990000_CHAT_5531988880000_TEXT_segredo';
    const text = vi.fn(async () => pii);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 422, text });

    const error = await sendText({
      sessao: 'ALERTAS',
      chatId: '5531999990000@c.us',
      texto: 'segredo',
      typing: false,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(WahaRequestError);
    expect((error as Error).message).not.toContain(pii);
    expect(error).toMatchObject({
      operation: 'POST',
      route: '/api/sendText',
      status: 422,
      wahaCode: 'WAHA_SENDER_UNAVAILABLE',
    });
    expect(text).not.toHaveBeenCalled();
  });

  it('encerra typing com deadline mesmo quando o envio falha', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockRejectedValueOnce(new Error('network failure'))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    await expect(
      sendText({
        sessao: 'sessao-clone-real',
        chatId: '553199998842@c.us',
        texto: 'mensagem de teste',
        typing: true,
        delayMs: 0,
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toThrow('network failure');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://waha.test/api/startTyping',
      'http://waha.test/api/sendText',
      'http://waha.test/api/stopTyping',
    ]);
    const stopOptions = fetchMock.mock.calls[2]?.[1] as { signal?: AbortSignal };
    expect(stopOptions.signal).toBeInstanceOf(AbortSignal);
  });
});
