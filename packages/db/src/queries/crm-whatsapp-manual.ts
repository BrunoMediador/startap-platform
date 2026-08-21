/**
 * CRM WhatsApp manual: alvo autorizado, guarda de cooldown e auditoria mínima.
 * Nenhuma query persiste corpo da mensagem, telefone cru ou retorno cru da WAHA.
 */
import { randomUUID } from 'node:crypto';
import { query } from '../client.js';

interface SendTargetRow {
  telefone_raw: string;
  waha_sessao: string | null;
}

export interface ClienteWhatsAppManualTarget {
  telefone: string;
  wahaSessao: string | null;
}

export interface ClaimClienteWhatsAppManualInput {
  slot: string;
  tenantId: string;
  clienteId: string;
  operatorUserId: number;
  cooldownMs: number;
}

export interface ClienteWhatsAppManualClaim {
  sendId: string;
  cooldownUntil: string;
}

/** Busca o cliente no escopo da sessão e resolve a sessão WAHA pelo clone, nunca pelo slot. */
export async function getClienteWhatsAppManualTargetForOwner(
  slot: string,
  tenantId: string,
  clienteId: string,
): Promise<ClienteWhatsAppManualTarget | null> {
  const result = await query<SendTargetRow>(
    `SELECT c.telefone_raw, fc.waha_sessao
       FROM clientes c
       JOIN flow_clones fc
         ON fc.slot = c.slot
        AND fc.tenant_id = c.tenant_id
      WHERE c.id = $1
        AND c.slot = $2
        AND c.tenant_id = $3
      LIMIT 1`,
    [clienteId, slot, tenantId],
  );
  const row = result.rows[0];
  return row ? { telefone: row.telefone_raw, wahaSessao: row.waha_sessao } : null;
}

/**
 * Claim atômico por operador+cliente. O INSERT no audit só nasce quando a guarda
 * foi adquirida; concorrentes recebem null e nunca alcançam a WAHA.
 */
export async function claimClienteWhatsAppManualSend(
  input: ClaimClienteWhatsAppManualInput,
): Promise<ClienteWhatsAppManualClaim | null> {
  const sendId = randomUUID();
  const result = await query<{ id: string; cooldown_until: string }>(
    `WITH claimed AS (
       INSERT INTO crm_whatsapp_manual_send_guards (
         slot, tenant_id, cliente_id, operator_user_id, cooldown_until, last_send_id, updated_at
       )
       VALUES ($1, $2, $3, $4, NOW() + ($5::bigint * INTERVAL '1 millisecond'), $6, NOW())
       ON CONFLICT (slot, tenant_id, cliente_id, operator_user_id) DO UPDATE
         SET cooldown_until = EXCLUDED.cooldown_until,
             last_send_id = EXCLUDED.last_send_id,
             updated_at = NOW()
       WHERE crm_whatsapp_manual_send_guards.cooldown_until <= NOW()
       RETURNING cooldown_until
     ), audit AS (
       INSERT INTO crm_whatsapp_manual_send_audit (
         id, slot, tenant_id, cliente_id, operator_user_id, outcome
       )
       SELECT $6, $1, $2, $3, $4, 'claimed'
         FROM claimed
       RETURNING id
     )
     SELECT audit.id, claimed.cooldown_until
       FROM claimed
       JOIN audit ON TRUE`,
    [input.slot, input.tenantId, input.clienteId, input.operatorUserId, input.cooldownMs, sendId],
  );
  const row = result.rows[0];
  return row ? { sendId: row.id, cooldownUntil: row.cooldown_until } : null;
}

export async function completeClienteWhatsAppManualSend(input: {
  slot: string;
  tenantId: string;
  sendId: string;
  outcome: 'sent' | 'failed';
  failureCode?: 'circuit_open' | 'timeout_or_waha_error';
}): Promise<void> {
  await query(
    `UPDATE crm_whatsapp_manual_send_audit
        SET outcome = $4,
            failure_code = $5,
            completed_at = NOW()
      WHERE id = $1
        AND slot = $2
        AND tenant_id = $3
        AND outcome = 'claimed'`,
    [input.sendId, input.slot, input.tenantId, input.outcome, input.failureCode ?? null],
  );
}
