/**
 * BotBase — classe abstrata que todos os bots estendem.
 *
 * Centraliza preocupações comuns: pausa por projeto, log de mensagem na memória,
 * envio de resposta com typing humanizado.
 */
import { logger } from '@startap/core/logger';
import type { Bot, BotContext } from '@startap/core/types';
import { chatMemory, pausa as pausaQueries } from '@startap/db';
import type { Role } from '@startap/db';
import { waha } from '@startap/integrations';

export interface BotConfig {
  /** Nome único do bot (usado em logs). */
  name: string;
  /** Tabela de pausa específica desse bot (ex: 'pausa_samuel'). Null = sem pausa por projeto. */
  pauseTable: string | null;
  /** Tabela de memória de chat (ex: 'n8n_chat_histories_ricardo'). */
  memoryTable: string;
  /** Quantas turnos de memória carregar (default 20). */
  memoryWindow?: number;
}

export abstract class BotBase implements Bot {
  readonly name: string;
  protected readonly cfg: BotConfig;
  protected readonly log: ReturnType<typeof logger.child>;

  constructor(cfg: BotConfig) {
    this.name = cfg.name;
    this.cfg = cfg;
    this.log = logger.child({ bot: cfg.name });
  }

  async handle(ctx: BotContext): Promise<void> {
    const { telefone, texto, chatId, sessao } = ctx.message;

    // 1. Verifica pausa do projeto (se houver)
    if (this.cfg.pauseTable) {
      const paused = await pausaQueries.isPaused(this.cfg.pauseTable, telefone).catch(() => false);
      if (paused) {
        this.log.info({ telefone }, 'Cliente em pausa, ignorando');
        return;
      }
    }

    // 2. Registra mensagem do usuário na memória
    if (texto) {
      await this.appendMemory(telefone, 'human', texto);
    }

    // 3. Delega para implementação específica do bot
    try {
      const reply = await this.process(ctx);
      if (reply) {
        await waha.sendText({ sessao, chatId, texto: reply, typing: true, delayMs: 1500 });
        await this.appendMemory(telefone, 'ai', reply);
      }
    } catch (e) {
      this.log.error({ err: e, telefone }, 'Bot processing failed');
      throw e;
    }
  }

  /**
   * Cada bot implementa essa função.
   * Retorna texto a enviar, ou null para não responder.
   */
  protected abstract process(ctx: BotContext): Promise<string | null>;

  protected async loadHistory(telefone: string) {
    return chatMemory.loadHistory(this.cfg.memoryTable, telefone, this.cfg.memoryWindow ?? 20);
  }

  protected async appendMemory(telefone: string, role: Role, content: string) {
    return chatMemory.appendMessage(this.cfg.memoryTable, telefone, role, content);
  }
}
