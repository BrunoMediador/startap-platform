/**
 * Testes do roteamento de transcrição flag-gated (ADR 0021).
 *
 * Não conecta no Whisper real nem na OpenAI — mocka fetch (local) e o módulo
 * openai/transcribe (provider hospedado).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockOpenAITranscribe } = vi.hoisted(() => ({ mockOpenAITranscribe: vi.fn() }));

vi.mock('../openai/transcribe.js', () => ({ transcribe: mockOpenAITranscribe }));

vi.mock('@startap/core/logger', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

import { transcribe } from './client.js';

const AUDIO = Buffer.from('fake-ogg-bytes');

function mockLocalOk(text: string) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ text }),
  }) as unknown as typeof fetch;
}

function mockLocalFail() {
  global.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status: 500,
    text: async () => 'boom',
  }) as unknown as typeof fetch;
}

// Acesso por chave computada: `delete process.env.FOO` (membro estático) dispara
// lint/performance/noDelete; em membro computado não (mesmo padrão do router.test.ts).
const PROVIDER_KEY = 'TRANSCRIBE_PROVIDER';
const FALLBACK_KEY = 'TRANSCRIBE_OPENAI_FALLBACK_LOCAL';

function clearEnv() {
  delete process.env[PROVIDER_KEY];
  delete process.env[FALLBACK_KEY];
}

describe('transcribe — roteamento por TRANSCRIBE_PROVIDER', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearEnv();
  });
  afterEach(clearEnv);

  it('default (flag ausente) usa Whisper LOCAL — comportamento atual', async () => {
    mockLocalOk('quero marcar corte amanhã');
    const r = await transcribe(AUDIO, 'audio/ogg');
    expect(r).toBe('quero marcar corte amanhã');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockOpenAITranscribe).not.toHaveBeenCalled();
  });

  it("provider='local' explícito usa Whisper LOCAL", async () => {
    process.env.TRANSCRIBE_PROVIDER = 'local';
    mockLocalOk('texto local');
    const r = await transcribe(AUDIO);
    expect(r).toBe('texto local');
    expect(mockOpenAITranscribe).not.toHaveBeenCalled();
  });

  it("provider='openai' roteia pra OpenAI", async () => {
    process.env.TRANSCRIBE_PROVIDER = 'openai';
    mockOpenAITranscribe.mockResolvedValueOnce('texto openai');
    const r = await transcribe(AUDIO, 'audio/ogg');
    expect(r).toBe('texto openai');
    expect(mockOpenAITranscribe).toHaveBeenCalledWith(AUDIO, 'audio/ogg');
  });

  it('FAIL-SAFE: OpenAI falha -> fallback pro Whisper local (default)', async () => {
    process.env.TRANSCRIBE_PROVIDER = 'openai';
    mockOpenAITranscribe.mockRejectedValueOnce(new Error('429 rate limit'));
    mockLocalOk('texto do fallback');
    const r = await transcribe(AUDIO);
    expect(r).toBe('texto do fallback');
    expect(mockOpenAITranscribe).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('fallback desligado: OpenAI falha -> propaga erro (router trata)', async () => {
    process.env.TRANSCRIBE_PROVIDER = 'openai';
    process.env.TRANSCRIBE_OPENAI_FALLBACK_LOCAL = 'false';
    mockOpenAITranscribe.mockRejectedValueOnce(new Error('timeout'));
    global.fetch = vi.fn() as unknown as typeof fetch;
    await expect(transcribe(AUDIO)).rejects.toThrow('timeout');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
