import { query } from '../client.js';

export type AgendaBloqueioSerieStatus = 'creating' | 'complete' | 'partial' | 'failed';

export interface AgendaBloqueioSerieClaim {
  id: string;
  status: AgendaBloqueioSerieStatus;
  response_status: number | null;
  response_body: Record<string, unknown> | null;
}

interface ClaimRow extends AgendaBloqueioSerieClaim {}

export async function claimCreate(input: {
  id: string;
  tenantId: string;
  slot: string;
  colaboradorId: number | null;
  sessionHash: string;
  payloadHash: string;
}): Promise<
  | { claimed: true; serie: AgendaBloqueioSerieClaim }
  | { claimed: false; serie: AgendaBloqueioSerieClaim }
> {
  const inserted = await query<ClaimRow>(
    `INSERT INTO agenda_bloqueio_series (
       id, tenant_id, slot, colaborador_key, session_hash, payload_hash, status
     ) VALUES ($1,$2,$3,$4,$5,$6,'creating')
     ON CONFLICT (tenant_id, slot, colaborador_key, session_hash, payload_hash) DO UPDATE
       SET id = EXCLUDED.id,
           status = 'creating',
           response_status = NULL,
           response_body = NULL,
           updated_at = now()
       WHERE agenda_bloqueio_series.status = 'failed'
     RETURNING id, status, response_status, response_body`,
    [
      input.id,
      input.tenantId,
      input.slot,
      input.colaboradorId ?? 0,
      input.sessionHash,
      input.payloadHash,
    ],
  );
  if (inserted.rows[0]) return { claimed: true, serie: inserted.rows[0] };

  const existing = await query<ClaimRow>(
    `SELECT id, status, response_status, response_body
       FROM agenda_bloqueio_series
      WHERE tenant_id = $1
        AND slot = $2
        AND colaborador_key = $3
        AND session_hash = $4
        AND payload_hash = $5
      LIMIT 1`,
    [input.tenantId, input.slot, input.colaboradorId ?? 0, input.sessionHash, input.payloadHash],
  );
  if (!existing.rows[0]) throw new Error('agenda_bloqueio_series_claim_inconsistente');
  return { claimed: false, serie: existing.rows[0] };
}

export async function markCreateResult(input: {
  tenantId: string;
  slot: string;
  serieId: string;
  status: Exclude<AgendaBloqueioSerieStatus, 'creating'>;
  responseStatus: number;
  responseBody: Record<string, unknown>;
}): Promise<void> {
  await query(
    `UPDATE agenda_bloqueio_series
        SET status = $4,
            response_status = $5,
            response_body = $6::jsonb,
            updated_at = now()
      WHERE tenant_id = $1
        AND slot = $2
        AND id = $3`,
    [
      input.tenantId,
      input.slot,
      input.serieId,
      input.status,
      input.responseStatus,
      JSON.stringify(input.responseBody),
    ],
  );
}
