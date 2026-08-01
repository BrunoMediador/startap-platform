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

/** Comentário-marcador do snapshot que o script de migração grava — usado no --revert pra
 *  localizar o bot_prompt baked ANTES da migração (SCRUM-92 inc.2 / ADR 0032). */
export const CARTAO_MIGRATION_SNAPSHOT_COMMENT = 'cartao-runtime-migration';

export interface ApplyGeneratedPromptOptions {
  /** Quando 'runtime', seta flow_clones.cartao_mode='runtime' na MESMA transação (approve do
   *  builder com CARTAO_RUNTIME_ENABLED ON — a persona nasce SEM cartão baked). 'baked'/ausente
   *  = comportamento atual (não toca cartao_mode). */
  cartaoMode?: 'baked' | 'runtime';
  /** INVARIANTE anti-cartão-duplo (arquiteto): quando cartaoMode='runtime', o finalPrompt NÃO
   *  pode conter este marcador (o cartão baked). Se contiver, a transação aborta (throw) — um
   *  clone runtime jamais carrega o cartão nos dois lugares. O caller passa o
   *  BLOCO_ESTRUTURAL_MARKER (packages/db não importa de integrations → evita ciclo). */
  bakedMarker?: string;
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
  opts: ApplyGeneratedPromptOptions = {},
): Promise<ApplyGeneratedPromptResult> {
  if (typeof finalPrompt !== 'string' || finalPrompt.trim().length === 0) {
    throw new Error('applyGeneratedPrompt: finalPrompt vazio');
  }
  // INVARIANTE anti-cartão-duplo (arquiteto): um clone que vira 'runtime' NÃO pode ter o cartão
  // baked no bot_prompt (senão o runtime injeta um 2º). Falha ANTES de abrir a transação.
  if (opts.cartaoMode === 'runtime' && opts.bakedMarker && finalPrompt.includes(opts.bakedMarker)) {
    throw new Error(
      'applyGeneratedPrompt: cartaoMode=runtime exige finalPrompt SEM cartão baked (bakedMarker presente)',
    );
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
    // Cartão em runtime (SCRUM-92 inc.2): seta cartao_mode='runtime' na MESMA transação quando
    // pedido (approve com a flag ON). NÃO mexe em cartao_config aqui (persona do builder é fresca
    // → o cartão é montado por template/emojis default; sem verbatim). Um único UPDATE.
    if (opts.cartaoMode === 'runtime') {
      // BELT GUARD (SCRUM-143, defesa em profundidade — qa): antes deste era um flip
      // INCONDICIONAL, 100% dependente do guard da ROTA (isCartaoRuntimeFlipBlocked, que lê
      // fail-open e num erro transitório de DB deixava passar). Aqui, DENTRO da transação e com
      // FOR UPDATE (contra corrida), confirmamos no BANCO que o clone NÃO é uma persona à mão
      // AINDA baked: se for (prompt_custom=true E cartao_mode != 'runtime'), o flip introduziria
      // cartão-duplo (o caso Ingrid) → ABORTA (ROLLBACK). Espelha isCartaoRuntimeFlipBlocked no
      // data layer. Clone template (prompt_custom=false), já-runtime, ou matriz (sem linha) passam.
      const st = await client.query<{
        prompt_custom: boolean | null;
        cartao_mode: string | null;
      }>('SELECT prompt_custom, cartao_mode FROM flow_clones WHERE slot = $1 FOR UPDATE', [slot]);
      const flowState = st.rows[0];
      if (flowState && flowState.prompt_custom === true && flowState.cartao_mode !== 'runtime') {
        throw new Error(
          'applyGeneratedPrompt: bloqueado — prompt_custom=true baked não pode flipar pra cartao_mode=runtime (SCRUM-143 belt guard)',
        );
      }
      await client.query(
        "UPDATE flow_clones SET prompt_custom = true, cartao_mode = 'runtime' WHERE slot = $1",
        [slot],
      );
    } else {
      await client.query('UPDATE flow_clones SET prompt_custom = true WHERE slot = $1', [slot]);
    }

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

export interface MigrateCartaoRuntimeInput {
  slot: string;
  /** bot_prompt SEM o cartão (persona-only) — o cartão sai daqui e passa a ser injetado. */
  personaOnlyPrompt: string;
  /** JSONB do cartao_config a gravar (tipicamente { verbatim, emojis } capturados). */
  cartaoConfig: unknown;
  editedBy: string;
}

export type MigrateCartaoRuntimeResult =
  | { migrated: true; versionSaved: number | null }
  | { migrated: false; skipped: 'prompt_custom' | 'sem_clone' | 'sem_prompt' };

/**
 * Migra UM clone pra cartao_mode='runtime' preservando o cartão VERBATIM (script
 * migrate-cartao-runtime E flip-on-customize do portal — SCRUM-92 inc.2 / ADR 0032, refinamento
 * Bruno 23/07). Transacional:
 *   1. GUARD prompt_custom: clone com persona custom à mão (ex.: Ingrid 🌻) NUNCA vira runtime →
 *      { migrated:false, skipped:'prompt_custom' } (fica baked; invariante do arquiteto);
 *   2. snapshot do bot_prompt ATUAL em bot_prompt_versions (comment marcador → base do --revert);
 *   3. bot_prompt = persona-only (cartão removido);
 *   4. flow_clones.cartao_mode='runtime' + cartao_config = capturado + prompt_custom=TRUE.
 * ARMA prompt_custom=true (decisão do arquiteto 23/07): um clone runtime é persona-only + cartão
 * escolhido = semanticamente um prompt CUSTOM. Sem a flag, o guard de updateClone (flow-clones
 * SCRUM-59, re-renderiza da matriz quando !prompt_custom) reintroduziria o cartão baked no
 * bot_prompt → CARTÃO-DUPLO com o injetado em runtime. O --revert restaura prompt_custom=false
 * (valor pré-flip dos baked/template). Idempotente por natureza do dado (re-rodar num clone já
 * runtime só re-snapshota/re-grava o mesmo estado).
 */
export async function migrateCloneToCartaoRuntime(
  input: MigrateCartaoRuntimeInput,
): Promise<MigrateCartaoRuntimeResult> {
  const { slot, personaOnlyPrompt, cartaoConfig, editedBy } = input;
  if (typeof personaOnlyPrompt !== 'string' || personaOnlyPrompt.trim().length === 0) {
    throw new Error('migrateCloneToCartaoRuntime: personaOnlyPrompt vazio');
  }
  // GUARD anti-cartão-duplo (defesa em profundidade — espelha o bakedMarker de applyGeneratedPrompt).
  // Se o cartão capturado (verbatim) AINDA está na persona-only, a separação persona↔cartão falhou:
  // em runtime o clone teria o cartão baked no bot_prompt E o injetado por cima = DOIS cartões.
  // Aborta ANTES de tocar o banco (input inválido), nunca grava um estado inconsistente. O caller
  // confiável (endpoint via isCartaoFlipSafe, script via classify) nunca chega aqui com isso.
  const verbatim = (cartaoConfig as { verbatim?: unknown } | null | undefined)?.verbatim;
  if (
    typeof verbatim === 'string' &&
    verbatim.trim() !== '' &&
    personaOnlyPrompt.includes(verbatim)
  ) {
    throw new Error(
      'migrateCloneToCartaoRuntime: persona-only ainda contém o cartão (verbatim) — separação inválida, aborta',
    );
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const clone = await client.query<{ prompt_custom: boolean | null }>(
      'SELECT prompt_custom FROM flow_clones WHERE slot = $1 FOR UPDATE',
      [slot],
    );
    if (clone.rows.length === 0) {
      await client.query('ROLLBACK');
      return { migrated: false, skipped: 'sem_clone' };
    }
    if (clone.rows[0].prompt_custom === true) {
      await client.query('ROLLBACK');
      return { migrated: false, skipped: 'prompt_custom' };
    }
    const cur = await client.query<{ prompt: string }>(
      'SELECT prompt FROM bot_prompt WHERE slot = $1',
      [slot],
    );
    if (cur.rows.length === 0) {
      await client.query('ROLLBACK');
      return { migrated: false, skipped: 'sem_prompt' };
    }
    // Snapshot do baked ATUAL (base do --revert). ON CONFLICT trata corrida de version.
    let versionSaved: number | null = null;
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
      [slot, nextVersion, cur.rows[0].prompt, editedBy, CARTAO_MIGRATION_SNAPSHOT_COMMENT],
    );
    if (insRes.rowCount && insRes.rowCount > 0) versionSaved = insRes.rows[0].version;

    await client.query('UPDATE bot_prompt SET prompt = $2, updated_at = NOW() WHERE slot = $1', [
      slot,
      personaOnlyPrompt,
    ]);
    // prompt_custom=TRUE junto (arquiteto 23/07): protege a persona-only do clobber do re-render
    // da matriz (updateClone), que reintroduziria o cartão baked → cartão-duplo. O --revert desarma.
    await client.query(
      "UPDATE flow_clones SET cartao_mode = 'runtime', cartao_config = $2::jsonb, prompt_custom = true, updated_at = NOW() WHERE slot = $1",
      [slot, cartaoConfig === null ? null : JSON.stringify(cartaoConfig)],
    );
    await client.query('COMMIT');
    cache.delete(slot);
    return { migrated: true, versionSaved };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Comentário-marcador do snapshot que o script migrate-faq-para-prompt grava — usado como
 *  base de rollback manual (restaurar de bot_prompt_versions filtrando por este comment). */
export const FAQ_MIGRATION_SNAPSHOT_COMMENT = 'faq-para-prompt-migration';

export interface MigrateFaqToPromptInput {
  slot: string;
  /** Bloco FAQ pronto (header + pares P:/R:) — já sanitizado/capado pelo caller
   *  (narrowFaqPairs), byte-a-byte igual ao que renderFaqBlock produziria em runtime. */
  faqBlock: string;
  editedBy: string;
}

export type MigrateFaqToPromptResult =
  | { migrated: true; versionSaved: number | null; newPrompt: string }
  | { migrated: false; skipped: 'sem_clone' | 'sem_prompt' | 'ja_migrado' | 'faq_vazio' };

/**
 * Migra o FAQ personalizado (JSONB) de UM clone pra dentro do bot_prompt (script
 * migrate-faq-para-prompt, ETAPA 1 do plano aprovado 31/07). Transacional, espelhando
 * migrateCloneToCartaoRuntime:
 *   1. GUARD IDEMPOTENTE: se o bot_prompt JÁ contém o header do bloco FAQ, aborta sem gravar
 *      (migrado:false, skipped:'ja_migrado') — nunca duplica o bloco numa 2ª execução;
 *   2. snapshot do bot_prompt ATUAL em bot_prompt_versions (comment marcador → base de rollback
 *      manual, mesma receita do cartão-runtime);
 *   3. bot_prompt = prompt atual + '\n\n' + faqBlock (anexado ao FIM, nunca no meio);
 *   4. personalizacao = personalizacao - 'faq_personalizado' NA MESMA transação — sem isso o
 *      bot receberia o FAQ DUAS vezes (prompt migrado + renderFaqBlock ainda injetando em
 *      runtime). Removendo a chave, renderFaqBlock volta a retornar '' naturalmente (a função
 *      de runtime não precisa ser tocada).
 * Idempotente: re-rodar num clone já migrado não altera nada (guard do passo 1).
 */
export async function migrateCloneFaqToBotPrompt(
  input: MigrateFaqToPromptInput,
): Promise<MigrateFaqToPromptResult> {
  const { slot, faqBlock, editedBy } = input;
  if (typeof faqBlock !== 'string' || faqBlock.trim().length === 0) {
    return { migrated: false, skipped: 'faq_vazio' };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const clone = await client.query<{ slot: string }>(
      'SELECT slot FROM flow_clones WHERE slot = $1 FOR UPDATE',
      [slot],
    );
    if (clone.rows.length === 0) {
      await client.query('ROLLBACK');
      return { migrated: false, skipped: 'sem_clone' };
    }
    const cur = await client.query<{ prompt: string }>(
      'SELECT prompt FROM bot_prompt WHERE slot = $1',
      [slot],
    );
    if (cur.rows.length === 0 || !cur.rows[0].prompt) {
      await client.query('ROLLBACK');
      return { migrated: false, skipped: 'sem_prompt' };
    }
    const currentPrompt = cur.rows[0].prompt;
    // GUARD IDEMPOTENTE (espelha o guard anti-cartão-duplo de migrateCloneToCartaoRuntime):
    // se o header do bloco FAQ já está no prompt, uma 2ª execução é NO-OP — nunca duplica.
    const headerFirstLine = faqBlock.split('\n')[0];
    if (currentPrompt.includes(headerFirstLine)) {
      await client.query('ROLLBACK');
      return { migrated: false, skipped: 'ja_migrado' };
    }
    const newPrompt = `${currentPrompt}\n\n${faqBlock}`;

    // Snapshot do prompt ATUAL (ANTES do update) — base de rollback manual.
    let versionSaved: number | null = null;
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
      [slot, nextVersion, currentPrompt, editedBy, FAQ_MIGRATION_SNAPSHOT_COMMENT],
    );
    if (insRes.rowCount && insRes.rowCount > 0) versionSaved = insRes.rows[0].version;

    await client.query('UPDATE bot_prompt SET prompt = $2, updated_at = NOW() WHERE slot = $1', [
      slot,
      newPrompt,
    ]);
    // Anti-duplicação (passo 7 do plano): remove a chave do JSONB NA MESMA transação —
    // renderFaqBlock(personalizacao) volta a retornar '' naturalmente (chave ausente),
    // sem precisar tocar o código de runtime.
    await client.query(
      "UPDATE flow_clones SET personalizacao = personalizacao - 'faq_personalizado', updated_at = NOW() WHERE slot = $1",
      [slot],
    );
    await client.query('COMMIT');
    cache.delete(slot);
    return { migrated: true, versionSaved, newPrompt };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export type RevertCartaoRuntimeResult =
  | { reverted: true; restoredVersion: number }
  | { reverted: false; skipped: 'sem_snapshot' | 'sem_clone' };

/**
 * Reverte a migração de UM clone (script --revert): restaura o bot_prompt baked do snapshot
 * mais recente marcado como migração + volta cartao_mode='baked' + limpa cartao_config +
 * desarma prompt_custom=FALSE (valor pré-flip dos clones baked/template — o flip armou true).
 * Revert LIMPO: o clone volta ao estado EXATO de antes (baked + cartão original + template-tracking).
 * Transacional. Sem snapshot marcado → { reverted:false } (nada a fazer, seguro). SCRUM-92 inc.2.
 */
export async function revertCloneCartaoRuntime(slot: string): Promise<RevertCartaoRuntimeResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const clone = await client.query<{ slot: string }>(
      'SELECT slot FROM flow_clones WHERE slot = $1 FOR UPDATE',
      [slot],
    );
    if (clone.rows.length === 0) {
      await client.query('ROLLBACK');
      return { reverted: false, skipped: 'sem_clone' };
    }
    const snap = await client.query<{ version: number; prompt: string }>(
      `SELECT version, prompt FROM bot_prompt_versions
        WHERE slot = $1 AND comment = $2
        ORDER BY version DESC LIMIT 1`,
      [slot, CARTAO_MIGRATION_SNAPSHOT_COMMENT],
    );
    if (snap.rows.length === 0) {
      await client.query('ROLLBACK');
      return { reverted: false, skipped: 'sem_snapshot' };
    }
    await client.query('UPDATE bot_prompt SET prompt = $2, updated_at = NOW() WHERE slot = $1', [
      slot,
      snap.rows[0].prompt,
    ]);
    // Desarma prompt_custom=false junto (arquiteto 23/07): o flip armou true; o revert volta ao
    // valor pré-flip (baked/template = false) pra o clone ficar idêntico ao estado de antes.
    await client.query(
      "UPDATE flow_clones SET cartao_mode = 'baked', cartao_config = NULL, prompt_custom = false, updated_at = NOW() WHERE slot = $1",
      [slot],
    );
    await client.query('COMMIT');
    cache.delete(slot);
    return { reverted: true, restoredVersion: snap.rows[0].version };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
