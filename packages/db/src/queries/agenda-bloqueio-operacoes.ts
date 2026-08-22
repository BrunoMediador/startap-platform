import { query } from '../client.js';

export type AgendaBloqueioOperacaoStatus =
  | 'planned'
  | 'creating'
  | 'complete'
  | 'partial'
  | 'recovery_required'
  | 'failed_final';
export type AgendaBloqueioOcorrenciaStatus =
  | 'planned'
  | 'gcal_dispatch_started'
  | 'active'
  | 'recovery_required';

/**
 * O marcador `gcal_dispatch_started` é uma lease persistida em `updated_at`.
 * Sessenta segundos evita reclaim de uma chamada normal em andamento e, após
 * crash, torna a ocorrência recuperável sem worker automático.
 */
export const GCAL_DISPATCH_LEASE_SECONDS = 60;

export interface AgendaBloqueioOperacao {
  id: string;
  status: AgendaBloqueioOperacaoStatus;
}
export interface AgendaBloqueioOperacaoRecovery extends AgendaBloqueioOperacao {
  actor_role: 'owner' | 'colaborador';
  actor_user_id: number | null;
  actor_colaborador_id: number | null;
  timezone: string;
  tipo: 'almoco' | 'ausencia' | 'ferias' | 'indisponivel';
  motivo: string | null;
  response_status: number | null;
  response_body: Record<string, unknown> | null;
}
export interface AgendaBloqueioOperacaoOcorrencia {
  operation_id: string;
  ordinal: number;
  inicio_at: string;
  fim_at: string;
  bloqueio_id: string;
  gcal_event_id: string;
  status: AgendaBloqueioOcorrenciaStatus;
  error_code: string | null;
}

export async function createPlan(input: {
  operationId: string;
  tenantId: string;
  slot: string;
  colaboradorId: number | null;
  sessionHash: string;
  payloadHash: string;
  actorRole: 'owner' | 'colaborador';
  actorUserId: number | null;
  actorColaboradorId: number | null;
  timezone: string;
  tipo: 'almoco' | 'ausencia' | 'ferias' | 'indisponivel';
  motivo: string | null;
  occurrences: Array<{
    ordinal: number;
    inicioAt: string;
    fimAt: string;
    bloqueioId: string;
    gcalEventId: string;
  }>;
}): Promise<{ created: boolean; operation: AgendaBloqueioOperacao }> {
  if (input.occurrences.length === 0) {
    throw new Error('agenda_bloqueio_operacao_sem_ocorrencias');
  }
  if (input.occurrences.length < 2 || input.occurrences.length > 24) {
    throw new Error('agenda_bloqueio_operacao_quantidade_ocorrencias_invalida');
  }
  const result = await query<AgendaBloqueioOperacao & { created: boolean }>(
    `WITH operation_claim AS (
       INSERT INTO agenda_bloqueio_operacoes (
         id, tenant_id, slot, colaborador_key, session_hash, payload_hash,
         actor_role, actor_user_id, actor_colaborador_id, timezone, tipo, motivo
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (tenant_id, slot, colaborador_key, session_hash, payload_hash)
       DO UPDATE SET updated_at = agenda_bloqueio_operacoes.updated_at
       RETURNING id, status, (xmax = 0) AS created
     ), inserted_plan AS (
       INSERT INTO agenda_bloqueio_operacao_ocorrencias
         (operation_id, ordinal, inicio_at, fim_at, bloqueio_id, gcal_event_id)
       SELECT operation_claim.id, plan.ordinal, plan.inicio_at, plan.fim_at,
              plan.bloqueio_id, plan.gcal_event_id
         FROM operation_claim
         CROSS JOIN jsonb_to_recordset($13::jsonb) AS plan(
           ordinal integer, inicio_at timestamptz, fim_at timestamptz,
           bloqueio_id uuid, gcal_event_id text
         )
        WHERE operation_claim.created
       RETURNING operation_id
     )
     SELECT id, status, created FROM operation_claim`,
    [
      input.operationId,
      input.tenantId,
      input.slot,
      input.colaboradorId ?? 0,
      input.sessionHash,
      input.payloadHash,
      input.actorRole,
      input.actorUserId,
      input.actorColaboradorId,
      input.timezone,
      input.tipo,
      input.motivo,
      JSON.stringify(
        input.occurrences.map((o) => ({
          ordinal: o.ordinal,
          inicio_at: o.inicioAt,
          fim_at: o.fimAt,
          bloqueio_id: o.bloqueioId,
          gcal_event_id: o.gcalEventId,
        })),
      ),
    ],
  );
  const operation = result.rows[0];
  if (!operation) throw new Error('agenda_bloqueio_operacao_claim_inconsistente');
  return { created: operation.created, operation: { id: operation.id, status: operation.status } };
}

/** Persiste a intenção de chamada externa antes do POST para o GCal. */
export async function claimDispatch(input: {
  tenantId: string;
  slot: string;
  operationId: string;
  ordinal: number;
}): Promise<AgendaBloqueioOperacaoOcorrencia | null> {
  const r = await query<AgendaBloqueioOperacaoOcorrencia>(
    `UPDATE agenda_bloqueio_operacao_ocorrencias o SET status='gcal_dispatch_started', updated_at=now()
       FROM agenda_bloqueio_operacoes op
      WHERE o.operation_id=op.id AND op.tenant_id=$1 AND op.slot=$2 AND o.operation_id=$3 AND o.ordinal=$4 AND o.status='planned'
      RETURNING o.*`,
    [input.tenantId, input.slot, input.operationId, input.ordinal],
  );
  return r.rows[0] ?? null;
}

/**
 * Reivindica exclusivamente uma ocorrência ambígua (ou lease expirada) antes
 * de a reconciliar. Quem perde o CAS não pode consultar/recriar o evento remoto.
 */
export async function claimRecovery(input: {
  tenantId: string;
  slot: string;
  operationId: string;
  ordinal: number;
}): Promise<AgendaBloqueioOperacaoOcorrencia | null> {
  const r = await query<AgendaBloqueioOperacaoOcorrencia>(
    `UPDATE agenda_bloqueio_operacao_ocorrencias o SET status='gcal_dispatch_started', updated_at=now()
       FROM agenda_bloqueio_operacoes op
      WHERE o.operation_id=op.id AND op.tenant_id=$1 AND op.slot=$2 AND o.operation_id=$3 AND o.ordinal=$4
        AND (
          o.status='recovery_required'
          OR (o.status='gcal_dispatch_started'
              AND o.updated_at <= now() - make_interval(secs => $5))
        )
      RETURNING o.*`,
    [input.tenantId, input.slot, input.operationId, input.ordinal, GCAL_DISPATCH_LEASE_SECONDS],
  );
  return r.rows[0] ?? null;
}

export async function markOccurrence(input: {
  tenantId: string;
  slot: string;
  operationId: string;
  ordinal: number;
  status: Extract<AgendaBloqueioOcorrenciaStatus, 'active' | 'recovery_required'>;
  errorCode?: string | null;
  expectedStatus?: 'gcal_dispatch_started';
}): Promise<boolean> {
  const result = await query(
    `UPDATE agenda_bloqueio_operacao_ocorrencias o SET status=$5, error_code=$6, updated_at=now()
       FROM agenda_bloqueio_operacoes op WHERE o.operation_id=op.id AND op.tenant_id=$1 AND op.slot=$2 AND o.operation_id=$3 AND o.ordinal=$4
         AND ($7::text IS NULL OR o.status=$7)`,
    [
      input.tenantId,
      input.slot,
      input.operationId,
      input.ordinal,
      input.status,
      input.errorCode ?? null,
      input.expectedStatus ?? null,
    ],
  );
  return result.rowCount === 1;
}

export async function listForRecovery(input: {
  tenantId: string;
  slot: string;
  operationId: string;
  colaboradorId: number | null;
}): Promise<AgendaBloqueioOperacaoOcorrencia[]> {
  const r = await query<AgendaBloqueioOperacaoOcorrencia>(
    `SELECT o.* FROM agenda_bloqueio_operacao_ocorrencias o JOIN agenda_bloqueio_operacoes op ON op.id=o.operation_id
      WHERE op.tenant_id=$1 AND op.slot=$2 AND op.id=$3 AND op.colaborador_key=$4 AND o.status IN ('planned','gcal_dispatch_started','recovery_required') ORDER BY o.ordinal`,
    [input.tenantId, input.slot, input.operationId, input.colaboradorId ?? 0],
  );
  return r.rows;
}

export async function getOperation(input: {
  tenantId: string;
  slot: string;
  operationId: string;
  colaboradorId: number | null;
}): Promise<AgendaBloqueioOperacao | null> {
  const r = await query<AgendaBloqueioOperacao>(
    'SELECT id, status FROM agenda_bloqueio_operacoes WHERE tenant_id=$1 AND slot=$2 AND id=$3 AND colaborador_key=$4 LIMIT 1',
    [input.tenantId, input.slot, input.operationId, input.colaboradorId ?? 0],
  );
  return r.rows[0] ?? null;
}

export async function getOperationForRecovery(input: {
  tenantId: string;
  slot: string;
  operationId: string;
  colaboradorId: number | null;
}): Promise<AgendaBloqueioOperacaoRecovery | null> {
  const r = await query<AgendaBloqueioOperacaoRecovery>(
    `SELECT id, status, actor_role, actor_user_id, actor_colaborador_id,
            timezone, tipo, motivo, response_status, response_body
       FROM agenda_bloqueio_operacoes
      WHERE tenant_id=$1 AND slot=$2 AND id=$3 AND colaborador_key=$4
      LIMIT 1`,
    [input.tenantId, input.slot, input.operationId, input.colaboradorId ?? 0],
  );
  return r.rows[0] ?? null;
}

export async function markOperationResult(input: {
  tenantId: string;
  slot: string;
  operationId: string;
  colaboradorId: number | null;
  status: Exclude<AgendaBloqueioOperacaoStatus, 'planned' | 'creating'>;
  responseStatus: number;
  responseBody: Record<string, unknown>;
}): Promise<void> {
  await query(
    `UPDATE agenda_bloqueio_operacoes
        SET status=$5, response_status=$6, response_body=$7::jsonb, updated_at=now()
      WHERE tenant_id=$1 AND slot=$2 AND id=$3 AND colaborador_key=$4`,
    [
      input.tenantId,
      input.slot,
      input.operationId,
      input.colaboradorId ?? 0,
      input.status,
      input.responseStatus,
      JSON.stringify(input.responseBody),
    ],
  );
}
