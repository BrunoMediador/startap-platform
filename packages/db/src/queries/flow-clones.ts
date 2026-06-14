/**
 * flow-clones — CRUD de clones de fluxos matriz.
 *
 * Um clone herda bot_config/bot_prompt/bot_media de uma matriz, com personalizacao
 * própria e sessão WAHA dedicada. Toda criação ocorre em transação única.
 */
import { pool, query } from '../client.js';
import { invalidateTenantCache } from './tenant.js';

export type CloneStatus = 'rascunho' | 'aguardando_qr' | 'conectado' | 'desconectado' | 'falhou';

export interface HorarioDia {
  abre: string | null; // "HH:MM" ou null se fechado
  fecha: string | null;
  fechado: boolean;
}

export interface HorariosFuncionamento {
  segunda?: HorarioDia;
  terca?: HorarioDia;
  quarta?: HorarioDia;
  quinta?: HorarioDia;
  sexta?: HorarioDia;
  sabado?: HorarioDia;
  domingo?: HorarioDia;
}

export interface ServicoConfig {
  nome: string;
  preco_cents: number;
  duracao_min: number;
}

export interface CloneRow {
  id: number;
  slot: string;
  /**
   * Identidade UUID do tenant (ADR 0018). Âncora canônica; gerado por DEFAULT
   * gen_random_uuid() na criação do clone (migration 045). NOT NULL no banco para
   * flow_clones — opcional no tipo só pra rows de SELECTs que não pedem a coluna
   * (não quebra os normalizeCloneRow existentes). Dual-write Fase 2.
   */
  tenant_id?: string;
  matriz_slot: string;
  display_name: string;
  cliente_nome: string | null;
  cliente_telefone: string | null;
  personalizacao: Record<string, string>;
  waha_sessao: string | null;
  /**
   * Shard do container WAHA da sessão (ADR 0020, migration 047). 0 = shard atual
   * (`automacoes-waha-1`), onde TODAS as sessões vivem hoje. Default 0 no banco;
   * só clientes NOVOS em shards novos no futuro. Lido pelo roteamento por shard
   * apenas com a flag `WAHA_SHARDING` ON (default OFF) — hoje é informativo.
   */
  waha_shard_id: number;
  status: CloneStatus;
  /** false = fluxo suspenso por billing/férias — WAHA permanece conectado */
  flow_enabled: boolean;
  suspended_reason: string | null;
  suspended_at: Date | null;
  horarios_funcionamento: HorariosFuncionamento | null;
  servicos: ServicoConfig[] | null;
  /**
   * Vencimento do billing do slot (LEFT JOIN client_billing). null se nao ha linha
   * de billing. Usado SO pelo gate de silencio por cobranca (ADR 0016) — derivado
   * puro, nunca escrito por este caminho. 'YYYY-MM-DD'.
   */
  next_due_date: string | null;
  /**
   * Valor do billing em centavos (LEFT JOIN client_billing). null/0 = sem cobranca
   * configurada -> o gate de silencio por cobranca NUNCA cala (ADR 0016, guard).
   */
  billing_amount_cents: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface CloneSummary extends CloneRow {
  matriz_display_name: string | null;
}

// ---------------------------------------------------------------------------
// Cache TTL — reduz queries por webhook (hot path: getCloneBySession/BySlot)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;
const bySessionCache = new Map<string, { value: CloneRow | null; expiresAt: number }>();
const bySlotCache = new Map<string, { value: CloneRow | null; expiresAt: number }>();

export function invalidateCloneCache(opts?: { sessao?: string; slot?: string }): void {
  if (!opts) {
    bySessionCache.clear();
    bySlotCache.clear();
    return;
  }
  if (opts.sessao) bySessionCache.delete(opts.sessao);
  if (opts.slot) bySlotCache.delete(opts.slot);
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFD')
      // Remove diacríticos (combining marks U+0300–U+036F) após o NFD —
      // mesmo padrão do slugify de packages/integrations/src/provisioning/clone-provisioning.ts.
      // biome-ignore lint/suspicious/noMisleadingCharacterClass: faixa de combining marks é proposital pós-NFD
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
  );
}

function shortid(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/**
 * Aplica substituições {{chave}} no template usando personalizacao.
 * Fallback: se personalizacao contiver cliente_nome, substitui [Ricardo] por [clienteNome].
 */
function applyPersonalizacao(template: string, personalizacao: Record<string, string>): string {
  let result = template;

  // Substitui {{chave}} por valor correspondente
  result = result.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return Object.prototype.hasOwnProperty.call(personalizacao, key)
      ? personalizacao[key]
      : `{{${key}}}`;
  });

  // Fallback legado: [Ricardo] -> [clienteNome] quando cliente_nome fornecido
  if (personalizacao.cliente_nome) {
    result = result.replace(/\[Ricardo\]/g, `[${personalizacao.cliente_nome}]`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Funções públicas
// ---------------------------------------------------------------------------

export async function createClone(input: {
  matrizSlot: string;
  displayName: string;
  clienteNome?: string | null;
  clienteTelefone?: string | null;
  personalizacao?: Record<string, string>;
}): Promise<CloneRow> {
  const { matrizSlot, displayName, clienteNome, clienteTelefone } = input;
  const personalizacao = input.personalizacao ?? {};

  const slug = `clone_${slugify(displayName).slice(0, 40)}_${shortid(6)}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Copia bot_config da matriz
    const cfgRes = await client.query<{
      provider: string;
      model: string;
      temperature: string;
    }>('SELECT provider, model, temperature FROM bot_config WHERE slot = $1', [matrizSlot]);
    if (!cfgRes.rows[0]) {
      throw new Error(
        `flow-clones: createClone: matriz_slot "${matrizSlot}" não encontrado em bot_config`,
      );
    }
    const { provider, model, temperature } = cfgRes.rows[0];

    await client.query(
      `INSERT INTO bot_config (slot, display_name, provider, model, temperature, updated_at)
       VALUES ($1, $2, $3, $4, $5::numeric, NOW())`,
      [slug, displayName, provider, model, temperature],
    );

    // 2. Copia e personaliza bot_prompt
    const promptRes = await client.query<{ prompt: string }>(
      'SELECT prompt FROM bot_prompt WHERE slot = $1',
      [matrizSlot],
    );
    if (promptRes.rows[0]) {
      const promptPersonalizado = applyPersonalizacao(promptRes.rows[0].prompt, personalizacao);
      await client.query(
        'INSERT INTO bot_prompt (slot, prompt, updated_at) VALUES ($1, $2, NOW())',
        [slug, promptPersonalizado],
      );
    }

    // 3. Copia bot_media (inclui course_slug e is_course_intro para preservar vínculos de curso)
    const mediaRes = await client.query<{
      position: string;
      media_type: string;
      url: string | null;
      caption: string | null;
      context: string | null;
      position_order: number;
      enabled: boolean;
      course_slug: string | null;
      is_course_intro: boolean;
    }>(
      `SELECT position, media_type, url, caption, context, position_order, enabled,
              course_slug, is_course_intro
       FROM bot_media WHERE slot = $1`,
      [matrizSlot],
    );
    for (const m of mediaRes.rows) {
      await client.query(
        `INSERT INTO bot_media
           (slot, position, media_type, url, caption, context, position_order, enabled,
            course_slug, is_course_intro, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
        [
          slug,
          m.position,
          m.media_type,
          m.url,
          m.caption,
          m.context,
          m.position_order,
          m.enabled,
          m.course_slug ?? null,
          m.is_course_intro ?? false,
        ],
      );
    }

    // 3.5. Copia bot_courses (catálogo de cursos da matriz para o clone)
    const coursesRes = await client.query<{
      course_slug: string;
      name: string;
      description: string | null;
      price: number;
      duration: string | null;
      position_order: number;
      enabled: boolean;
    }>(
      `SELECT course_slug, name, description, price, duration, position_order, enabled
       FROM bot_courses WHERE slot = $1`,
      [matrizSlot],
    );
    for (const c of coursesRes.rows) {
      await client.query(
        `INSERT INTO bot_courses
           (slot, course_slug, name, description, price, duration, position_order, enabled, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
         ON CONFLICT (slot, course_slug) DO NOTHING`,
        [
          slug,
          c.course_slug,
          c.name,
          c.description,
          c.price,
          c.duration,
          c.position_order,
          c.enabled,
        ],
      );
    }

    // 4. Registra em flow_controls
    await client.query(
      `INSERT INTO flow_controls (flow_id, flow_name, source, active, updated_at)
       VALUES ($1, $2, 'clone', TRUE, NOW())
       ON CONFLICT (flow_id) DO UPDATE SET active = TRUE, updated_at = NOW()`,
      [slug, displayName],
    );

    // 5. INSERT flow_clones
    const cloneRes = await client.query<CloneRow>(
      `INSERT INTO flow_clones
         (slot, matriz_slot, display_name, cliente_nome, cliente_telefone, personalizacao, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'rascunho', NOW(), NOW())
       RETURNING *`,
      [
        slug,
        matrizSlot,
        displayName,
        clienteNome ?? null,
        clienteTelefone ?? null,
        JSON.stringify(personalizacao),
      ],
    );

    // Dual-write tenant_id (ADR 0018, Fase 2): as satélites acima foram inseridas
    // ANTES de flow_clones existir (o UUID nasce aqui, do DEFAULT gen_random_uuid()).
    // Carimba o tenant_id recém-gerado nelas DENTRO da mesma transação (atômico).
    // Idempotente (guard tenant_id IS NULL). Fail-safe: se ficar NULL, o backfill da
    // migration 045 / próximo write cobre — nunca derruba a criação do clone.
    const newTenantId = (cloneRes.rows[0] as unknown as { tenant_id?: string }).tenant_id ?? null;
    if (newTenantId) {
      for (const tbl of ['bot_config', 'bot_prompt', 'bot_media', 'bot_courses'] as const) {
        await client.query(
          `UPDATE ${tbl} SET tenant_id = $1 WHERE slot = $2 AND tenant_id IS NULL`,
          [newTenantId, slug],
        );
      }
    }

    await client.query('COMMIT');
    invalidateTenantCache(slug);
    return normalizeCloneRow(cloneRes.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function listClones(): Promise<CloneSummary[]> {
  const r = await query<CloneSummary & { id: string }>(
    `SELECT fc.id, fc.slot, fc.matriz_slot, fc.display_name, fc.cliente_nome,
            fc.cliente_telefone, fc.personalizacao, fc.waha_sessao, fc.status,
            fc.flow_enabled, fc.suspended_reason, fc.suspended_at,
            fc.horarios_funcionamento, fc.servicos,
            fc.created_at, fc.updated_at,
            bc.display_name AS matriz_display_name
     FROM flow_clones fc
     LEFT JOIN bot_config bc ON bc.slot = fc.matriz_slot
     ORDER BY fc.created_at DESC`,
  );
  return r.rows.map((row) => ({
    ...normalizeCloneRow(row),
    matriz_display_name: (row as unknown as { matriz_display_name: string | null })
      .matriz_display_name,
  }));
}

export async function getClone(id: number): Promise<CloneSummary | null> {
  const r = await query<CloneSummary & { id: string }>(
    `SELECT fc.id, fc.slot, fc.matriz_slot, fc.display_name, fc.cliente_nome,
            fc.cliente_telefone, fc.personalizacao, fc.waha_sessao, fc.status,
            fc.flow_enabled, fc.suspended_reason, fc.suspended_at,
            fc.horarios_funcionamento, fc.servicos,
            fc.created_at, fc.updated_at,
            bc.display_name AS matriz_display_name
     FROM flow_clones fc
     LEFT JOIN bot_config bc ON bc.slot = fc.matriz_slot
     WHERE fc.id = $1`,
    [id],
  );
  if (!r.rows[0]) return null;
  return {
    ...normalizeCloneRow(r.rows[0]),
    matriz_display_name: (r.rows[0] as unknown as { matriz_display_name: string | null })
      .matriz_display_name,
  };
}

export async function updateClone(
  id: number,
  patch: {
    displayName?: string;
    clienteNome?: string | null;
    clienteTelefone?: string | null;
    personalizacao?: Record<string, string>;
    status?: CloneStatus;
  },
): Promise<CloneRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;

  if (patch.displayName !== undefined) {
    sets.push(`display_name = $${i++}`);
    vals.push(patch.displayName);
  }
  if (patch.clienteNome !== undefined) {
    sets.push(`cliente_nome = $${i++}`);
    vals.push(patch.clienteNome);
  }
  if (patch.clienteTelefone !== undefined) {
    sets.push(`cliente_telefone = $${i++}`);
    vals.push(patch.clienteTelefone);
  }
  if (patch.personalizacao !== undefined) {
    sets.push(`personalizacao = $${i++}::jsonb`);
    vals.push(JSON.stringify(patch.personalizacao));
  }
  if (patch.status !== undefined) {
    sets.push(`status = $${i++}`);
    vals.push(patch.status);
  }

  if (sets.length === 0) return getClone(id);

  sets.push('updated_at = NOW()');
  vals.push(id);

  const r = await query<CloneRow & { id: string }>(
    `UPDATE flow_clones SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    vals,
  );
  if (!r.rows[0]) return null;

  const row = normalizeCloneRow(r.rows[0]);

  // Se personalizacao mudou, regenera bot_prompt a partir da matriz
  if (patch.personalizacao !== undefined) {
    const personalizacao = patch.personalizacao;
    const matrizRes = await query<{ matriz_slot: string }>(
      'SELECT matriz_slot FROM flow_clones WHERE id = $1',
      [id],
    );
    const matrizSlot = matrizRes.rows[0]?.matriz_slot;
    if (matrizSlot) {
      const promptRes = await query<{ prompt: string }>(
        'SELECT prompt FROM bot_prompt WHERE slot = $1',
        [matrizSlot],
      );
      if (promptRes.rows[0]) {
        const novo = applyPersonalizacao(promptRes.rows[0].prompt, personalizacao);
        // Dual-write tenant_id (ADR 0018, Fase 2): subselect inline — o clone já
        // existe aqui, então resolve o UUID. NULL-safe se não houver linha.
        // Slot do subselect é parâmetro SEPARADO ($3) — não reusa $1 (evita
        // "inconsistent types deduced for parameter $1": bot_prompt.slot
        // varchar(50) vs flow_clones.slot varchar(80)).
        await query(
          `INSERT INTO bot_prompt (slot, prompt, updated_at, tenant_id)
           VALUES ($1, $2, NOW(), (SELECT tenant_id FROM flow_clones WHERE slot = $3))
           ON CONFLICT (slot) DO UPDATE SET prompt = EXCLUDED.prompt, updated_at = NOW(),
             tenant_id = COALESCE(bot_prompt.tenant_id, EXCLUDED.tenant_id)`,
          [row.slot, novo, row.slot],
        );
      }
    }
  }

  invalidateCloneCache({ slot: row.slot, sessao: row.waha_sessao ?? undefined });
  return row;
}

export async function setCloneSession(id: number, sessaoName: string): Promise<CloneRow | null> {
  const r = await query<CloneRow & { id: string }>(
    `UPDATE flow_clones
     SET waha_sessao = $1, status = 'aguardando_qr', updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [sessaoName, id],
  );
  if (!r.rows[0]) return null;
  const row = normalizeCloneRow(r.rows[0]);
  invalidateCloneCache({ sessao: sessaoName, slot: row.slot });
  return row;
}

export async function setCloneStatus(id: number, status: CloneStatus): Promise<CloneRow | null> {
  const r = await query<CloneRow & { id: string }>(
    'UPDATE flow_clones SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
    [status, id],
  );
  if (!r.rows[0]) return null;
  const row = normalizeCloneRow(r.rows[0]);
  invalidateCloneCache({ slot: row.slot, sessao: row.waha_sessao ?? undefined });
  return row;
}

/**
 * Remove o clone e todos os registros dependentes via CASCADE de bot_config.
 * bot_prompt, bot_media e flow_clones são limpos por FK CASCADE.
 * flow_controls usa flow_id = slot — removido explicitamente pois não tem FK.
 * Retorna o waha_sessao para o chamador poder fazer logout se necessário.
 */
export async function deleteClone(
  id: number,
): Promise<{ slot: string; waha_sessao: string | null } | null> {
  const existing = await query<{ slot: string; waha_sessao: string | null }>(
    'SELECT slot, waha_sessao FROM flow_clones WHERE id = $1',
    [id],
  );
  const row = existing.rows[0];
  if (!row) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // flow_controls não tem FK para bot_config — remove manualmente
    await client.query('DELETE FROM flow_controls WHERE flow_id = $1', [row.slot]);
    // bot_config CASCADE limpa bot_prompt, bot_media e flow_clones
    await client.query('DELETE FROM bot_config WHERE slot = $1', [row.slot]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  invalidateCloneCache({ slot: row.slot, sessao: row.waha_sessao ?? undefined });
  invalidateTenantCache(row.slot);
  return { slot: row.slot, waha_sessao: row.waha_sessao };
}

/**
 * Retorna o clone associado a uma sessão WAHA dedicada.
 * Retorna null se nenhum clone estiver vinculado à sessão; lança apenas em falha de DB.
 * Cache TTL de 60s — hot path do router (chamada por webhook).
 */
export async function getCloneBySession(sessao: string): Promise<CloneRow | null> {
  const cached = bySessionCache.get(sessao);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const r = await query<CloneRow & { id: string }>(
    `SELECT id, slot, matriz_slot, display_name, cliente_nome, cliente_telefone,
            personalizacao, waha_sessao, waha_shard_id, status,
            flow_enabled, suspended_reason, suspended_at,
            horarios_funcionamento, servicos,
            created_at, updated_at
     FROM flow_clones WHERE waha_sessao = $1 LIMIT 1`,
    [sessao],
  );
  const value = r.rows[0] ? normalizeCloneRow(r.rows[0]) : null;
  bySessionCache.set(sessao, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * Retorna o clone pelo slot (usado pelo dispatcher).
 * Cache TTL de 60s — hot path do router ao resolver clone dinamicamente.
 */
export async function getCloneBySlot(slot: string): Promise<CloneRow | null> {
  const cached = bySlotCache.get(slot);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  // LEFT JOIN client_billing (1 linha por slot) no MESMO SELECT — alimenta o gate de
  // silencio por cobranca (ADR 0016) sem query extra no hot path. Cache TTL 60s ja cobre
  // (vencimento muda 1x/dia). billing.next_due_date -> 'YYYY-MM-DD' via to_char.
  const r = await query<CloneRow & { id: string }>(
    `SELECT fc.id, fc.slot, fc.matriz_slot, fc.display_name, fc.cliente_nome, fc.cliente_telefone,
            fc.personalizacao, fc.waha_sessao, fc.waha_shard_id, fc.status,
            fc.flow_enabled, fc.suspended_reason, fc.suspended_at,
            fc.horarios_funcionamento, fc.servicos,
            to_char(cb.next_due_date, 'YYYY-MM-DD') AS next_due_date,
            cb.amount_cents AS billing_amount_cents,
            fc.created_at, fc.updated_at
     FROM flow_clones fc
     LEFT JOIN client_billing cb ON cb.slot = fc.slot
     WHERE fc.slot = $1`,
    [slot],
  );
  const value = r.rows[0] ? normalizeCloneRow(r.rows[0]) : null;
  bySlotCache.set(slot, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

// ---------------------------------------------------------------------------
// Cancelamento escalado — destino do alerta pro DONO do clone (Missão 023 W5)
// ---------------------------------------------------------------------------

export interface CloneAlertOwner {
  /** Telefone E.164 (só dígitos) do dono que RECEBE o alerta. null = sem destino. */
  phone: string | null;
  /** Toggle por-clone (coluna alert_owner_enabled, default TRUE). */
  enabled: boolean;
  /** Nome amigável do clone p/ a mensagem do alerta (display_name). */
  displayName: string;
}

/**
 * Lê o destino do alerta de cancelamento de um clone (migration 050).
 * Sem hardcode de número. Fonte do telefone, em ordem de precedência:
 *   1. flow_clones.alert_owner_phone (coluna dedicada, backfill da migration 050);
 *   2. FALLBACK -> flow_clones.cliente_telefone, quando alert_owner_phone for NULL/vazio.
 *
 * Por que o fallback: o provisioning de clone NOVO NÃO grava alert_owner_phone (a 050 só
 * fez backfill dos EXISTENTES). Sem o fallback, todo clone novo nasceria sem destino e o
 * escalonamento de cancelamento ficaria mudo até alguém preencher a coluna na mão. Com o
 * fallback, TODO clone (novo ou velho) tem destino sem depender de backfill/provisioning.
 *
 * Retorna null se o slot não for um clone (matriz/infra não têm dono).
 * `enabled` reflete o toggle por-clone (alert_owner_enabled); o gate macro (flag de ambiente
 * CANCELAMENTO_ESCALADO_ENABLED) é responsabilidade do chamador (apps/api).
 * Normaliza o telefone p/ dígitos e exige >=8 (senão phone=null → não escala).
 */
export async function getCloneAlertOwner(slot: string): Promise<CloneAlertOwner | null> {
  const r = await query<{
    alert_owner_phone: string | null;
    cliente_telefone: string | null;
    alert_owner_enabled: boolean | null;
    display_name: string;
  }>(
    `SELECT alert_owner_phone, cliente_telefone, alert_owner_enabled, display_name
       FROM flow_clones WHERE slot = $1 LIMIT 1`,
    [slot],
  );
  const row = r.rows[0];
  if (!row) return null;
  // Precedência: alert_owner_phone -> cliente_telefone (fallback p/ clones sem backfill).
  const ownerDigits = (row.alert_owner_phone ?? '').replace(/\D/g, '');
  const fallbackDigits = (row.cliente_telefone ?? '').replace(/\D/g, '');
  const digits = ownerDigits.length >= 8 ? ownerDigits : fallbackDigits;
  return {
    phone: digits.length >= 8 ? digits : null,
    enabled: row.alert_owner_enabled !== false,
    displayName: row.display_name,
  };
}

// ---------------------------------------------------------------------------
// Suspender / reativar fluxo (billing, inadimplência, férias)
// ---------------------------------------------------------------------------

export interface SuspensionLogEntry {
  id: number;
  slot: string;
  action: 'suspend' | 'resume';
  reason: string | null;
  actor: string;
  created_at: Date;
}

/**
 * Suspende o fluxo de um clone: flow_enabled=false, WAHA permanece conectado.
 * Registra em flow_suspension_log para auditoria.
 * Idempotente: se já suspenso, apenas atualiza reason/actor no log.
 */
export async function suspendClone(opts: {
  slot: string;
  reason?: string | null;
  actor: string;
}): Promise<CloneRow | null> {
  const { slot, reason, actor } = opts;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query<CloneRow & { id: string }>(
      `UPDATE flow_clones
       SET flow_enabled = false,
           suspended_reason = $1,
           suspended_at = NOW(),
           updated_at = NOW()
       WHERE slot = $2
       RETURNING *`,
      [reason ?? null, slot],
    );
    if (!r.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query(
      `INSERT INTO flow_suspension_log (slot, action, reason, actor)
       VALUES ($1, 'suspend', $2, $3)`,
      [slot, reason ?? null, actor],
    );

    await client.query('COMMIT');
    const row = normalizeCloneRow(r.rows[0]);
    invalidateCloneCache({ slot, sessao: row.waha_sessao ?? undefined });
    return row;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Reativa o fluxo de um clone: flow_enabled=true, limpa suspended_reason/at.
 * Registra em flow_suspension_log para auditoria.
 */
export async function resumeClone(opts: {
  slot: string;
  actor: string;
}): Promise<CloneRow | null> {
  const { slot, actor } = opts;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query<CloneRow & { id: string }>(
      `UPDATE flow_clones
       SET flow_enabled = true,
           suspended_reason = NULL,
           suspended_at = NULL,
           updated_at = NOW()
       WHERE slot = $1
       RETURNING *`,
      [slot],
    );
    if (!r.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query(
      `INSERT INTO flow_suspension_log (slot, action, reason, actor)
       VALUES ($1, 'resume', NULL, $2)`,
      [slot, actor],
    );

    await client.query('COMMIT');
    const row = normalizeCloneRow(r.rows[0]);
    invalidateCloneCache({ slot, sessao: row.waha_sessao ?? undefined });
    return row;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Normalização de tipos
// ---------------------------------------------------------------------------

function parseJsonbOrNull<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

function normalizeCloneRow(row: CloneRow & { id: string | number }): CloneRow {
  return {
    ...row,
    id: Number(row.id),
    // pg retorna JSONB já parseado, mas garantimos o tipo
    personalizacao:
      typeof row.personalizacao === 'string'
        ? (JSON.parse(row.personalizacao) as Record<string, string>)
        : row.personalizacao,
    // flow_enabled vem como boolean do pg; fallback true para rows sem a coluna
    // (antes da migration 038 ser aplicada em dev)
    flow_enabled: (row as unknown as { flow_enabled?: unknown }).flow_enabled !== false,
    // waha_shard_id: pg devolve int -> number. Fallback 0 (shard atual) p/ rows que
    // não selecionam a coluna ou rodam antes da migration 047 em dev (ADR 0020).
    waha_shard_id: Number((row as unknown as { waha_shard_id?: unknown }).waha_shard_id ?? 0),
    suspended_reason:
      ((row as unknown as { suspended_reason?: unknown }).suspended_reason as string | null) ??
      null,
    suspended_at:
      ((row as unknown as { suspended_at?: unknown }).suspended_at as Date | null) ?? null,
    horarios_funcionamento: parseJsonbOrNull<HorariosFuncionamento>(row.horarios_funcionamento),
    servicos: parseJsonbOrNull<ServicoConfig[]>(row.servicos),
    // Campos do LEFT JOIN client_billing (so vem de getCloneBySlot). Rows de outras
    // origens (getCloneBySession, RETURNING *) nao tem -> null. pg ja devolve
    // amount_cents como number; o ?? null cobre o caso da coluna ausente.
    next_due_date:
      ((row as unknown as { next_due_date?: unknown }).next_due_date as string | null) ?? null,
    billing_amount_cents:
      ((row as unknown as { billing_amount_cents?: unknown }).billing_amount_cents as
        | number
        | null) ?? null,
  };
}
