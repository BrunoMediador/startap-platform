import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProfilePicture } from './profile-picture.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getProfilePicture', () => {
  it('cancela stream acima de 1 MB mesmo sem Content-Length', async () => {
    let streamCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xff, 0xd8, 0xff]));
        controller.enqueue(new Uint8Array(1_000_000));
      },
      cancel() {
        streamCancelled = true;
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: 'https://mmg.whatsapp.net/avatar-safe' }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'image/jpeg' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getProfilePicture({
        sessao: 'sessao_teste',
        telefoneCanonico: '553199998842',
        timeoutMs: 2_000,
      }),
    ).resolves.toBeNull();

    expect(streamCancelled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
