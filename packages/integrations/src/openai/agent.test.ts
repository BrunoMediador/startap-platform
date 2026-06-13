/**
 * Testes unitários para runAgent (V4 — sem DEFAULT_MODEL silencioso).
 *
 * Não conecta na OpenAI — usa mock do SDK.
 */
import { describe, expect, it, vi } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: { create: mockCreate },
    },
  })),
}));

vi.mock('@startap/core/logger', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

import { runAgent } from './agent.js';

const baseOpts = {
  systemPrompt: 'Voce e um assistente.',
  history: [],
  userMessage: 'Ola',
};

describe('runAgent — V4: model obrigatório', () => {
  it('lanca erro quando model e undefined', async () => {
    await expect(runAgent({ ...baseOpts, model: undefined })).rejects.toThrow(
      'Modelo OpenAI ausente',
    );
  });

  it('lanca erro quando model e string vazia', async () => {
    await expect(runAgent({ ...baseOpts, model: '' })).rejects.toThrow('Modelo OpenAI ausente');
  });

  it('lanca erro quando model e somente espacos', async () => {
    await expect(runAgent({ ...baseOpts, model: '   ' })).rejects.toThrow('Modelo OpenAI ausente');
  });

  it('caminho feliz: chama OpenAI quando model esta presente', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Oi! Como posso ajudar?', tool_calls: undefined } }],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    });

    const result = await runAgent({ ...baseOpts, model: 'gpt-4o' });

    expect(result.reply).toBe('Oi! Como posso ajudar?');
    expect(result.usage.total).toBe(18);
    // usage sem prompt_tokens_details -> cached = 0 (compat retro).
    expect(result.usage.cached).toBe(0);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4o' }));
  });

  it('captura cached_tokens de prompt caching no usage', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'ok', tool_calls: undefined } }],
      usage: {
        prompt_tokens: 5000,
        completion_tokens: 50,
        total_tokens: 5050,
        prompt_tokens_details: { cached_tokens: 4096 },
      },
    });

    const result = await runAgent({ ...baseOpts, model: 'gpt-5.4' });

    expect(result.usage.prompt).toBe(5000);
    expect(result.usage.cached).toBe(4096);
  });
});
