/**
 * Tipos compartilhados — payloads WAHA, mensagens, contexto de bot.
 */
import { z } from 'zod';

/** Payload bruto que a WAHA envia no webhook (campo de body).
 *
 * Todos os campos opcionais sao .nullish() (aceitam undefined OU null) porque
 * a engine NOWEB do WAHA serializa `body: null` para mensagens de audio/midia
 * — Zod com `.optional()` apenas (que so aceita undefined) rejeitava esses
 * webhooks como invalid-payload, e o audio nunca chegava no router.
 * Bruno 2026-05-21: causa raiz de 39 invalid-payloads em prod.
 *
 * passthrough em TODOS os niveis (incluindo nested _data) — engines diferentes
 * do WAHA serializam campos em locais diferentes (ex: NOWEB poe audio em
 * _data.message.audioMessage; nao podemos stripar isso ao parsear). */
export const WahaWebhookBody = z
  .object({
    event: z.string(),
    session: z.string(),
    payload: z
      .object({
        id: z.string().nullish(),
        from: z.string().nullish(),
        fromMe: z.boolean().nullish(),
        body: z.string().nullish(),
        hasMedia: z.boolean().nullish(),
        media: z
          .object({
            url: z.string().nullish(),
            mimetype: z.string().nullish(),
          })
          .partial()
          .passthrough()
          .nullish(),
        _data: z
          .object({
            key: z
              .object({
                addressingMode: z.string().nullish(),
                remoteJid: z.string().nullish(),
                remoteJidAlt: z.string().nullish(),
              })
              .partial()
              .passthrough()
              .nullish(),
            pushName: z.string().nullish(),
            messageTimestamp: z.union([z.number(), z.string()]).nullish(),
          })
          .partial()
          .passthrough()
          .nullish(),
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
  executionId?: string;
  flowId?: string | null;
  flowName?: string | null;
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
