/**
 * Tipos compartilhados — payloads WAHA, mensagens, contexto de bot.
 */
import { z } from 'zod';

/** Payload bruto que a WAHA envia no webhook (campo de body). */
export const WahaWebhookBody = z
  .object({
    event: z.string(),
    session: z.string(),
    payload: z
      .object({
        id: z.string().optional(),
        from: z.string().optional(),
        fromMe: z.boolean().optional(),
        body: z.string().optional(),
        hasMedia: z.boolean().optional(),
        media: z
          .object({
            url: z.string().optional(),
            mimetype: z.string().optional(),
          })
          .partial()
          .optional(),
        _data: z
          .object({
            key: z
              .object({
                addressingMode: z.string().optional(),
                remoteJid: z.string().optional(),
                remoteJidAlt: z.string().optional(),
              })
              .partial()
              .optional(),
            pushName: z.string().optional(),
            messageTimestamp: z.union([z.number(), z.string()]).optional(),
          })
          .partial()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type WahaWebhookBody = z.infer<typeof WahaWebhookBody>;

/** Estrutura padronizada de mensagem dentro da nossa plataforma. */
export interface IncomingMessage {
  /** Sessão WAHA (ex: "startap", "TESTE_STARTAP") */
  sessao: string;
  /** Telefone real do remetente, só dígitos com DDI (ex: 5535999998888) */
  telefone: string;
  /** chat_id original (ex: 553598877248@c.us ou LID@lid) */
  chatId: string;
  /** Nome no WhatsApp (pushName) */
  pushName: string;
  /** Texto da mensagem (já transcrito se for áudio) */
  texto: string;
  /** Se mensagem foi enviada pelo bot (fromMe) */
  fromMe: boolean;
  /** ID da mensagem no WhatsApp */
  messageId: string;
  /** Timestamp Unix */
  timestamp: number;
  /** Indica se mensagem original era áudio (transcrito via Whisper) */
  wasAudio: boolean;
  /** Payload original WAHA (debugging) */
  raw: WahaWebhookBody;
}

/** Contexto passado pra cada bot ao processar uma mensagem. */
export interface BotContext {
  message: IncomingMessage;
}

/** Interface que cada bot precisa implementar. */
export interface Bot {
  /** Nome único do bot (usado em logs) */
  readonly name: string;
  /** Processa mensagem recebida */
  handle(ctx: BotContext): Promise<void>;
}

/** Resultado de roteamento. */
export interface RouteDecision {
  workflowId: string;
  workflowName: string;
  webhookUrl: string | null;
}
