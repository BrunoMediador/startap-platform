import { pool, query } from '../client.js';

/**
 * bot_prompt — prompts editáveis por slot, salvos no banco.
 *
 * Bots lêem o prompt no startup + cache de 30s.
 * Painel atualiza o prompt via PUT /api/bots/:slot/prompt.
 */

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { prompt: string; expiresAt: number }>();

export async function getPrompt(slot: string): Promise<string | null> {
  const cached = cache.get(slot);
  if (cached && cached.expiresAt > Date.now()) return cached.prompt;

  const r = await query<{ prompt: string }>('SELECT prompt FROM bot_prompt WHERE slot = $1', [
    slot,
  ]);
  const prompt = r.rows[0]?.prompt ?? null;
  if (prompt !== null) {
    cache.set(slot, { prompt, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return prompt;
}

export async function setPrompt(slot: string, prompt: string): Promise<void> {
  // Dual-write tenant_id (ADR 0018, Fase 2). Subselect inline em flow_clones:
  // atômico e resolve NULL sozinho quando o slot não tem clone (matriz/plataforma)
  // — nunca derruba o INSERT. Caminho não-quente (painel/provisioning).
  // O slot do subselect é um parâmetro SEPARADO ($3) — não reusa $1. Reusar o
  // mesmo placeholder em dois contextos de tipo (bot_prompt.slot varchar(50) vs
  // flow_clones.slot varchar(80)) faz o Postgres lançar "inconsistent types
  // deduced for parameter $1" e a query falha.
  await query(
    `INSERT INTO bot_prompt (slot, prompt, updated_at, tenant_id)
     VALUES ($1, $2, NOW(), (SELECT tenant_id FROM flow_clones WHERE slot = $3))
     ON CONFLICT (slot) DO UPDATE SET prompt = EXCLUDED.prompt, updated_at = NOW(),
       tenant_id = COALESCE(bot_prompt.tenant_id, EXCLUDED.tenant_id)`,
    [slot, prompt, slot],
  );
  cache.delete(slot);
}

export function invalidatePromptCache(slot?: string): void {
  if (slot) cache.delete(slot);
  else cache.clear();
}

export interface ApplyGeneratedPromptResult {
  slot: string;
  prompt: string;
  updated_at: Date;
  /** versão do snapshot pré-edição gravado em bot_prompt_versions; null se não mudou/colisão. */
  version_saved: number | null;
}

/**
 * applyGeneratedPrompt — persiste o prompt FINAL (persona gerada + bloco estrutural já
 * colado pelo caller) numa transação idêntica à receita SCRUM-83 do gestão (antes inline
 * em painel-admin/server.js linhas ~1267-1340). ÚNICA fonte pra portal-api (builder
 * conversacional, SCRUM-92) E gestão — os dois ficam consistentes.
 *
 * Invariantes (por que transacional):
 *  1. snapshot da cópia ATUAL em bot_prompt_versions (só se de fato mudou; ON CONFLICT
 *     DO NOTHING trata corrida de version) — rollback já existe por cima disso;
 *  2. upsert bot_prompt (dual-write tenant_id, ADR 0018);
 *  3. UPDATE flow_clones.prompt_custom=true → a persona vira "sticky" (guard SCRUM-59/83:
 *     o re-render do perfil NÃO apaga a edição). Slot de MATRIZ (sem linha em flow_clones)
 *     -> UPDATE afeta 0 linhas = no-op, não é erro;
 *  4. COMMIT e SÓ ENTÃO invalidatePromptCache — nunca serve prompt novo antes do commit.
 *
 * O caller (approve) é quem monta finalPrompt = persona + BLOCO_ESTRUTURAL server-side:
 * a garantia da mecânica NÃO mora aqui nem no LLM, mora no servidor.
 */
export async function applyGeneratedPrompt(
  slot: string,
  finalPrompt: string,
  editedBy: string,
  comment = 'prompt-builder',
): Promise<ApplyGeneratedPromptResult> {
  if (typeof finalPrompt !== 'string' || finalPrompt.trim().length === 0) {
    throw new Error('applyGeneratedPrompt: finalPrompt vazio');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Auto-snapshot: grava a versão ATUAL antes de sobrescrever, só se mudou.
    let versionSaved: number | null = null;
    const cur = await client.query<{ prompt: string }>(
      'SELECT prompt FROM bot_prompt WHERE slot = $1',
      [slot],
    );
    if (cur.rows.length && cur.rows[0].prompt !== finalPrompt) {
      const maxRes = await client.query<{ m: string }>(
        'SELECT COALESCE(MAX(version), 0) AS m FROM bot_prompt_versions WHERE slot = $1',
        [slot],
      );
      const nextVersion = Number(maxRes.rows[0].m) + 1;
      const insRes = await client.query<{ version: number }>(
        `INSERT INTO bot_prompt_versions (slot, version, prompt, edited_by, comment)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (slot, version) DO NOTHING
         RETURNING version`,
        [slot, nextVersion, cur.rows[0].prompt, editedBy, comment],
      );
      if (insRes.rowCount && insRes.rowCount > 0) {
        versionSaved = insRes.rows[0].version;
      }
    }

    // Upsert do prompt (dual-write tenant_id via subselect com parâmetro SEPARADO $3 —
    // mesmo cuidado de tipos do setPrompt).
    const r = await client.query<{ slot: string; prompt: string; updated_at: Date }>(
      `INSERT INTO bot_prompt (slot, prompt, updated_at, tenant_id)
       VALUES ($1, $2, NOW(), (SELECT tenant_id FROM flow_clones WHERE slot = $3))
       ON CONFLICT (slot) DO UPDATE SET prompt = EXCLUDED.prompt, updated_at = NOW(),
         tenant_id = COALESCE(bot_prompt.tenant_id, EXCLUDED.tenant_id)
       RETURNING slot, prompt, updated_at`,
      [slot, finalPrompt, slot],
    );

    // Persona custom sticky (migration 070, SCRUM-59/83): protege do re-render.
    await client.query('UPDATE flow_clones SET prompt_custom = true WHERE slot = $1', [slot]);

    await client.query('COMMIT');
    cache.delete(slot);
    return { ...r.rows[0], version_saved: versionSaved };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
