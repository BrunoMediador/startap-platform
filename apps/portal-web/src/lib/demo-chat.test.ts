import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { type DemoChatResponse, sendDemoChat } from './demo-chat';

// Mocka o cliente HTTP: o que importa testar é o MAPA status/erro -> outcome,
// não a rede. Cada caso controla o que apiFetch resolve/rejeita.
const apiFetchMock = vi.fn();
vi.mock('./api', async (importOriginal) => {
  const real = await importOriginal<typeof import('./api')>();
  return { ...real, apiFetch: (...args: unknown[]) => apiFetchMock(...args) };
});

const MSGS = [{ role: 'user' as const, content: 'oi' }];

afterEach(() => apiFetchMock.mockReset());

describe('sendDemoChat — mapa de outcome', () => {
  it('resposta ok sem booking', async () => {
    apiFetchMock.mockResolvedValue({ reply: 'Olá!' } satisfies DemoChatResponse);
    expect(await sendDemoChat(MSGS)).toEqual({ kind: 'ok', reply: 'Olá!', demoBooking: false });
  });

  it('resposta ok com demo_booking true vira demoBooking', async () => {
    apiFetchMock.mockResolvedValue({ reply: 'Marcado!', demo_booking: true });
    expect(await sendDemoChat(MSGS)).toEqual({ kind: 'ok', reply: 'Marcado!', demoBooking: true });
  });

  it('reply ausente/não-string degrada pra string vazia (sem crash)', async () => {
    apiFetchMock.mockResolvedValue({ demo_booking: false } as unknown as DemoChatResponse);
    expect(await sendDemoChat(MSGS)).toEqual({ kind: 'ok', reply: '', demoBooking: false });
  });

  it('429 -> rate_limit', async () => {
    apiFetchMock.mockRejectedValue(new ApiError(429, 'rate', null));
    expect(await sendDemoChat(MSGS)).toEqual({ kind: 'rate_limit' });
  });

  it('404 / 502 / 503 (flag OFF, rota fora, upstream) -> unavailable (degrade)', async () => {
    for (const status of [404, 502, 503]) {
      apiFetchMock.mockRejectedValueOnce(new ApiError(status, 'x', null));
      expect(await sendDemoChat(MSGS)).toEqual({ kind: 'unavailable' });
    }
  });

  it('500 e falha de rede (status 0) -> error (tentar de novo)', async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiError(500, 'boom', null));
    expect(await sendDemoChat(MSGS)).toEqual({ kind: 'error' });
    apiFetchMock.mockRejectedValueOnce(new ApiError(0, 'sem conexao', null));
    expect(await sendDemoChat(MSGS)).toEqual({ kind: 'error' });
  });
});
