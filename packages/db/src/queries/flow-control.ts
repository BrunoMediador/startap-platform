import { query } from '../client.js';

export interface FlowControlRow {
  flow_id: string;
  flow_name: string;
  source: string;
  active: boolean;
  updated_at: Date;
}

const CACHE_TTL_MS = 60_000;
const activeCache = new Map<string, { value: boolean; expiresAt: number }>();

export async function isFlowActive(flowId: string): Promise<boolean> {
  const cached = activeCache.get(flowId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const r = await query<Pick<FlowControlRow, 'active'>>(
      'SELECT active FROM flow_controls WHERE flow_id = $1',
      [flowId],
    );
    const value = r.rows[0]?.active ?? true;
    activeCache.set(flowId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (e) {
    if (isUndefinedTableError(e)) return true;
    throw e;
  }
}

export function invalidateFlowControlCache(flowId?: string): void {
  if (flowId) activeCache.delete(flowId);
  else activeCache.clear();
}

export async function setFlowActive(input: {
  flowId: string;
  flowName: string;
  source: string;
  active: boolean;
}): Promise<FlowControlRow> {
  const r = await query<FlowControlRow>(
    `INSERT INTO flow_controls (flow_id, flow_name, source, active, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (flow_id) DO UPDATE SET
       flow_name = EXCLUDED.flow_name,
       source = EXCLUDED.source,
       active = EXCLUDED.active,
       updated_at = NOW()
     RETURNING flow_id, flow_name, source, active, updated_at`,
    [input.flowId, input.flowName, input.source, input.active],
  );
  invalidateFlowControlCache(input.flowId);
  return r.rows[0];
}

function isUndefinedTableError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '42P01';
}
