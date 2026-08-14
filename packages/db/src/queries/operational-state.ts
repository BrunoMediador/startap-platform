import type { PoolClient } from 'pg';
import { query } from '../client.js';

export interface OperationalSnapshot {
  slot: string;
  tenant_id: string | null;
  clone_status: string;
  atendimento_configured: boolean;
  waha_sessao: string | null;
  flow_enabled: boolean;
  suspended_reason: string | null;
  suspended_kind: string | null;
  suspended_at: Date | null;
  next_due_date: string | null;
  billing_amount_cents: number | null;
}

type OperationalRow = Omit<OperationalSnapshot, 'billing_amount_cents'> & {
  billing_amount_cents: number | string | null;
};

function normalize(row: OperationalRow): OperationalSnapshot {
  return {
    ...row,
    atendimento_configured: row.atendimento_configured === true,
    flow_enabled: row.flow_enabled !== false,
    billing_amount_cents:
      row.billing_amount_cents == null ? null : Number(row.billing_amount_cents),
  };
}

const SNAPSHOT_SQL = `SELECT fc.slot,
       fc.tenant_id::text AS tenant_id,
       fc.status AS clone_status,
       (fc.waha_sessao IS NOT NULL AND fc.status <> 'rascunho') AS atendimento_configured,
       fc.waha_sessao,
       fc.flow_enabled,
       fc.suspended_reason,
       fc.suspended_kind,
       fc.suspended_at,
       to_char(cb.next_due_date, 'YYYY-MM-DD') AS next_due_date,
       cb.amount_cents AS billing_amount_cents
  FROM flow_clones fc
  LEFT JOIN client_billing cb ON cb.slot = fc.slot
 WHERE fc.slot = $1`;

/** Leitura operacional autoritativa. Nunca consulta nem preenche cache process-local. */
export async function getOperationalSnapshotBySlot(
  slot: string,
  client?: PoolClient,
): Promise<OperationalSnapshot | null> {
  const exec = client ? client.query.bind(client) : query;
  const result = await exec<OperationalRow>(SNAPSHOT_SQL, [slot]);
  return result.rows[0] ? normalize(result.rows[0]) : null;
}

/**
 * Variante para decisão mutante. O caller deve adquirir o advisory `billing:<slot>` antes.
 * Trava primeiro o clone e depois o billing, sempre nesta ordem, e devolve o mesmo snapshot.
 */
export async function getOperationalSnapshotForUpdate(
  client: PoolClient,
  slot: string,
): Promise<OperationalSnapshot | null> {
  const clone = await client.query<{
    slot: string;
    tenant_id: string | null;
    clone_status: string;
    atendimento_configured: boolean;
    waha_sessao: string | null;
    flow_enabled: boolean;
    suspended_reason: string | null;
    suspended_kind: string | null;
    suspended_at: Date | null;
  }>(
    `SELECT slot,
            tenant_id::text AS tenant_id,
            status AS clone_status,
            (waha_sessao IS NOT NULL AND status <> 'rascunho') AS atendimento_configured,
            waha_sessao, flow_enabled, suspended_reason, suspended_kind, suspended_at
       FROM flow_clones
      WHERE slot = $1
      FOR UPDATE`,
    [slot],
  );
  if (!clone.rows[0]) return null;

  const billing = await client.query<{
    next_due_date: string | null;
    billing_amount_cents: number | string | null;
  }>(
    `SELECT to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date,
            amount_cents AS billing_amount_cents
       FROM client_billing
      WHERE slot = $1
      FOR UPDATE`,
    [slot],
  );

  return normalize({
    ...clone.rows[0],
    next_due_date: billing.rows[0]?.next_due_date ?? null,
    billing_amount_cents: billing.rows[0]?.billing_amount_cents ?? null,
  });
}
