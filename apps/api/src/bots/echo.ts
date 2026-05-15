/**
 * Bot de demonstração — ecoa a mensagem recebida.
 * Usado como template e para testes end-to-end antes de migrar os bots reais.
 */
import type { BotContext } from '@startap/core/types';
import { BotBase } from './base.js';

export class EchoBot extends BotBase {
  constructor() {
    super({
      name: 'echo',
      projectId: 'echo',
      pauseTable: null,
      memoryTable: 'chat_histories',
    });
  }

  protected async process(ctx: BotContext): Promise<string | null> {
    const { texto, pushName } = ctx.message;
    if (!texto) return null;
    return `Oi ${pushName || 'visitante'}! Você disse: "${texto}".\n\n(Bot de teste — em construção 🚧)`;
  }
}
