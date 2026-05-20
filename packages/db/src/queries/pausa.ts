import { query } from '../client.js';

/**
 * Tabelas de pausa por projeto, com colunas distintas:
 *   pausa_samuel, pausa_samuel_dev, pausa_cirilo, pause_ricardo, pause_startap → col `numero`
 *   bot_pausa → col `numero_cliente` + flag `pausado` boolean
 *   pausa (legacy) → col `chat_id`
 *
 * Telefone é salvo COM DDI (55...).
 */

interface TableSpec {
  col: string;
  /** Para tabelas com flag booleana de pausa ativo. */
  pausedFlag?: { name: string; value: boolean };
}

export interface FlowPauseInput {
  flowId: string;
  flowName?: string | null;
  telefone: string;
  session?: string | null;
  source?: string | null;
  reason?: string | null;
}

export type FlowPauseCommand = 'pause' | 'resume';

export interface FlowPauseKeywordRow {
  flow_id: string;
  command: FlowPauseCommand;
  keyword: string;
  keyword_norm: string;
  enabled: boolean;
  updated_at: Date;
}

const TABLES: Record<string, TableSpec> = {
  pausa: { col: 'chat_id' },
  pausa_samuel: { col: 'numero' },
  pausa_samuel_dev: { col: 'numero' },
  pausa_cirilo: { col: 'numero' },
  pause_ricardo: { col: 'numero' },
  pause_startap: { col: 'numero' },
  bot_pausa: { col: 'numero_cliente', pausedFlag: { name: 'pausado', value: true } },
};

function getSpec(table: string): TableSpec {
  const spec = TABLES[table];
  if (!spec) throw new Error(`Tabela de pausa não permitida: ${table}`);
  return spec;
}

export async function isPaused(table: string, telefone: string): Promise<boolean> {
  const { col, pausedFlag } = getSpec(table);
  const where = pausedFlag
    ? `${col} = $1 AND ${pausedFlag.name} = ${pausedFlag.value}`
    : `${col} = $1`;
  const r = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table} WHERE ${where}`,
    [telefone],
  );
  return Number(r.rows[0]?.count ?? 0) > 0;
}

export async function addPause(table: string, telefone: string): Promise<void> {
  const { col, pausedFlag } = getSpec(table);
  if (pausedFlag) {
    await query(
      `INSERT INTO ${table} (${col}, ${pausedFlag.name}) VALUES ($1, ${pausedFlag.value})
       ON CONFLICT (${col}) DO UPDATE SET ${pausedFlag.name} = ${pausedFlag.value}`,
      [telefone],
    );
  } else {
    await query(`INSERT INTO ${table} (${col}) VALUES ($1) ON CONFLICT DO NOTHING`, [telefone]);
  }
}

export async function removePause(table: string, telefone: string): Promise<void> {
  const { col, pausedFlag } = getSpec(table);
  if (pausedFlag) {
    await query(`UPDATE ${table} SET ${pausedFlag.name} = ${!pausedFlag.value} WHERE ${col} = $1`, [
      telefone,
    ]);
  } else {
    await query(`DELETE FROM ${table} WHERE ${col} = $1`, [telefone]);
  }
}

export async function listPauses(table: string): Promise<string[]> {
  const { col, pausedFlag } = getSpec(table);
  const where = pausedFlag ? `WHERE ${pausedFlag.name} = ${pausedFlag.value}` : '';
  const r = await query<{ v: string }>(`SELECT ${col} AS v FROM ${table} ${where} ORDER BY ${col}`);
  return r.rows.map((x) => x.v);
}

export async function isFlowPaused(input: {
  flowId: string;
  telefone: string;
}): Promise<boolean> {
  const r = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM flow_pauses
     WHERE flow_id = $1 AND telefone = $2 AND active = TRUE`,
    [input.flowId, input.telefone],
  );
  return Number(r.rows[0]?.count ?? 0) > 0;
}

export async function addFlowPause(input: FlowPauseInput): Promise<void> {
  await query(
    `INSERT INTO flow_pauses
       (flow_id, flow_name, telefone, session, active, source, reason, updated_at)
     VALUES ($1,$2,$3,$4,TRUE,$5,$6,NOW())
     ON CONFLICT (flow_id, telefone) DO UPDATE SET
       flow_name = COALESCE(EXCLUDED.flow_name, flow_pauses.flow_name),
       session = COALESCE(EXCLUDED.session, flow_pauses.session),
       active = TRUE,
       source = COALESCE(EXCLUDED.source, flow_pauses.source),
       reason = COALESCE(EXCLUDED.reason, flow_pauses.reason),
       updated_at = NOW()`,
    [
      input.flowId,
      input.flowName ?? null,
      input.telefone,
      input.session ?? null,
      input.source ?? 'manual',
      input.reason ?? null,
    ],
  );
}

export async function removeFlowPause(input: {
  flowId: string;
  telefone: string;
  session?: string | null;
  source?: string | null;
}): Promise<void> {
  await query(
    `UPDATE flow_pauses
     SET active = FALSE,
         session = COALESCE($3, session),
         source = COALESCE($4, source),
         updated_at = NOW()
     WHERE flow_id = $1 AND telefone = $2`,
    [input.flowId, input.telefone, input.session ?? null, input.source ?? 'manual'],
  );
}

export async function listFlowPauses(flowId?: string): Promise<
  Array<{
    flow_id: string;
    flow_name: string | null;
    telefone: string;
    session: string | null;
    source: string | null;
    reason: string | null;
    updated_at: Date;
  }>
> {
  const vals: string[] = [];
  const where = flowId ? 'WHERE flow_id = $1 AND active = TRUE' : 'WHERE active = TRUE';
  if (flowId) vals.push(flowId);
  const r = await query<{
    flow_id: string;
    flow_name: string | null;
    telefone: string;
    session: string | null;
    source: string | null;
    reason: string | null;
    updated_at: Date;
  }>(
    `SELECT flow_id, flow_name, telefone, session, source, reason, updated_at
     FROM flow_pauses
     ${where}
     ORDER BY flow_name, telefone`,
    vals,
  );
  return r.rows;
}

/**
 * Resolve session WAHA -> flow_id via bot_config + project_databases.
 * Usa COALESCE(waha_sessao, slot) para cobrir tanto sessões explícitas quanto implícitas.
 * Retorna null se a sessão não tiver projeto associado (log de aviso fica no chamador).
 */
export async function findFlowIdBySession(session: string): Promise<string | null> {
  const r = await query<{ workflow_id: string }>(
    `SELECT pd.workflow_id
     FROM project_databases pd
     JOIN bot_config bc ON bc.slot = pd.slot
     WHERE COALESCE(bc.waha_sessao, bc.slot) = $1
     LIMIT 1`,
    [session],
  );
  return r.rows[0]?.workflow_id ?? null;
}

export async function listFlowPauseKeywords(flowId: string): Promise<FlowPauseKeywordRow[]> {
  const r = await query<FlowPauseKeywordRow>(
    `SELECT flow_id, command, keyword, keyword_norm, enabled, updated_at
     FROM flow_pause_keywords
     WHERE flow_id = $1
     ORDER BY command, keyword`,
    [flowId],
  );
  return r.rows;
}
