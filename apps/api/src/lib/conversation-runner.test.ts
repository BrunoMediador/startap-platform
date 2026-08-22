import { describe, expect, it } from 'vitest';
import { ConversationRunner } from './conversation-runner.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('ConversationRunner', () => {
  it('serializa uma rajada da mesma conversa e mantém outras conversas independentes', async () => {
    const runner = new ConversationRunner();
    const first = deferred();
    const second = deferred();
    const order: string[] = [];

    const one = runner.run('slot:sessao:fluxo:telefone', async () => {
      order.push('one:start');
      await first.promise;
      order.push('one:end');
    });
    const two = runner.run('slot:sessao:fluxo:telefone', async () => {
      order.push('two:start');
      await second.promise;
      order.push('two:end');
    });
    const other = runner.run('outro-slot:sessao:fluxo:telefone', async () => {
      order.push('other');
    });

    await flushAsyncWork();
    expect(order).toEqual(['one:start', 'other']);
    expect(runner.size).toBe(1);

    first.resolve();
    await flushAsyncWork();
    expect(order).toEqual(['one:start', 'other', 'one:end', 'two:start']);

    second.resolve();
    await Promise.all([one, two, other]);
    expect(order).toEqual(['one:start', 'other', 'one:end', 'two:start', 'two:end']);
    expect(runner.size).toBe(0);
  });

  it('libera a próxima mensagem mesmo quando a anterior falha', async () => {
    const runner = new ConversationRunner();
    const order: string[] = [];

    const failed = runner.run('slot:sessao:fluxo:telefone', async () => {
      order.push('failed');
      throw new Error('falha simulada');
    });
    const next = runner.run('slot:sessao:fluxo:telefone', async () => {
      order.push('next');
    });

    await expect(failed).rejects.toThrow('falha simulada');
    await next;
    expect(order).toEqual(['failed', 'next']);
    expect(runner.size).toBe(0);
  });
});
