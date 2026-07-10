/**
 * outbound-messages — data layer do rastreio de ENTREGA por outbound WhatsApp (SCRUM-58).
 *
 * 1 linha por mensagem enviada (PK = message_id do WAHA). O envio REGISTRA (recordOutbound,
 * status inicial PENDING); o evento `message.ack` do WAHA ATUALIZA o status de forma monotônica
 * e atômica (applyAck: "só sobe", ERROR terminal); o worker VARRE nack terminal + preso sem
 * entrega (listAlertable) e marca (markAlerted). Retenção: pruneOldOutbound (poda por idade).
 *
 * Tudo gated pelo CHAMADOR via MESSAGE_ACK_TRACKING_ENABLED (default OFF) — com a flag OFF nada
 * aqui é invocado (byte-idêntico). Migration 073.
 *
 * LGPD: só `phone_hint` mascarado (o chamador mascara com phoneHint do core). NUNCA número em
 * claro nem conteúdo de mensagem.
 */
import { mapWahaAck } from '@startap/core/message-ack';
import type { OutboundAckStatus } from '@startap/core/message-ack';
import { query } from '../client.js';

export interface OutboundMessageRow {
  message_id: string;
  session: string;
  slot: string | null;
  phone_hint: string;
  ack_status: OutboundAckStatus;
  ack_rank: number;
  ack_code: number | null;
  alerted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Linha mínima devolvida pelo update de ack (o suficiente pro chamador logar sem re-query). */
export interface OutboundAckUpdate {
  message_id: string;
  session: string;
  slot: string | null;
  ack_status: OutboundAckStatus;
  ack_code: number | null;
}

function normalizeUpdate(row: {
  message_id: string;
  session: string;
  slot: string | null;
  ack_status: OutboundAckStatus;
  ack_code: string | number | null;
}): OutboundAckUpdate {
  return {
    message_id: row.message_id,
    session: row.session,
    slot: row.slot,
    ack_status: row.ack_status,
    ack_code: row.ack_code == null ? null : Number(row.ack_code),
  };
}

/**
 * Registra um outbound recém-enviado. IDEMPOTENTE: ON CONFLICT (message_id) DO NOTHING — um retry
 * do envio (ou webhook async re-agendado) não duplica nem sobrescreve um status já mais avançado.
 * Status inicial = PENDING (o ack real chega depois). Retorna true se INSERIU (linha nova).
 */
export async function recordOutbound(input: {
  messageId: string;
  session: string;
  slot: string | null;
  phoneHint: string;
}): Promise<boolean> {
  const r = await query(
    `INSERT INTO outbound_messages (message_id, session, slot, phone_hint, ack_status, ack_rank)
     VALUES ($1, $2, $3, $4, 'PENDING', 0)
     ON CONFLICT (message_id) DO NOTHING`,
    [input.messageId, input.session, input.slot, input.phoneHint],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Aplica um ack do WAHA a um outbound, ATÔMICO e MONOTÔNICO:
 *  - não-terminal (PENDING/SERVER/DEVICE/READ): só grava se o rank novo for ESTRITAMENTE maior
 *    (nunca rebaixa; acks fora de ordem são no-op);
 *  - terminal (ERROR/nack/463): grava só se ainda NÃO entregou (ack_rank < 2 = PENDING/SERVER)
 *    e ainda não estava ERROR — um nack depois de DEVICE/READ é ignorado (já entregou).
 * Ambos preservados por: `ack_status <> 'ERROR'` (ERROR é terminal, ninguém o sobrescreve).
 * Mensagem DESCONHECIDA (id que não registramos) ou update sem efeito → retorna null (o chamador
 * IGNORA — regra fail-safe). O status/rank derivam de mapWahaAck (fonte única, testada).
 */
export async function applyAck(input: {
  messageId: string;
  ackCode: number;
  ackName?: string | null;
}): Promise<OutboundAckUpdate | null> {
  const { status, rank, terminal } = mapWahaAck(input.ackCode, input.ackName);
  const r = await query<{
    message_id: string;
    session: string;
    slot: string | null;
    ack_status: OutboundAckStatus;
    ack_code: string | number | null;
  }>(
    `UPDATE outbound_messages
        SET ack_status = $2,
            ack_rank   = $3,
            ack_code   = $4,
            updated_at = NOW()
      WHERE message_id = $1
        AND ack_status <> 'ERROR'
        AND (
              ($5 = TRUE  AND ack_rank < 2)      -- terminal (nack): só antes de DEVICE
           OR ($5 = FALSE AND $3 > ack_rank)     -- progresso: só sobe
            )
      RETURNING message_id, session, slot, ack_status, ack_code`,
    [
      input.messageId,
      status,
      rank,
      Number.isFinite(input.ackCode) ? input.ackCode : null,
      terminal,
    ],
  );
  return r.rows[0] ? normalizeUpdate(r.rows[0]) : null;
}

/**
 * Varre os outbounds que MERECEM um alerta interno e ainda NÃO foram avisados (alerted_at NULL):
 *  - NACK TERMINAL: ack_status = 'ERROR' (inclui 463);
 *  - PRESO SEM ENTREGA: ack_status IN ('PENDING','SERVER') há mais que a janela (created_at < $1).
 * NÃO inclui DEVICE/READ (entregue) — read NUNCA dispara nada de negativo. Prioriza os mais
 * antigos (created_at ASC) e limita a $2 por ciclo (anti-burst). Só leitura.
 */
export async function listAlertable(input: {
  stuckBefore: Date;
  limit: number;
}): Promise<OutboundMessageRow[]> {
  const r = await query<
    OutboundMessageRow & { ack_rank: string | number; ack_code: string | null }
  >(
    `SELECT message_id, session, slot, phone_hint, ack_status, ack_rank, ack_code,
            alerted_at, created_at, updated_at
       FROM outbound_messages
      WHERE alerted_at IS NULL
        AND (
              ack_status = 'ERROR'
           OR (ack_status IN ('PENDING', 'SERVER') AND created_at < $1)
            )
      ORDER BY created_at ASC
      LIMIT $2`,
    [input.stuckBefore, input.limit],
  );
  return r.rows.map((row) => ({
    ...row,
    ack_rank: Number(row.ack_rank),
    ack_code: row.ack_code == null ? null : Number(row.ack_code),
  }));
}

/**
 * Marca um outbound como já alertado (carimba alerted_at). Condicional a alerted_at IS NULL —
 * idempotente e safe sob concorrência: só o 1º a marcar "ganha". Retorna true se marcou.
 */
export async function markAlerted(messageId: string, at: Date = new Date()): Promise<boolean> {
  const r = await query(
    `UPDATE outbound_messages
        SET alerted_at = $2, updated_at = NOW()
      WHERE message_id = $1
        AND alerted_at IS NULL`,
    [messageId, at],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Marca TODOS os outbounds atualmente alertáveis de UMA sessão (nack terminal OU preso além da
 * janela) como já avisados. Usado quando o alerta é AGREGADO por sessão (1 mensagem cobre N
 * outbounds falhando) — drena a sessão inteira de uma vez pra o próximo ciclo não re-alertar os
 * mesmos. Mesmo predicado do listAlertable. Retorna quantas linhas marcou.
 */
export async function markAlertedForSession(input: {
  session: string;
  stuckBefore: Date;
  at?: Date;
}): Promise<number> {
  const at = input.at ?? new Date();
  const r = await query(
    `UPDATE outbound_messages
        SET alerted_at = $3, updated_at = NOW()
      WHERE session = $1
        AND alerted_at IS NULL
        AND (
              ack_status = 'ERROR'
           OR (ack_status IN ('PENDING', 'SERVER') AND created_at < $2)
            )`,
    [input.session, input.stuckBefore, at],
  );
  return r.rowCount ?? 0;
}

/**
 * Poda linhas antigas (retenção). Mesmo padrão de flow_execution_logs.pruneOldFlowEvents: DELETE
 * parametrizado por idade de dados EFÊMEROS de tracking (não fonte de verdade de negócio).
 * Retorna quantas removeu.
 */
export async function pruneOldOutbound(days: number): Promise<number> {
  const r = await query(
    `DELETE FROM outbound_messages WHERE created_at < NOW() - ($1 || ' days')::interval`,
    [String(days)],
  );
  return r.rowCount ?? 0;
}
