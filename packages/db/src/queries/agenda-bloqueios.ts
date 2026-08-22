import { query } from '../client.js';

export type AgendaBloqueioTipo = 'almoco' | 'ausencia' | 'ferias' | 'indisponivel';
export type AgendaBloqueioStatus =
  | 'creating'
  | 'active'
  | 'gcal_failed'
  | 'gcal_cleanup_failed'
  | 'deleted';
export type AgendaBloqueioCreatedByRole = 'owner' | 'colaborador';

export interface AgendaBloqueioRow {
  id: string;
  tenant_id: string;
  slot: string;
  colaborador_id: number | null;
  serie_id: string | null;
  gcal_event_id: string | null;
  inicio_at: string;
  fim_at: string;
  timezone: string;
  tipo: AgendaBloqueioTipo;
  motivo: string | null;
  status: AgendaBloqueioStatus;
  created_by_role: AgendaBloqueioCreatedByRole;
  created_by_user_id: number | null;
  created_by_colaborador_id: number | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AgendaBloqueioRaw extends Omit<AgendaBloqueioRow, 'colaborador_id'> {
  colaborador_id: string | number | null;
}

export interface CreateAgendaBloqueioInput {
  id: string;
  tenantId: string;
  slot: string;
  colaboradorId: number | null;
  serieId?: string | null;
  gcalEventId: string;
  inicioAt: string;
  fimAt: string;
  timezone: string;
  tipo: AgendaBloqueioTipo;
  motivo?: string | null;
  createdByRole: AgendaBloqueioCreatedByRole;
  createdByUserId?: number | null;
  createdByColaboradorId?: number | null;
}

export interface ListAgendaBloqueiosInput {
  tenantId: string;
  slot: string;
  colaboradorId?: number | null;
  serieId?: string | null;
  inicioAt?: string;
  fimAt?: string;
}

function mapRow(row: AgendaBloqueioRaw): AgendaBloqueioRow {
  return {
    ...row,
    colaborador_id: row.colaborador_id == null ? null : Number(row.colaborador_id),
  };
}

export async function create(input: CreateAgendaBloqueioInput): Promise<AgendaBloqueioRow> {
  const r = await query<AgendaBloqueioRaw>(
    `INSERT INTO agenda_bloqueios (
       id, tenant_id, slot, colaborador_id, serie_id, gcal_event_id, inicio_at, fim_at, timezone, tipo, motivo,
       status, created_by_role, created_by_user_id, created_by_colaborador_id
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'creating',$12,$13,$14)
     RETURNING *`,
    [
      input.id,
      input.tenantId,
      input.slot,
      input.colaboradorId,
      input.serieId ?? null,
      input.gcalEventId,
      input.inicioAt,
      input.fimAt,
      input.timezone,
      input.tipo,
      input.motivo ?? null,
      input.createdByRole,
      input.createdByUserId ?? null,
      input.createdByColaboradorId ?? null,
    ],
  );
  return mapRow(r.rows[0]);
}

export async function attachGcalEventId(
  tenantId: string,
  slot: string,
  id: string,
  gcalEventId: string,
): Promise<AgendaBloqueioRow | null> {
  const r = await query<AgendaBloqueioRaw>(
    `UPDATE agenda_bloqueios
        SET gcal_event_id = $4,
            status = 'active',
            updated_at = now()
      WHERE tenant_id = $1
        AND slot = $2
        AND id = $3
        AND deleted_at IS NULL
      RETURNING *`,
    [tenantId, slot, id, gcalEventId],
  );
  return r.rows[0] ? mapRow(r.rows[0]) : null;
}

/** Anexa somente enquanto a tentativa cercada ainda é dona da ocorrência. */
export async function attachGcalEventIdForDispatch(input: {
  tenantId: string;
  slot: string;
  bloqueioId: string;
  gcalEventId: string;
  operationId: string;
  ordinal: number;
  attemptVersion: number;
}): Promise<AgendaBloqueioRow | null> {
  const r = await query<AgendaBloqueioRaw>(
    `UPDATE agenda_bloqueios b
        SET gcal_event_id=$4, status='active', updated_at=now()
       FROM agenda_bloqueio_operacao_ocorrencias o
       JOIN agenda_bloqueio_operacoes op ON op.id=o.operation_id
      WHERE b.tenant_id=$1 AND b.slot=$2 AND b.id=$3 AND b.deleted_at IS NULL
        AND o.operation_id=$5 AND o.ordinal=$6 AND o.bloqueio_id=b.id
        AND o.status='gcal_dispatch_started' AND o.attempt_version=$7
        AND op.tenant_id=$1 AND op.slot=$2
      RETURNING b.*`,
    [
      input.tenantId,
      input.slot,
      input.bloqueioId,
      input.gcalEventId,
      input.operationId,
      input.ordinal,
      input.attemptVersion,
    ],
  );
  return r.rows[0] ? mapRow(r.rows[0]) : null;
}

/** Leitura interna de recuperação: inclui linhas `creating` ainda sem efeito GCal confirmado. */
export async function getByIdForRecovery(
  tenantId: string,
  slot: string,
  id: string,
): Promise<AgendaBloqueioRow | null> {
  const r = await query<AgendaBloqueioRaw>(
    `SELECT * FROM agenda_bloqueios
      WHERE tenant_id=$1 AND slot=$2 AND id=$3
      LIMIT 1`,
    [tenantId, slot, id],
  );
  return r.rows[0] ? mapRow(r.rows[0]) : null;
}

export async function markCreateFailed(tenantId: string, slot: string, id: string): Promise<void> {
  await query(
    `UPDATE agenda_bloqueios
        SET status = 'gcal_failed',
            deleted_at = COALESCE(deleted_at, now()),
            updated_at = now()
      WHERE tenant_id = $1
        AND slot = $2
        AND id = $3
        AND deleted_at IS NULL`,
    [tenantId, slot, id],
  );
}

export async function markCreateCleanupFailed(
  tenantId: string,
  slot: string,
  id: string,
): Promise<void> {
  await query(
    `UPDATE agenda_bloqueios
        SET status = 'gcal_cleanup_failed',
            updated_at = now()
      WHERE tenant_id = $1
        AND slot = $2
        AND id = $3
        AND deleted_at IS NULL`,
    [tenantId, slot, id],
  );
}

export async function list(input: ListAgendaBloqueiosInput): Promise<AgendaBloqueioRow[]> {
  const args: unknown[] = [input.tenantId, input.slot];
  const where = [
    'tenant_id = $1',
    'slot = $2',
    "status IN ('active', 'gcal_cleanup_failed')",
    'deleted_at IS NULL',
  ];
  if (input.colaboradorId !== undefined) {
    args.push(input.colaboradorId);
    where.push(
      input.colaboradorId === null ? 'colaborador_id IS NULL' : `colaborador_id = $${args.length}`,
    );
  }
  if (input.serieId !== undefined) {
    args.push(input.serieId);
    where.push(input.serieId === null ? 'serie_id IS NULL' : `serie_id = $${args.length}`);
  }
  if (input.inicioAt) {
    args.push(input.inicioAt);
    where.push(`fim_at > $${args.length}`);
  }
  if (input.fimAt) {
    args.push(input.fimAt);
    where.push(`inicio_at < $${args.length}`);
  }

  const r = await query<AgendaBloqueioRaw>(
    `SELECT *
       FROM agenda_bloqueios
      WHERE ${where.join(' AND ')}
      ORDER BY inicio_at ASC, created_at ASC`,
    args,
  );
  return r.rows.map(mapRow);
}

export async function listFutureActiveBySerieId(input: {
  tenantId: string;
  slot: string;
  serieId: string;
  colaboradorId?: number | null;
}): Promise<AgendaBloqueioRow[]> {
  const args: unknown[] = [input.tenantId, input.slot, input.serieId];
  const where = [
    'tenant_id = $1',
    'slot = $2',
    'serie_id = $3',
    "status IN ('active', 'gcal_cleanup_failed')",
    'deleted_at IS NULL',
    'inicio_at > now()',
  ];
  if (input.colaboradorId !== undefined) {
    if (input.colaboradorId === null) {
      where.push('colaborador_id IS NULL');
    } else {
      args.push(input.colaboradorId);
      where.push(`colaborador_id = $${args.length}`);
    }
  }
  const r = await query<AgendaBloqueioRaw>(
    `SELECT *
       FROM agenda_bloqueios
      WHERE ${where.join(' AND ')}
      ORDER BY inicio_at ASC, created_at ASC`,
    args,
  );
  return r.rows.map(mapRow);
}

/**
 * Séries anteriores à operação durável não possuem plano/event_id canônico para
 * recovery. Esta consulta serve para recusá-las de forma explícita e escopada.
 */
export async function hasSerieForRecovery(input: {
  tenantId: string;
  slot: string;
  serieId: string;
  colaboradorId: number | null;
}): Promise<boolean> {
  const r = await query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM agenda_bloqueios
        WHERE tenant_id=$1 AND slot=$2 AND serie_id=$3
          AND colaborador_id IS NOT DISTINCT FROM $4
          AND deleted_at IS NULL
     ) AS exists`,
    [input.tenantId, input.slot, input.serieId, input.colaboradorId],
  );
  return r.rows[0]?.exists ?? false;
}

/**
 * Retry de POST pré-ADR não possui chave de replay própria. A primeira
 * ocorrência canônica permite detectar a série legada já materializada e
 * falhar fechada, em vez de iniciar uma operação durável paralela.
 */
export async function hasLegacySerieMatchingCreate(input: {
  tenantId: string;
  slot: string;
  colaboradorId: number | null;
  inicioAt: string;
  fimAt: string;
  tipo: AgendaBloqueioTipo;
  motivo: string | null;
}): Promise<boolean> {
  const r = await query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM agenda_bloqueios
        WHERE tenant_id=$1 AND slot=$2
          AND colaborador_id IS NOT DISTINCT FROM $3
          AND inicio_at=$4 AND fim_at=$5 AND tipo=$6
          AND motivo IS NOT DISTINCT FROM $7
          AND serie_id IS NOT NULL AND deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM agenda_bloqueio_operacoes op
             WHERE op.id=agenda_bloqueios.serie_id
               AND op.tenant_id=agenda_bloqueios.tenant_id
               AND op.slot=agenda_bloqueios.slot
          )
     ) AS exists`,
    [
      input.tenantId,
      input.slot,
      input.colaboradorId,
      input.inicioAt,
      input.fimAt,
      input.tipo,
      input.motivo,
    ],
  );
  return r.rows[0]?.exists ?? false;
}

export async function getActiveById(
  tenantId: string,
  slot: string,
  id: string,
  colaboradorId?: number | null,
): Promise<AgendaBloqueioRow | null> {
  const args: unknown[] = [tenantId, slot, id];
  const where = [
    'tenant_id = $1',
    'slot = $2',
    'id = $3',
    "status IN ('active', 'gcal_cleanup_failed')",
    'deleted_at IS NULL',
  ];
  if (colaboradorId !== undefined) {
    if (colaboradorId === null) {
      where.push('colaborador_id IS NULL');
    } else {
      args.push(colaboradorId);
      where.push(`colaborador_id = $${args.length}`);
    }
  }
  const r = await query<AgendaBloqueioRaw>(
    `SELECT * FROM agenda_bloqueios WHERE ${where.join(' AND ')} LIMIT 1`,
    args,
  );
  return r.rows[0] ? mapRow(r.rows[0]) : null;
}

export async function softDeleteById(
  tenantId: string,
  slot: string,
  id: string,
  colaboradorId?: number | null,
): Promise<AgendaBloqueioRow | null> {
  const args: unknown[] = [tenantId, slot, id];
  const where = [
    'tenant_id = $1',
    'slot = $2',
    'id = $3',
    "status IN ('active', 'gcal_cleanup_failed')",
    'deleted_at IS NULL',
  ];
  if (colaboradorId !== undefined) {
    if (colaboradorId === null) {
      where.push('colaborador_id IS NULL');
    } else {
      args.push(colaboradorId);
      where.push(`colaborador_id = $${args.length}`);
    }
  }
  const r = await query<AgendaBloqueioRaw>(
    `UPDATE agenda_bloqueios
        SET status = 'deleted',
            deleted_at = now(),
            updated_at = now()
      WHERE ${where.join(' AND ')}
      RETURNING *`,
    args,
  );
  return r.rows[0] ? mapRow(r.rows[0]) : null;
}
