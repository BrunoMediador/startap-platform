/**
 * Testes unitários para runAgent (V4 — sem DEFAULT_MODEL silencioso).
 *
 * Não conecta na OpenAI — usa mock do SDK.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('runAgent — toolChoice (fix determinístico SCRUM-92)', () => {
  // mock_create acumula calls entre testes do arquivo; limpamos pra indexar calls[0] deste teste.
  beforeEach(() => mockCreate.mockClear());

  function makeTool() {
    return {
      name: 'propor_prompt',
      description: 'propoe a persona',
      parameters: { type: 'object' as const },
      run: vi.fn(async () => ({ ok: true })),
    };
  }

  it('ausente: NÃO passa tool_choice (byte-a-byte pro caminho atual)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'oi', tool_calls: undefined } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    await runAgent({ ...baseOpts, model: 'gpt-4o', tools: [makeTool()] });
    const call = mockCreate.mock.calls[0][0];
    expect(call.tool_choice).toBeUndefined();
    expect('tool_choice' in call).toBe(false);
  });

  it("'auto' explícito: passa tool_choice 'auto'", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'oi', tool_calls: undefined } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    await runAgent({ ...baseOpts, model: 'gpt-4o', tools: [makeTool()], toolChoice: 'auto' });
    expect(mockCreate.mock.calls[0][0].tool_choice).toBe('auto');
  });

  it('forceFunction: OBRIGA a função no 1º turno e captura a tool call', async () => {
    // Turno 0 (forçado): modelo chama a tool. Turno 1: escreve a mensagem final.
    mockCreate
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: { name: 'propor_prompt', arguments: '{}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Prévia pronta! Role a tela.', tool_calls: undefined } }],
        usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
      });

    const tool = makeTool();
    const result = await runAgent({
      ...baseOpts,
      model: 'gpt-4o',
      tools: [tool],
      toolChoice: { forceFunction: 'propor_prompt' },
    });

    // 1º turno: tool_choice forçado na função.
    expect(mockCreate.mock.calls[0][0].tool_choice).toEqual({
      type: 'function',
      function: { name: 'propor_prompt' },
    });
    // 2º turno: NÃO força mais (senão chamaria a tool em loop) — libera resposta final.
    expect(mockCreate.mock.calls[1][0].tool_choice).toBeUndefined();

    expect(tool.run).toHaveBeenCalledTimes(1);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('propor_prompt');
    expect(result.reply).toBe('Prévia pronta! Role a tela.');
  });

  it('forceFunction SEM tools ofertadas: não passa tool_choice (guarda)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'oi', tool_calls: undefined } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    await runAgent({
      ...baseOpts,
      model: 'gpt-4o',
      tools: [],
      toolChoice: { forceFunction: 'propor_prompt' },
    });
    expect(mockCreate.mock.calls[0][0].tool_choice).toBeUndefined();
  });
});
