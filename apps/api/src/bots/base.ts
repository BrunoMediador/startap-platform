/**
 * BotBase — classe abstrata que todos os bots estendem.
 *
 * Centraliza preocupações comuns: pausa por projeto, log de mensagem na memória,
 * envio de resposta com typing humanizado.
 */
import { logger } from '@startap/core/logger';
import { isModoAtendenteEnabled } from '@startap/core/modo-atendente-gate';
import type { Bot, BotContext } from '@startap/core/types';
import { chatMemory, flowExecutionLog, pausa as pausaQueries } from '@startap/db';
import type { Role } from '@startap/db';
import { waha } from '@startap/integrations';
import { registerBotReplyEcho } from '../lib/human-reply-pause.js';

export interface BotConfig {
  /** Nome único do bot (usado em logs). */
  name: string;
  /** Projeto lógico usado como fronteira de memória e auditoria. */
  projectId: string;
  /** Tabela de pausa específica desse bot (ex: 'pausa_samuel'). Null = sem pausa por projeto. */
  pauseTable: string | null;
  /** Tabela de memória de chat (ex: 'chat_histories_ricardo'). */
  memoryTable: string;
  /** Quantas turnos de memória carregar (default 20). */
  memoryWindow?: number;
  /** Quantas entradas manter persistidas por sessão. Default: janela * 3, mínimo 30. */
  memoryRetention?: number;
  /**
   * Quando preenchido, substitui o SLOT constante do bot para leitura de
   * bot_config/bot_prompt/bot_media. Usado pelos clones de fluxo matriz.
   */
  slotOverride?: string;
}

export abstract class BotBase implements Bot {
  readonly name: string;
  protected readonly cfg: BotConfig;
  protected readonly log: ReturnType<typeof logger.child>;

  /**
   * Slot efetivo para leitura de bot_config/bot_prompt/bot_media.
   * Quando slotOverride está definido (clone de fluxo), retorna o override;
   * caso contrário retorna cfg.projectId (slot da matriz).
   */
  protected get slot(): string {
    return this.cfg.slotOverride ?? this.cfg.projectId;
  }

  constructor(cfg: BotConfig) {
    this.name = cfg.name;
    this.cfg = cfg;
    this.log = logger.child({ bot: cfg.name, slot: this.cfg.slotOverride ?? cfg.name });
  }

  async handle(ctx: BotContext): Promise<void> {
    const { telefone, texto, chatId, sessao } = ctx.message;
    const baseLog = {
      executionId: ctx.executionId,
      flowId: ctx.flowId,
      flowName: ctx.flowName,
      bot: this.name,
      telefone,
      session: sessao,
    };

    // 1. Verifica pausa independente por fluxo.
    if (ctx.flowId) {
      const flowPaused = await pausaQueries
        .isFlowPaused({ flowId: ctx.flowId, telefone })
        .catch(() => false);
      if (flowPaused) {
        this.log.info({ telefone, flowId: ctx.flowId }, 'Cliente em pausa no fluxo, ignorando');
        await this.logEvent({
          ...baseLog,
          eventType: 'bot.flow-paused',
          status: 'ignored',
          message: 'Cliente em pausa neste fluxo',
          metadata: { flowId: ctx.flowId, pauseScope: 'flow' },
        });
        return;
      }
    }

    // 2. Verifica pausa legada do projeto (se houver)
    if (this.cfg.pauseTable) {
      const paused = await pausaQueries.isPaused(this.cfg.pauseTable, telefone).catch(() => false);
      if (paused) {
        this.log.info({ telefone }, 'Cliente em pausa, ignorando');
        await this.logEvent({
          ...baseLog,
          eventType: 'bot.project-paused',
          status: 'ignored',
          message: 'Cliente em pausa do projeto',
          metadata: { pauseTable: this.cfg.pauseTable },
        });
        return;
      }
    }

    const memorySessionId = this.memorySessionId(ctx);

    // 3. Registra mensagem do usuário na memória
    if (texto) {
      await this.appendMemory(ctx, 'human', texto);
      await this.logEvent({
        ...baseLog,
        eventType: 'bot.memory-human',
        status: 'running',
        message: 'Mensagem do usuário registrada na memória',
        metadata: {
          memoryTable: this.cfg.memoryTable,
          memoryScope: 'project:session:flowId:telefone',
          projectId: this.slot,
          memoryFlowId: ctx.flowId ?? this.name,
          memorySession: sessao,
          memorySessionHash: this.maskMemorySession(memorySessionId),
          textLength: texto.length,
        },
      });
    }

    // 4. Delega para implementação específica do bot
    try {
      const reply = await this.process(ctx);
      if (reply) {
        await waha.sendText({ sessao, chatId, texto: reply, typing: true, delayMs: 1500 });
        // SCRUM-59: marca o eco desta resposta pra distinguir "app enviou via API" de
        // "humano digitou" no ramo fromMe do router (anti-auto-pausa). SÓ p/ clones em
        // modo atendente (gate barato = string compare); best-effort, nunca lança. Clones
        // fora do gate: byte-idêntico (o if é false, nem toca no Redis).
        if (isModoAtendenteEnabled(this.slot, process.env.MODO_ATENDENTE_SLOTS)) {
          await registerBotReplyEcho(sessao, telefone, reply);
        }
        await this.logEvent({
          ...baseLog,
          eventType: 'bot.reply-sent',
          status: 'running',
          message: 'Resposta enviada ao WhatsApp',
          metadata: { replyLength: reply.length },
        });
        await this.appendMemory(ctx, 'ai', reply);
        await this.logEvent({
          ...baseLog,
          eventType: 'bot.memory-ai',
          status: 'running',
          message: 'Resposta do bot registrada na memória',
          metadata: {
            memoryTable: this.cfg.memoryTable,
            memoryScope: 'project:session:flowId:telefone',
            projectId: this.slot,
            memoryFlowId: ctx.flowId ?? this.name,
            memorySession: sessao,
            memorySessionHash: this.maskMemorySession(memorySessionId),
          },
        });
      }
    } catch (e) {
      this.log.error({ err: e, telefone }, 'Bot processing failed');
      await this.logEvent({
        ...baseLog,
        eventType: 'bot.processing-error',
        status: 'error',
        message: 'Erro interno no processamento do bot',
        error: e,
      });
      throw e;
    }
  }

  /**
   * Cada bot implementa essa função.
   * Retorna texto a enviar, ou null para não responder.
   */
  protected abstract process(ctx: BotContext): Promise<string | null>;

  protected async loadHistory(ctx: BotContext) {
    return chatMemory.loadHistory(
      this.cfg.memoryTable,
      this.memorySessionId(ctx),
      this.cfg.memoryWindow ?? 20,
    );
  }

  protected async appendMemory(ctx: BotContext, role: Role, content: string) {
    const sessionId = this.memorySessionId(ctx);
    await chatMemory.appendMessage(this.cfg.memoryTable, sessionId, role, content);
    await this.pruneMemory(sessionId);
  }

  private async pruneMemory(sessionId: string): Promise<void> {
    const window = this.cfg.memoryWindow ?? 20;
    const keep = this.cfg.memoryRetention ?? Math.max(window * 3, 30);
    await chatMemory
      .pruneHistory(this.cfg.memoryTable, sessionId, keep)
      .catch((err) =>
        this.log.warn(
          { err, memoryTable: this.cfg.memoryTable, keep },
          'Falha ao podar memoria de chat',
        ),
      );
  }

  private memorySessionId(ctx: BotContext): string {
    const flowId = ctx.flowId || this.name;
    return `${this.slot}:${ctx.message.sessao}:${flowId}:${ctx.message.telefone}`;
  }

  private maskMemorySession(sessionId: string): string {
    return sessionId.replace(/(\d{4})\d+(\d{4})$/, '$1****$2');
  }

  private async logEvent(
    input: Omit<Parameters<typeof flowExecutionLog.logFlowEvent>[0], 'executionId'> & {
      executionId?: string;
    },
  ) {
    if (!input.executionId) return null;
    return flowExecutionLog.logFlowEvent({
      ...input,
      executionId: input.executionId,
    });
  }
}
