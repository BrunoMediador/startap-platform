import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import {
  SANDBOX_MAX_INPUT,
  appendMessage,
  fetchSandboxStatus,
  isSendable,
  remainingChars,
  sendSandboxMessage,
  toApiMessages,
} from './sandbox';

// Mocka o cliente HTTP: o que importa é o MAPA status/erro -> outcome, não a rede
// (mesmo padrão de prompt-builder.test / demo-chat).
const apiFetchMock = vi.fn();
vi.mock('./api', async (importOriginal) => {
  const real = await importOriginal<typeof import('./api')>();
  return { ...real, apiFetch: (...args: unknown[]) => apiFetchMock(...args) };
});

afterEach(() => apiFetchMock.mockReset());

describe('sandbox — lógica pura de estado', () => {
  it('appendMessage gera ids incrementais estáveis', () => {
    const a = appendMessage([], 'assistant', 'oi');
    const b = appendMessage(a, 'user', 'quanto custa?');
    expect(a).toEqual([{ id: 1, role: 'assistant', text: 'oi' }]);
    expect(b[1]).toEqual({ id: 2, role: 'user', text: 'quanto custa?' });
  });

  it('remainingChars e isSendable respeitam o teto e o pending', () => {
    expect(remainingChars('abc')).toBe(SANDBOX_MAX_INPUT - 3);
    expect(isSendable('  ', false)).toBe(false); // só espaço
    expect(isSendable('oi', true)).toBe(false); // envio em andamento
    expect(isSendable('oi', false)).toBe(true);
    expect(isSendable('x'.repeat(SANDBOX_MAX_INPUT + 1), false)).toBe(false); // passou do teto
  });

  it('toApiMessages descarta o id local (contrato da API)', () => {
    const log = appendMessage(appendMessage([], 'user', 'oi'), 'assistant', 'olá');
    expect(toApiMessages(log)).toEqual([
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: 'olá' },
    ]);
  });
});

describe('fetchSandboxStatus — mapa de outcome', () => {
  it('200 -> available + persona_configurada', async () => {
    apiFetchMock.mockResolvedValue({ available: true, persona_configurada: true });
    expect(await fetchSandboxStatus()).toEqual({ kind: 'available', personaConfigurada: true });
  });

  it('404 (flag OFF) -> off (seção some, sem erro)', async () => {
    apiFetchMock.mockRejectedValue(new ApiError(404, 'recurso_indisponivel', null));
    expect(await fetchSandboxStatus()).toEqual({ kind: 'off' });
  });

  it('erro real (500) propaga (a UI mostra retry)', async () => {
    apiFetchMock.mockRejectedValue(new ApiError(500, 'internal', null));
    await expect(fetchSandboxStatus()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('sendSandboxMessage — mapa de outcome', () => {
  it('200 -> ok com reply', async () => {
    apiFetchMock.mockResolvedValue({ reply: 'Bom dia! Como ajudo?', simulated: true });
    expect(await sendSandboxMessage([{ role: 'user', content: 'oi' }])).toEqual({
      kind: 'ok',
      reply: 'Bom dia! Como ajudo?',
    });
  });

  it('409 -> no_persona (dono precisa montar o assistente antes)', async () => {
    apiFetchMock.mockRejectedValue(new ApiError(409, 'persona_nao_configurada', null));
    expect(await sendSandboxMessage([{ role: 'user', content: 'oi' }])).toEqual({
      kind: 'no_persona',
    });
  });

  it('404/503 -> unavailable', async () => {
    apiFetchMock.mockRejectedValue(new ApiError(503, 'sandbox_indisponivel', null));
    expect(await sendSandboxMessage([{ role: 'user', content: 'oi' }])).toEqual({
      kind: 'unavailable',
    });
  });

  it('erro transitório (rede/500) -> error', async () => {
    apiFetchMock.mockRejectedValue(new ApiError(0, 'sem conexao', null));
    expect(await sendSandboxMessage([{ role: 'user', content: 'oi' }])).toEqual({ kind: 'error' });
  });
});
