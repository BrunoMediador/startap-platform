import { query } from '../client.js';

export type BookingConfirmationStatus =
  | 'pending'
  | 'confirming'
  | 'booked'
  | 'expired'
  | 'superseded'
  | 'conflict'
  | 'recovery_required';

export interface BookingConfirmationProposal {
  id: string;
  tenant_id: string;
  slot: string;
  contact_hmac: string;
  colaborador_id: number | null;
  servico: string;
  inicio_at: string;
  fim_at: string;
  timezone: string;
  usa_pacote: boolean | null;
  event_id: string;
  status: BookingConfirmationStatus;
  expires_at: string;
  card_sent_at: string;
  created_at: string;
  updated_at: string;
}

interface ProposalRaw extends Omit<BookingConfirmationProposal, 'colaborador_id'> {
  colaborador_id: number | string | null;
}

function mapProposal(row: ProposalRaw): BookingConfirmationProposal {
  return { ...row, colaborador_id: row.colaborador_id == null ? null : Number(row.colaborador_id) };
}

export async function replacePending(input: {
  id: string;
  tenantId: string;
  slot: string;
  contactHmac: string;
  colaboradorId: number | null;
  servico: string;
  inicioAt: string;
  fimAt: string;
  timezone: string;
  usaPacote: boolean | null;
  eventId: string;
  expiresAt: string;
}): Promise<BookingConfirmationProposal> {
  const result = await query<ProposalRaw>(
    `WITH lock_scope AS (
       SELECT pg_advisory_xact_lock(hashtextextended($3 || ':' || $4, 0))
     ), superseded AS (
       UPDATE booking_confirmation_proposals
          SET status='superseded', updated_at=now()
         FROM lock_scope
        WHERE tenant_id=$1 AND slot=$3 AND contact_hmac=$4 AND status='pending'
     )
     INSERT INTO booking_confirmation_proposals (
       id, tenant_id, slot, contact_hmac, colaborador_id, servico, inicio_at, fim_at,
       timezone, usa_pacote, event_id, expires_at
     ) VALUES ($2,$1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      input.tenantId,
      input.id,
      input.slot,
      input.contactHmac,
      input.colaboradorId,
      input.servico,
      input.inicioAt,
      input.fimAt,
      input.timezone,
      input.usaPacote,
      input.eventId,
      input.expiresAt,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('booking_confirmation_replace_pending_inconsistent');
  return mapProposal(row);
}

/** CAS: só o primeiro SIM dentro do TTL passa de pending para confirming. */
export async function claimForConfirmation(input: {
  tenantId: string;
  slot: string;
  contactHmac: string;
}): Promise<BookingConfirmationProposal | null> {
  const result = await query<ProposalRaw>(
    `UPDATE booking_confirmation_proposals
        SET status='confirming', updated_at=now()
      WHERE tenant_id=$1 AND slot=$2 AND contact_hmac=$3
        AND status='pending' AND expires_at > now()
      RETURNING *`,
    [input.tenantId, input.slot, input.contactHmac],
  );
  return result.rows[0] ? mapProposal(result.rows[0]) : null;
}

export async function expirePending(input: {
  tenantId: string;
  slot: string;
  contactHmac: string;
}): Promise<boolean> {
  const result = await query(
    `UPDATE booking_confirmation_proposals
        SET status='expired', updated_at=now()
      WHERE tenant_id=$1 AND slot=$2 AND contact_hmac=$3
        AND status='pending' AND expires_at <= now()`,
    [input.tenantId, input.slot, input.contactHmac],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Qualquer mensagem que não seja o SIM literal invalida o cartão anterior. */
export async function supersedePending(input: {
  tenantId: string;
  slot: string;
  contactHmac: string;
}): Promise<boolean> {
  const result = await query(
    `UPDATE booking_confirmation_proposals
        SET status='superseded', updated_at=now()
      WHERE tenant_id=$1 AND slot=$2 AND contact_hmac=$3 AND status='pending'`,
    [input.tenantId, input.slot, input.contactHmac],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Leitura de recovery/retry: sempre tenant+slot+contato, nunca por id sem escopo. */
export async function latestForContact(input: {
  tenantId: string;
  slot: string;
  contactHmac: string;
}): Promise<BookingConfirmationProposal | null> {
  const result = await query<ProposalRaw>(
    `SELECT * FROM booking_confirmation_proposals
      WHERE tenant_id=$1 AND slot=$2 AND contact_hmac=$3
      ORDER BY created_at DESC
      LIMIT 1`,
    [input.tenantId, input.slot, input.contactHmac],
  );
  return result.rows[0] ? mapProposal(result.rows[0]) : null;
}

export async function markBooked(input: {
  tenantId: string;
  slot: string;
  id: string;
}): Promise<boolean> {
  const result = await query(
    `UPDATE booking_confirmation_proposals
        SET status='booked', updated_at=now()
      WHERE tenant_id=$1 AND slot=$2 AND id=$3 AND status='confirming'`,
    [input.tenantId, input.slot, input.id],
  );
  return result.rowCount === 1;
}

export async function markConflict(input: {
  tenantId: string;
  slot: string;
  id: string;
}): Promise<boolean> {
  const result = await query(
    `UPDATE booking_confirmation_proposals
        SET status='conflict', updated_at=now()
      WHERE tenant_id=$1 AND slot=$2 AND id=$3 AND status='confirming'`,
    [input.tenantId, input.slot, input.id],
  );
  return result.rowCount === 1;
}

export async function markRecoveryRequired(input: {
  tenantId: string;
  slot: string;
  id: string;
}): Promise<boolean> {
  const result = await query(
    `UPDATE booking_confirmation_proposals
        SET status='recovery_required', updated_at=now()
      WHERE tenant_id=$1 AND slot=$2 AND id=$3 AND status='confirming'`,
    [input.tenantId, input.slot, input.id],
  );
  return result.rowCount === 1;
}

/** Retenção LGPD: somente estados terminais e somente após a janela configurada. */
export async function countTerminalBefore(cutoff: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM booking_confirmation_proposals
      WHERE expires_at < $1
        AND status IN ('booked','expired','superseded','conflict','recovery_required')`,
    [cutoff],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** Chamado somente pelo worker gated; idempotente para retries. */
export async function pruneTerminalBefore(cutoff: string): Promise<number> {
  const result = await query(
    `DELETE FROM booking_confirmation_proposals
      WHERE expires_at < $1
        AND status IN ('booked','expired','superseded','conflict','recovery_required')`,
    [cutoff],
  );
  return result.rowCount ?? 0;
}
