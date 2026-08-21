import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendText } from './client.js';

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
