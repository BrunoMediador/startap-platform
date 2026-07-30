/**
 * Corte de idade de mensagem inbound (incidente WAHA 26h fora do ar, 28-30/07 —
 * a engine retomou entregando o BACKLOG inteiro via webhook e o app processou
 * tudo como se fosse novo: 1.420 eventos numa hora, 31 mensagens de fato
 * ENVIADAS a clientes finais, 50 números com ≥2 mensagens, 1 número com 26).
 *
 * Ordem do Bruno: "mensagens com mais de 20 minutos já não pode mais carregar
 * fila quando voltar". Barra o MAIS CEDO possível no pipeline (webhook, antes
 * de dedup/LLM/router) — nunca gasta token nem produz efeito colateral
 * (gravar atendimento, criar evento GCal) para um evento velho.
 *
 * Usa o timestamp ORIGINAL da mensagem no WhatsApp
 * (`payload._data.messageTimestamp`, Unix seconds) — NUNCA o horário de
 * chegada do webhook. Retry do WAHA reenvia o MESMO messageTimestamp; se
 * comparássemos contra o horário de chegada, todo retry "rejuvenesceria" a
 * mensagem e o gate nunca pegaria nada.
 *
 * FAIL-OPEN por design: sem timestamp utilizável, NÃO descarta (mensagem
 * legítima nunca deve sumir por payload incompleto) — só loga warn.
 */
import { logger } from '@startap/core/logger';
import { phoneLogTag } from '@startap/core/phone';
import type { WahaWebhookBody } from '@startap/core/types';

const log = logger.child({ module: 'inbound-age' });

export interface InboundAgeCheck {
  /** true = mensagem velha demais, o chamador deve DESCARTAR (não processar). */
  stale: boolean;
  /** Idade em minutos, quando calculável (null = sem timestamp utilizável). */
  ageMinutes: number | null;
}

/** Extrai o timestamp Unix (segundos) original da mensagem do payload WAHA.
 * Aceita number ou string (NOWEB serializa como string em alguns casos —
 * mesmo padrão de leitura já usado em router.ts:buildIncomingMessage). */
function extractMessageTimestampSeconds(body: WahaWebhookBody): number | null {
  const raw = body.payload?._data?.messageTimestamp;
  if (raw == null) return null;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Avalia se o evento inbound deve ser descartado por idade.
 *
 * @param body           payload WAHA já validado pelo Zod
 * @param maxAgeMinutes  corte configurável (config.INBOUND_MAX_AGE_MINUTES)
 * @param nowMs          injetável para teste (default Date.now())
 */
export function checkInboundAge(
  body: WahaWebhookBody,
  maxAgeMinutes: number,
  nowMs: number = Date.now(),
): InboundAgeCheck {
  const tsSeconds = extractMessageTimestampSeconds(body);
  if (tsSeconds === null) {
    log.warn(
      { session: body.session, event: body.event },
      'Mensagem sem messageTimestamp utilizável — fail-open, não descarta por idade',
    );
    return { stale: false, ageMinutes: null };
  }

  const ageMs = nowMs - tsSeconds * 1000;
  const ageMinutes = ageMs / 60_000;
  return { stale: ageMinutes > maxAgeMinutes, ageMinutes };
}

/** Loga o descarte por idade — LGPD-safe (telefone SEMPRE mascarado, nunca conteúdo). */
export function logInboundAgeDiscard(
  body: WahaWebhookBody,
  ageMinutes: number,
  maxAgeMinutes: number,
): void {
  log.warn(
    {
      session: body.session,
      fone: phoneLogTag(body.payload?.from),
      ageMinutes: Math.round(ageMinutes * 10) / 10,
      maxAgeMinutes,
      event: body.event,
    },
    'Mensagem inbound descartada por idade (backlog pós-indisponibilidade WAHA)',
  );
}
