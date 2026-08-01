import { pool, query } from '../client.js';

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
  /**
   * Validade da pausa (SCRUM-59). NULL/ausente = pausa PERMANENTE (comportamento de
   * TODAS as pausas de hoje: keyword/escalated_human/portal/antibot). Só a pausa por
   * resposta humana à mão (source='human_reply') seta um futuro; renovar = novo upsert
   * com um `expiresAt` mais adiante.
   */
  expiresAt?: Date | null;
  /**
   * Nome do CONTATO — snapshotado na pausa pra durar (mesmo espírito do
   * `HumanReplyPauseInput.contactName`, ver ali). O caller resolve do store durável
   * contact_names (pushName do INBOUND), NUNCA do pushName de um evento fromMe (que é o
   * nome do DONO, não do contato). Ausente/NULL não toca um contact_name já capturado
   * (COALESCE/NULLIF no upsert) — nunca apaga nome preexistente.
   */
  contactName?: string | null;
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
    // Pausada = ativa E (permanente OU ainda dentro da validade). expires_at no passado
    // (SCRUM-59: TTL da pausa human_reply) => leitura LAZY já "solta" o bot, sem cron.
    `SELECT COUNT(*)::text AS count
     FROM flow_pauses
     WHERE flow_id = $1 AND telefone = $2 AND active = TRUE
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [input.flowId, input.telefone],
  );
  return Number(r.rows[0]?.count ?? 0) > 0;
}

export async function addFlowPause(input: FlowPauseInput): Promise<void> {
  await query(
    // Pausa EXPLÍCITA/permanente (keyword/portal/escalated_human/antibot): expiresAt ausente
    // => NULL. `expires_at = EXCLUDED.expires_at` no upsert ZERA qualquer TTL prévio => a
    // pausa explícita SEMPRE PROMOVE pra permanente (regra "permanente sobe": ex.: dono digita
    // a frase de pausa sobre uma human_reply expirada => vira permanente, sem herdar validade
    // vencida). A pausa TEMPORÁRIA por resposta humana usa addHumanReplyPause (com guarda que
    // NUNCA rebaixa uma permanente). Fora do modo atendente ninguém seta expires_at => byte-
    // idêntico ao comportamento anterior à coluna.
    `INSERT INTO flow_pauses
       (flow_id, flow_name, telefone, session, active, source, reason, expires_at, contact_name, updated_at)
     VALUES ($1,$2,$3,$4,TRUE,$5,$6,$7,$8,NOW())
     ON CONFLICT (flow_id, telefone) DO UPDATE SET
       flow_name = COALESCE(EXCLUDED.flow_name, flow_pauses.flow_name),
       session = COALESCE(EXCLUDED.session, flow_pauses.session),
       active = TRUE,
       source = COALESCE(EXCLUDED.source, flow_pauses.source),
       reason = COALESCE(EXCLUDED.reason, flow_pauses.reason),
       expires_at = EXCLUDED.expires_at,
       contact_name = COALESCE(NULLIF(EXCLUDED.contact_name, ''), flow_pauses.contact_name),
       updated_at = NOW()`,
    [
      input.flowId,
      input.flowName ?? null,
      input.telefone,
      input.session ?? null,
      input.source ?? 'manual',
      input.reason ?? null,
      input.expiresAt ?? null,
      input.contactName ?? null,
    ],
  );
}

export interface HumanReplyPauseInput {
  flowId: string;
  flowName?: string | null;
  telefone: string;
  session?: string | null;
  reason?: string | null;
  /** Fim da pausa temporária (agora + TTL). Obrigatório — human_reply é SEMPRE com validade. */
  expiresAt: Date;
  /**
   * Nome do CONTATO (SCRUM-144) — snapshotado na pausa pra durar. O caller resolve do store
   * durável contact_names (pushName do inbound), NUNCA do pushName do evento fromMe (que é o
   * nome do DONO). Ausente/NULL não toca um contact_name já capturado (COALESCE/NULLIF).
   */
  contactName?: string | null;
}

/**
 * Pausa por RESPOSTA HUMANA à mão (source='human_reply', com TTL) — SCRUM-59/60.
 *
 * Semântica de produto (review security N1): a resposta humana só CRIA ou RENOVA a pausa do
 * PRÓPRIO source 'human_reply'; NUNCA rebaixa uma pausa EXPLÍCITA ativa de outro source
 * (keyword/escalated_human/antibot/portal — todas permanentes, expires_at NULL). Sem isso o
 * dono que digita a frase de pausa e segue respondendo veria o bot VOLTAR sozinho em 60min,
 * contra a copy "digite a frase de retomada e o assistente volta" (a permanente só volta por
 * frase/portal). Regra: permanente pode SUBIR (promoção pra permanente é do addFlowPause da
 * keyword); a TTL NUNCA faz DESCER uma permanente ativa.
 *
 * Implementado no ON CONFLICT ... DO UPDATE ... WHERE: só atualiza (renova/recria como
 * human_reply) se a linha existente NÃO for uma pausa explícita ativa de outro source — i.e.
 * está inativa, OU já é human_reply, OU está expirada. Caso contrário o UPDATE é suprimido pelo
 * WHERE e o INSERT pelo conflito => no-op (a pausa explícita permanente fica intacta).
 */
export async function addHumanReplyPause(input: HumanReplyPauseInput): Promise<void> {
  await query(
    `INSERT INTO flow_pauses
       (flow_id, flow_name, telefone, session, active, source, reason, expires_at, contact_name, updated_at)
     VALUES ($1,$2,$3,$4,TRUE,'human_reply',$5,$6,$7,NOW())
     ON CONFLICT (flow_id, telefone) DO UPDATE SET
       flow_name = COALESCE(EXCLUDED.flow_name, flow_pauses.flow_name),
       session = COALESCE(EXCLUDED.session, flow_pauses.session),
       active = TRUE,
       source = 'human_reply',
       reason = COALESCE(EXCLUDED.reason, flow_pauses.reason),
       expires_at = EXCLUDED.expires_at,
       contact_name = COALESCE(NULLIF(EXCLUDED.contact_name, ''), flow_pauses.contact_name),
       updated_at = NOW()
     WHERE flow_pauses.active = FALSE
        OR flow_pauses.source = 'human_reply'
        OR (flow_pauses.expires_at IS NOT NULL AND flow_pauses.expires_at <= NOW())`,
    [
      input.flowId,
      input.flowName ?? null,
      input.telefone,
      input.session ?? null,
      input.reason ?? null,
      input.expiresAt,
      input.contactName ?? null,
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

export interface FlowPauseKeywordInput {
  command: FlowPauseCommand;
  keyword: string;
  keyword_norm: string;
  enabled: boolean;
}

/**
 * Replace-set das frases de pausa/retomada de UM fluxo (SCRUM-59, PUT /portal/frases-pausa).
 * DELETE de TODAS as frases do `flowId` + INSERT da lista nova, dentro de UMA transação
 * (atômico: nunca deixa o fluxo com metade das frases). O `flowId` é sempre o slot do
 * tenant da sessão (withTenant) — jamais do input do cliente (anti-IDOR na camada da rota).
 * A validação (limite/tamanho/duplicata/substring) roda ANTES, na rota.
 */
export async function replaceFlowPauseKeywords(
  flowId: string,
  rows: FlowPauseKeywordInput[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM flow_pause_keywords WHERE flow_id = $1', [flowId]);
    for (const row of rows) {
      await client.query(
        `INSERT INTO flow_pause_keywords
           (flow_id, command, keyword, keyword_norm, enabled, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (flow_id, command, keyword_norm) DO NOTHING`,
        [flowId, row.command, row.keyword, row.keyword_norm, row.enabled],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Pausas ATIVAS de um fluxo por `source` (ex.: 'bot_detected' — auto-pausa do bot-detect PR-E).
 * Usada pelo job de TTL/auto-resume pra varrer só as pausas que a auto-pausa criou. Escopo por
 * flow_id (fronteira de tenant) + source. Query parametrizada.
 */
export async function listActiveFlowPausesBySource(
  flowId: string,
  source: string,
): Promise<Array<{ telefone: string; session: string | null; updated_at: Date }>> {
  const r = await query<{ telefone: string; session: string | null; updated_at: Date }>(
    `SELECT telefone, session, updated_at
       FROM flow_pauses
      WHERE flow_id = $1 AND source = $2 AND active = TRUE
      ORDER BY updated_at ASC`,
    [flowId, source],
  );
  return r.rows;
}
