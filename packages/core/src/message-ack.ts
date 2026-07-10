/**
 * message-ack — lógica PURA de rastreio de ENTREGA de outbound WhatsApp (SCRUM-58).
 *
 * PROBLEMA: hoje o app é CEGO à entrega. Loga `bot.reply-sent` no HTTP 2xx do WAHA,
 * mas o 2xx só significa "WAHA aceitou o envio" — o `ack error:463` (NackCallerReachout
 * Timelocked) e outros nacks acontecem DEPOIS, no nível do WhatsApp. Foi o que fez o
 * Bruno perguntar "chegou?" no teste e deixou a Lola 3 dias muda no incidente SCRUM-55.
 *
 * Este módulo NÃO tem I/O — só mapeia o `ack`/`ackName` do WAHA num status monotônico
 * e extrai ids/acks de payloads WAHA de forma defensiva (engine congelada/incerta). Fica
 * no core pra ser reusado pelo router (webhook), pelo bot (base.ts) e pelo worker sem ciclo.
 *
 * ⚠️ LIÇÃO DO BRUNO (memória sessao-teste-numero-bruno): NÃO depender do ack de LEITURA
 * (READ/PLAYED) — o usuário pode desligar o recibo de leitura, o que geraria falso-negativo
 * ("nunca leu" ≠ "nunca entregou"). Rastreamos ENTREGA (SERVER→DEVICE) e FALHA (nack/ack -1),
 * NUNCA "read": READ/PLAYED são registrados como progresso mas JAMAIS disparam nada de negativo.
 *
 * MAPA DE ACK (empírico deste sistema — waha.md: "ack 2 = entregue/confiável", "ack 1 nunca"):
 *   -1  ERROR    → nack (inclui 463). TERMINAL: entrega falhou.
 *    0  PENDING  → aceito pelo WAHA, sem confirmação de servidor.
 *    1  SERVER   → servidor recebeu (ainda NÃO entregue ao aparelho).
 *    2  DEVICE   → ENTREGUE ao aparelho do destinatário  ← confirmação de entrega.
 *    3+ READ     → lido/reproduzido (READ/PLAYED). Já implica entregue; não usamos como sinal.
 *
 * RANK monotônico (pra nunca "rebaixar" um status já observado): ERROR=-1 < PENDING=0 <
 * SERVER=1 < DEVICE=2 < READ=3. A regra "só sobe" vale pros não-terminais; ERROR é terminal.
 */

/** Status de entrega de um outbound, do mais fraco (ERROR/PENDING) ao mais forte (READ). */
export type OutboundAckStatus = 'ERROR' | 'PENDING' | 'SERVER' | 'DEVICE' | 'READ';

export interface AckMapping {
  /** Status normalizado. */
  status: OutboundAckStatus;
  /** Rank monotônico (ERROR=-1 .. READ=3). Usado pra "só sobe" no update atômico. */
  rank: number;
  /** true só pro ERROR (nack/463/ack -1) — falha DEFINITIVA de entrega. */
  terminal: boolean;
}

const STATUS_RANK: Record<OutboundAckStatus, number> = {
  ERROR: -1,
  PENDING: 0,
  SERVER: 1,
  DEVICE: 2,
  READ: 3,
};

/** Rank de um status (helper pra callers que persistem o rank ao lado do status). */
export function ackStatusRank(status: OutboundAckStatus): number {
  return STATUS_RANK[status];
}

/**
 * Mapeia o par (ack numérico, ackName textual) do WAHA num status normalizado + rank + terminal.
 * O NOME é autoritativo quando presente e conhecido (mais estável entre engines que o número);
 * caindo pro número quando o nome falta/é desconhecido. Entrada estranha (número não mapeado,
 * nome vazio) => FAIL-SAFE PENDING — NUNCA inventa um ERROR (que dispararia alerta) por engano.
 */
export function mapWahaAck(ackCode: number, ackName?: string | null): AckMapping {
  const name = (ackName ?? '').trim().toUpperCase();

  // 1) Nome autoritativo (quando conhecido).
  switch (name) {
    case 'ERROR':
      return { status: 'ERROR', rank: -1, terminal: true };
    case 'PENDING':
      return { status: 'PENDING', rank: 0, terminal: false };
    case 'SERVER':
      return { status: 'SERVER', rank: 1, terminal: false };
    case 'DEVICE':
      return { status: 'DEVICE', rank: 2, terminal: false };
    case 'READ':
    case 'PLAYED':
      return { status: 'READ', rank: 3, terminal: false };
    default:
      break; // nome ausente/desconhecido → cai pro número.
  }

  // 2) Fallback numérico.
  if (Number.isFinite(ackCode)) {
    if (ackCode <= -1) return { status: 'ERROR', rank: -1, terminal: true };
    if (ackCode === 0) return { status: 'PENDING', rank: 0, terminal: false };
    if (ackCode === 1) return { status: 'SERVER', rank: 1, terminal: false };
    if (ackCode === 2) return { status: 'DEVICE', rank: 2, terminal: false };
    if (ackCode >= 3) return { status: 'READ', rank: 3, terminal: false };
  }

  // 3) Desconhecido → fail-safe PENDING (nunca ERROR por engano).
  return { status: 'PENDING', rank: 0, terminal: false };
}

/** Coerção defensiva de um campo desconhecido para number (aceita number OU string numérica). */
function coerceNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function pickString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export interface ParsedAckEvent {
  /** id da mensagem ACKada (o MESMO id que registramos no envio). */
  messageId: string;
  /** ack numérico bruto (-1..4). */
  ackCode: number;
  /** ackName textual do WAHA, se veio (ERROR/SERVER/DEVICE/READ/…). */
  ackName: string | null;
  /** fromMe do payload — só ACKamos outbound nosso (fromMe=true). null quando ausente. */
  fromMe: boolean | null;
}

/**
 * Extrai (messageId, ackCode, ackName, fromMe) do payload de um evento `message.ack` do WAHA.
 * Defensivo (engine congelada/incerta, payload em passthrough): tenta os caminhos conhecidos e
 * devolve null quando não dá pra identificar a mensagem OU o ack — o chamador então IGNORA
 * (ack de mensagem desconhecida = no-op, regra fail-safe). NUNCA lança.
 */
export function parseWahaAckPayload(payload: unknown): ParsedAckEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;

  const messageId =
    pickString(p.id) ??
    pickString((p.id as Record<string, unknown> | undefined)?._serialized) ??
    pickString((p.id as Record<string, unknown> | undefined)?.id) ??
    pickString(p.messageId);
  if (!messageId) return null;

  const ackCode = coerceNumber(p.ack);
  const ackName = pickString(p.ackName);
  // Sem ack numérico E sem nome conhecido não há o que atualizar.
  if (ackCode === null && !ackName) return null;

  const fromMeRaw = p.fromMe;
  const fromMe = typeof fromMeRaw === 'boolean' ? fromMeRaw : null;

  return { messageId, ackCode: ackCode ?? Number.NaN, ackName, fromMe };
}

/**
 * Extrai o id da mensagem ENVIADA a partir da resposta do `POST /api/sendText` do WAHA.
 * As engines/versões variam MUITO onde põem o id (topo, `id._serialized`, `_data.id.*`, `key.id`)
 * e a 2026.6.2 nem sempre traz id no topo (waha.md) — por isso a extração é defensiva e best-effort.
 * Retorna null quando não achar (o envio segue funcionando; só não há rastreio pra AQUELE outbound).
 * NUNCA lança.
 */
export function extractSentMessageId(response: unknown): string | null {
  if (typeof response === 'string') return response.length > 0 ? response : null;
  if (!response || typeof response !== 'object') return null;
  const r = response as Record<string, unknown>;
  const idObj = r.id as Record<string, unknown> | undefined;
  const dataObj = r._data as Record<string, unknown> | undefined;
  const dataId = dataObj?.id as Record<string, unknown> | undefined;
  const keyObj = r.key as Record<string, unknown> | undefined;
  const dataKey = dataObj?.key as Record<string, unknown> | undefined;

  return (
    pickString(r.id) ??
    pickString(idObj?._serialized) ??
    pickString(idObj?.id) ??
    pickString(dataId?._serialized) ??
    pickString(dataId?.id) ??
    pickString(keyObj?.id) ??
    pickString(dataKey?.id) ??
    pickString(r.messageId)
  );
}
