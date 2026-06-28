import { query } from '../client.js';

/**
 * Antibot (substitui Monitor_AntiBot do automação visual antiga).
 *
 * Detecta numeros que enviam 6+ mensagens em 60 segundos e os bloqueia
 * inserindo na tabela bot_pausa.
 *
 * Tabela real:
 *   message_log (id, phone, chat_id, created_at)
 */

export async function logMessage(telefone: string, sessao: string): Promise<void> {
  await query('INSERT INTO message_log (phone, chat_id, created_at) VALUES ($1, $2, NOW())', [
    telefone,
    sessao,
  ]);
}

export interface SuspectRow {
  telefone: string;
  total: number;
  /** Sessão WAHA — valor de message_log.chat_id. Usado para resolver flow_id via bot_config. */
  session: string;
}

export async function findSuspects(thresholdCount = 6, windowSeconds = 60): Promise<SuspectRow[]> {
  const r = await query<{ phone: string; total: string; chat_id: string }>(
    `SELECT phone, chat_id, COUNT(*)::text AS total
     FROM message_log
     WHERE created_at > NOW() - ($1 || ' seconds')::INTERVAL
     GROUP BY phone, chat_id
     HAVING COUNT(*) >= $2`,
    [String(windowSeconds), thresholdCount],
  );
  return r.rows.map((x) => ({ telefone: x.phone, total: Number(x.total), session: x.chat_id }));
}

export async function pruneOldLogs(hoursToKeep = 24): Promise<number> {
  const r = await query(
    "DELETE FROM message_log WHERE created_at < NOW() - ($1 || ' hours')::INTERVAL",
    [String(hoursToKeep)],
  );
  return r.rowCount ?? 0;
}

/**
 * Remove entradas antigas de bot_pausa (já desbloqueadas ou ativas há muito tempo).
 * Requer coluna created_at adicionada em migration 025.
 * Controlado por BOT_PAUSA_RETENTION_DAYS (default 30).
 */
export async function pruneOldBotPausa(daysToKeep = 30): Promise<number> {
  const r = await query(
    "DELETE FROM bot_pausa WHERE created_at < NOW() - ($1 || ' days')::INTERVAL",
    [String(daysToKeep)],
  );
  return r.rowCount ?? 0;
}

/**
 * ALLOWLIST DURA do antibot (SCRUM-4 PR-A) — "este telefone já agendou neste clone?".
 *
 * Usada SÓ quando a flag ANTIBOT_ALLOWLIST_ENABLED está ON: antes de pausar um suspeito de
 * flood, se ele JÁ tem histórico de agendamento no clone, é cliente real -> NÃO pausa
 * (reduz falso-positivo de pausar cliente). Flag OFF = esta função nem é chamada.
 *
 * FONTE = `atendimentos` (ADR 0026 = fonte da verdade do agendamento/dinheiro do cliente no
 * Postgres). É a mais BARATA e confiável: tabela LOCAL, indexada por slot
 * (ix_atend_slot_tenant_data). NÃO toca GCal (rede/externo) nem package_redemptions (não
 * amarra telefone↔booking direto).
 *
 * ISOLAMENTO: filtra por `slot`. No modelo atual slot↔clone↔tenant é 1:1 (toda linha de
 * atendimentos é carimbada com slot+tenant do MESMO clone), então o slot JÁ é a fronteira de
 * tenant. O antibot resolve flowId=slot e NÃO tem o tenant_id à mão de graça aqui; re-derivá-lo
 * seria I/O redundante (mesma garantia de isolamento). Query 100% parametrizada (slot + sufixo).
 *
 * MATCH por SUFIXO de 8 dígitos (subscriber number BR). Robusto a:
 *  - ambiguidade do 9º dígito móvel (WAHA/Baileys ora entrega COM, ora SEM o 9): o 9 é o 1º
 *    dígito do celular -> NUNCA entra nos últimos 8 -> o sufixo bate nas duas formas.
 *  - formatos sujos em cliente_contato (máscara "(35) 99174-6797", "+55…", espaços) via
 *    regexp_replace tirando tudo que não é dígito.
 * Heurística DELIBERADA de allowlist (o objetivo é NÃO pausar cliente real): uma eventual
 * colisão de sufixo DENTRO de um único clone só causaria um skip (não-pausa) — o lado seguro.
 * Match exato canônico (canonicalE164) = tech debt aceito no PR.
 */
export async function hasScheduledHistory(slot: string, telefone: string): Promise<boolean> {
  const digits = (telefone ?? '').replace(/\D/g, '');
  // < 8 dígitos = telefone inválido/curto -> sem como casar com segurança -> não allowlista.
  if (digits.length < 8) return false;
  const last8 = digits.slice(-8);
  const r = await query(
    `SELECT 1
       FROM atendimentos
      WHERE slot = $1
        AND deleted_at IS NULL
        AND cliente_contato IS NOT NULL
        AND right(regexp_replace(cliente_contato, '[^0-9]', '', 'g'), 8) = $2
      LIMIT 1`,
    [slot, last8],
  );
  return (r.rowCount ?? 0) > 0;
}
