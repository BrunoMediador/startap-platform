import { query } from '../client.js';

export interface FlowControlRow {
  flow_id: string;
  flow_name: string;
  source: string;
  active: boolean;
  updated_at: Date;
}

export async function isFlowActive(flowId: string): Promise<boolean> {
  try {
    const r = await query<Pick<FlowControlRow, 'active'>>(
      'SELECT active FROM flow_controls WHERE flow_id = $1',
      [flowId],
    );
    return r.rows[0]?.active ?? true;
  } catch (e) {
    if (isUndefinedTableError(e)) return true;
    throw e;
  }
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
  return r.rows[0];
}

function isUndefinedTableError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '42P01';
}
