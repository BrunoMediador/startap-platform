import { query } from '../client.js';

export type FlowLogStatus = 'running' | 'success' | 'error' | 'ignored';

export interface FlowExecutionLogInput {
  executionId: string;
  flowId?: string | null;
  flowName?: string | null;
  bot?: string | null;
  telefone?: string | null;
  telefoneMasked?: string | null;
  session?: string | null;
  eventType: string;
  status: FlowLogStatus;
  message: string;
  metadata?: Record<string, unknown> | null;
  durationMs?: number | null;
  error?: unknown;
  errorSummary?: string | null;
}

export interface FlowExecutionLogRow {
  id: number;
  execution_id: string;
  flow_id: string | null;
  flow_name: string | null;
  bot: string | null;
  telefone_masked: string | null;
  session: string | null;
  event_type: string;
  status: FlowLogStatus;
  message: string;
  metadata: Record<string, unknown>;
  duration_ms: number | null;
  error_summary: string | null;
  created_at: Date;
}

export function maskPhone(telefone?: string | null): string | null {
  const digits = String(telefone ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length <= 8) return `${digits.slice(0, 2)}****${digits.slice(-2)}`;
  return `${digits.slice(0, 4)}****${digits.slice(-4)}`;
}

export function summarizeError(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof Error) return truncate(error.message || error.name, 500);
  if (typeof error === 'string') return truncate(error, 500);
  return truncate(JSON.stringify(sanitizeMetadata({ error })).slice(0, 500), 500);
}

export async function logFlowEvent(
  input: FlowExecutionLogInput,
): Promise<FlowExecutionLogRow | null> {
  try {
    const metadata = sanitizeMetadata(input.metadata ?? {});
    const errorSummary = input.errorSummary ?? summarizeError(input.error);
    const r = await query<FlowExecutionLogRow & { id: string }>(
      `INSERT INTO flow_execution_logs
         (execution_id, flow_id, flow_name, bot, telefone_masked, session, event_type,
          status, message, metadata, duration_ms, error_summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id::text, execution_id::text, flow_id, flow_name, bot, telefone_masked,
         session, event_type, status, message, metadata, duration_ms, error_summary, created_at`,
      [
        input.executionId,
        input.flowId ?? null,
        input.flowName ?? null,
        input.bot ?? null,
        input.telefoneMasked ?? maskPhone(input.telefone),
        input.session ?? null,
        input.eventType,
        input.status,
        truncate(input.message, 1000),
        JSON.stringify(metadata),
        input.durationMs ?? null,
        errorSummary,
      ],
    );
    const row = normalizeRow(r.rows[0]);
    await query('SELECT pg_notify($1, $2)', ['flow_execution_logs', JSON.stringify(row)]).catch(
      () => {},
    );
    return row;
  } catch {
    return null;
  }
}

export async function listFlowEvents(input: {
  limit?: number;
  status?: FlowLogStatus | null;
  flowId?: string | null;
  q?: string | null;
}): Promise<FlowExecutionLogRow[]> {
  const limit = Math.max(1, Math.min(500, input.limit ?? 100));
  const where: string[] = [];
  const vals: unknown[] = [];
  let i = 1;

  if (input.status) {
    where.push(`status = $${i++}`);
    vals.push(input.status);
  }
  if (input.flowId) {
    where.push(`flow_id = $${i++}`);
    vals.push(input.flowId);
  }
  if (input.q) {
    where.push(`(telefone_masked ILIKE $${i} OR message ILIKE $${i} OR flow_name ILIKE $${i})`);
    vals.push(`%${input.q}%`);
    i++;
  }

  vals.push(limit);
  const r = await query<FlowExecutionLogRow & { id: string }>(
    `SELECT id::text, execution_id::text, flow_id, flow_name, bot, telefone_masked, session,
            event_type, status, message, metadata, duration_ms, error_summary, created_at
     FROM flow_execution_logs
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY id DESC
     LIMIT $${i}`,
    vals,
  );
  return r.rows.map(normalizeRow);
}

export async function pruneOldFlowEvents(daysToKeep = 14): Promise<number> {
  const days = Math.max(1, Math.min(365, daysToKeep));
  const r = await query(
    `DELETE FROM flow_execution_logs
     WHERE created_at < NOW() - ($1 || ' days')::INTERVAL`,
    [String(days)],
  );
  return r.rowCount ?? 0;
}

function normalizeRow(row: FlowExecutionLogRow & { id: string }): FlowExecutionLogRow {
  return {
    ...row,
    id: Number(row.id),
    metadata: row.metadata ?? {},
  };
}

function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[max-depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncate(value, 500);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value))
    return value.slice(0, 20).map((item) => sanitizeMetadata(item, depth + 1));
  if (typeof value !== 'object') return String(value);

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = sanitizeMetadata(raw, depth + 1);
  }
  return out;
}

function isSensitiveKey(key: string): boolean {
  return /token|secret|password|pass|api[-_]?key|authorization|cookie|prompt|body|payload|raw/i.test(
    key,
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
