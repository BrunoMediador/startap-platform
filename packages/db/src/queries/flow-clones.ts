/**
 * flow-clones — CRUD de clones de fluxos matriz.
 *
 * Um clone herda bot_config/bot_prompt/bot_media de uma matriz, com personalizacao
 * própria e sessão WAHA dedicada. Toda criação ocorre em transação única.
 */
import { meIdToDigits } from '@startap/core/phone';
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
  /**
   * Categoria ESTRUTURADA da suspensão (ADR 0013 / threat-model C1; ADR 0014 F1).
   * ∈ billing | owner_request | manual_other | abuse | null.
   * - 'owner_request' = pausa self-service do PRÓPRIO cliente pelo portal (NUNCA
   *   reativada pelo PIX — só o dono levanta).
   * - 'billing' = inadimplência; ÚNICO kind que o auto-resume do webhook PIX reativa.
   * - 'manual_other' | 'abuse' = suspensão pela Startap; o cliente NÃO destrava (409).
   * null em rows de SELECTs que não pedem a coluna (não quebra normalizeCloneRow).
   */
  suspended_kind: string | null;
  suspended_at: Date | null;
  horarios_funcionamento: HorariosFuncionamento | null;
  servicos: ServicoConfig[] | null;
  /**
   * Fuso (IANA) do relógio da barbearia (migration 068). DEFAULT 'America/Sao_Paulo'
   * carimba todo clone existente — todo clone que não declarou outro fuso permanece
   * byte-idêntico ao comportamento de hoje. Ex.: 'America/Cuiaba' (Seven 7, Mato Grosso).
   * normalizeCloneRow garante 'America/Sao_Paulo' quando a coluna não vem no SELECT.
   */
  timezone: string;
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
  /** Fuso IANA do clone (migration 068). Ausente/vazio -> 'America/Sao_Paulo'
   * (byte-idêntico ao default do banco). Espera-se JÁ validado (isValidIanaTimezone). */
  timezone?: string | null;
}): Promise<CloneRow> {
  const { matrizSlot, displayName, clienteNome, clienteTelefone } = input;
  const personalizacao = input.personalizacao ?? {};
  const timezone =
    typeof input.timezone === 'string' && input.timezone.trim() !== ''
      ? input.timezone
      : 'America/Sao_Paulo';

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
         (slot, matriz_slot, display_name, cliente_nome, cliente_telefone, personalizacao, timezone, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'rascunho', NOW(), NOW())
       RETURNING *`,
      [
        slug,
        matrizSlot,
        displayName,
        clienteNome ?? null,
        clienteTelefone ?? null,
        JSON.stringify(personalizacao),
        timezone,
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
            fc.horarios_funcionamento, fc.servicos, fc.timezone,
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
            fc.horarios_funcionamento, fc.servicos, fc.timezone,
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
 * Flipa flow_clones.status -> 'conectado' para o slot, IDEMPOTENTE, só quando ainda
 * não está 'conectado'. Desacoplado da contagem de trial: roda em TODO WORKING.
 *
 * POR QUÊ: antes o flip de status p/ 'conectado' vivia SÓ como efeito colateral dentro
 * de startTrial/consumeAdditionalNumber/markExempt (trial-ledger). Logo, quando o número
 * já tinha sido contado no trial (caminho 'trial-already-counted', reconexão do mesmo
 * número no mesmo clone), o hook de session.status retornava cedo SEM flipar — e o status
 * ficava preso em 'desconectado' mesmo com a sessão WORKING. Isso some do monitor de
 * sessões (alerts.listMonitoredSessions exige status='conectado') e dos alertas de
 * sessão-caída ao dono. Esta função separa a responsabilidade (a) "está conectado" da
 * (b) "contou o trial".
 *
 * SÓ toca `status` e `first_connected_at` — NUNCA trial_status/cliente_telefone (sem regressão
 * no dedup/tracking do trial). Invalida o cache apenas quando muda de fato.
 *
 * `first_connected_at` (migration 062): carimba NOW() na 1ª conexão e NUNCA sobrescreve
 * (COALESCE preserva o valor já gravado). É o sinal durável de "este clone JÁ pareou alguma vez"
 * que o monitor de sessões usa pra distinguir QUEDA REAL (alertar) de PRÉ-SETUP nunca-conectado
 * (FAILED esperado, NÃO alertar) — ver alerts.listMonitoredSessions. Reconexões repetidas mantêm
 * o carimbo original. NOTA: a UPDATE roda também quando o status já é 'conectado' MAS o carimbo
 * está NULL (clone legado conectado ANTES da 062 sem backfill), pra preencher first_connected_at
 * sem depender de backfill; o COALESCE garante no-op nessa coluna após a 1ª vez.
 *
 * @returns true se ESTA chamada flipou o STATUS (estava != 'conectado'); false se já estava
 *          'conectado' (ainda que tenha carimbado first_connected_at agora) ou o slot não é um
 *          clone (no-op idempotente). Contrato histórico preservado: o boolean reflete só a
 *          mudança de status.
 */
export async function markCloneConnectedBySlot(slot: string): Promise<boolean> {
  const r = await query<{ slot: string; status_changed: boolean }>(
    `UPDATE flow_clones
        SET status = 'conectado',
            first_connected_at = COALESCE(first_connected_at, NOW()),
            updated_at = NOW()
      WHERE slot = $1
        AND (status IS DISTINCT FROM 'conectado' OR first_connected_at IS NULL)
      RETURNING slot, (status IS DISTINCT FROM 'conectado') AS status_changed`,
    [slot],
  );
  const row = r.rows[0];
  // Linha afetada -> cache pode estar stale (status e/ou first_connected_at mudaram).
  if (row) invalidateCloneCache({ slot });
  // RETURNING avalia o predicado ANTES do SET (semântica do UPDATE) -> status_changed reflete o
  // estado PRÉVIO, exatamente o que o contrato pede (true só quando o status realmente mudou).
  return row?.status_changed === true;
}

/**
 * Fuso (IANA) do clone (migration 068). Retorna 'America/Sao_Paulo' quando o slot
 * não existe ou a coluna vier vazia — nunca `null` (o default do banco garante o
 * carimbo). Consumido pelo GET /portal/perfil pra pré-selecionar o seletor.
 */
export async function getTimezoneBySlot(slot: string): Promise<string> {
  const r = await query<{ timezone: string | null }>(
    'SELECT timezone FROM flow_clones WHERE slot = $1',
    [slot],
  );
  return r.rows[0]?.timezone ?? 'America/Sao_Paulo';
}

/**
 * Grava o fuso (IANA) do clone. Espera que `timezone` JÁ tenha passado por
 * isValidIanaTimezone no chamador (defesa: o portal/gestão validam contra a lista
 * IANA antes de chegar aqui). Escopado por slot (SEMPRE parametrizado, nunca
 * interpolado) — o slot vem da sessão (withTenant), jamais do input do cliente.
 * Invalida o cache de clone (TTL 60s) pro bot/free-slots pegarem o fuso novo.
 * Retorna false se o slot não existe.
 */
export async function updateTimezoneBySlot(slot: string, timezone: string): Promise<boolean> {
  const r = await query(
    'UPDATE flow_clones SET timezone = $2, updated_at = NOW() WHERE slot = $1',
    [slot, timezone],
  );
  if (r.rowCount === 0) return false;
  invalidateCloneCache({ slot });
  return true;
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
            horarios_funcionamento, servicos, timezone,
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
            fc.flow_enabled, fc.suspended_reason, fc.suspended_kind, fc.suspended_at,
            fc.horarios_funcionamento, fc.servicos, fc.timezone,
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
// Credencial Google do CLIENTE (login do Google Agenda no cel/PC) — migration 061
//
// É a credencial de LOGIN HUMANO que a empresa cria pro cliente entrar no app do
// Google Agenda — NÃO é a Service Account do bot (gcal_*, ADR 0024, escopo distinto).
//
// FORA do getCloneBySlot/CloneRow DE PROPÓSITO: a senha cifrada NUNCA pode entrar no
// cache de clone (TTL 60s, hot path do webhook) nem vazar pra outras rotas que leem
// CloneRow. Esta leitura é dedicada, SEM cache, parametrizada por slot, e só a usa o
// endpoint que entrega a credencial ao dono (GET /portal/google-conta), que decifra a
// senha server-side. Não seleciona NENHUMA coluna gcal_*.
// ---------------------------------------------------------------------------

export interface GoogleAccountRow {
  /** E-mail da conta Google do cliente (texto claro; identificador de login). null = não configurado. */
  google_account_email: string | null;
  /**
   * Senha CIFRADA (enc:v2:iv:tag:ciphertext). NUNCA decifrada aqui — a camada de cima
   * (rota) chama decryptSecret de @startap/core no ponto de uso. null = não configurada.
   */
  google_account_password_enc: string | null;
}

/**
 * Lê a credencial Google do cliente (e-mail + senha CIFRADA) de um slot. SEM cache (a
 * senha cifrada nunca encosta no cache de clone). Parametrizado por slot ($1). Devolve a
 * senha AINDA CIFRADA — quem chama decifra com decryptSecret no ponto de uso (e a senha
 * NUNCA pode ser logada). Retorna null se o slot não existe.
 */
export async function getGoogleAccountBySlot(slot: string): Promise<GoogleAccountRow | null> {
  const r = await query<{
    google_account_email: string | null;
    google_account_password_enc: string | null;
  }>(
    `SELECT google_account_email, google_account_password_enc
       FROM flow_clones WHERE slot = $1 LIMIT 1`,
    [slot],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    google_account_email: row.google_account_email ?? null,
    google_account_password_enc: row.google_account_password_enc ?? null,
  };
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
// Auto-aviso de DESCONEXÃO ao próprio cliente (B2B) — destino + nome do negócio
//
// Reusa o MESMO contrato/precedência de getCloneAlertOwner (alert_owner_phone ->
// cliente_telefone; toggle alert_owner_enabled), mas adiciona o nome do NEGÓCIO
// (personalizacao->>'nome_negocio') pra montar a copy "o WhatsApp da {NOME} caiu".
// SEPARADO de getCloneAlertOwner pra não inchar o caminho de cancelamento (W5) com
// uma coluna jsonb a mais. A flag macro (CLIENT_DISCONNECT_ALERT_ENABLED) é do chamador.
// ---------------------------------------------------------------------------

export interface CloneDisconnectAlertTarget {
  /** Telefone E.164 (só dígitos) do dono que RECEBE o aviso. null = sem destino -> não avisa. */
  phone: string | null;
  /** Toggle por-clone (alert_owner_enabled, default TRUE). false = opt-out -> não avisa. */
  enabled: boolean;
  /**
   * Nome do negócio p/ a mensagem (personalizacao->>'nome_negocio'). null/vazio -> o chamador
   * cai no fallback genérico ("seu atendimento"). NUNCA o display_name interno aqui (esse é nosso
   * rótulo de gestão; o cliente reconhece o nome do negócio dele).
   */
  nomeNegocio: string | null;
}

/**
 * Lê o destino do AUTO-AVISO DE DESCONEXÃO de um clone (mesma fonte de telefone do cancelamento
 * escalado — migration 050 — + nome do negócio da personalizacao). Retorna null se o slot não
 * for um clone. `enabled` reflete o opt-in por-clone; o gate macro de ambiente é do chamador.
 * Telefone normalizado p/ dígitos, exige >=8 (senão phone=null -> não avisa).
 */
export async function getCloneDisconnectAlertTarget(
  slot: string,
): Promise<CloneDisconnectAlertTarget | null> {
  const r = await query<{
    alert_owner_phone: string | null;
    cliente_telefone: string | null;
    alert_owner_enabled: boolean | null;
    nome_negocio: string | null;
  }>(
    `SELECT alert_owner_phone, cliente_telefone, alert_owner_enabled,
            NULLIF(TRIM(personalizacao->>'nome_negocio'), '') AS nome_negocio
       FROM flow_clones WHERE slot = $1 LIMIT 1`,
    [slot],
  );
  const row = r.rows[0];
  if (!row) return null;
  // Mesma precedência do cancelamento escalado: alert_owner_phone -> cliente_telefone.
  const ownerDigits = (row.alert_owner_phone ?? '').replace(/\D/g, '');
  const fallbackDigits = (row.cliente_telefone ?? '').replace(/\D/g, '');
  const digits = ownerDigits.length >= 8 ? ownerDigits : fallbackDigits;
  return {
    phone: digits.length >= 8 ? digits : null,
    enabled: row.alert_owner_enabled !== false,
    nomeNegocio: row.nome_negocio ?? null,
  };
}

/**
 * Preenche flow_clones.alert_owner_phone com o número da PRÓPRIA sessão WhatsApp
 * conectada (me.id), SOMENTE SE a coluna estiver vazia/NULL. Idempotente e seguro
 * para rodar em todo evento WORKING (Missão pós-023: clones novos nasciam sem
 * destino de alerta; o cancelamento escalado se perdia — não havia nada que
 * gravasse o telefone do dono no momento da conexão).
 *
 * REGRAS:
 *  - NUNCA sobrescreve valor já preenchido (respeita override manual / backfill 050).
 *    O guard `alert_owner_phone IS NULL OR alert_owner_phone = ''` garante isso no
 *    próprio UPDATE (não em read-then-write — sem TOCTOU).
 *  - Escopado por `slot` (âncora do tenant; flow_clones é a tabela-âncora — não há
 *    risco de cross-tenant pois 1 slot = 1 clone).
 *  - O telefone JÁ vem normalizado (dígitos puros) do chamador. Mesmo assim, defensa
 *    em profundidade: rejeita < 8 dígitos (não grava lixo).
 *  - SQL parametrizado com placeholders DISTINTOS ($1 phone, $2 slot) — nunca reusa
 *    o mesmo placeholder (lição ADR 0018 F2 / #309: "inconsistent types deduced for
 *    parameter $1").
 *
 * @returns true se ESTE chamada gravou o número (estava vazio); false se já havia
 *          valor (no-op) ou o slot não é um clone.
 */
export async function setCloneAlertOwnerPhoneIfEmpty(
  slot: string,
  phoneOrMeId: string,
): Promise<boolean> {
  // meIdToDigits corta sufixo de device (":12") e domínio ("@c.us"/"@s.whatsapp.net")
  // ANTES de limpar não-dígitos — replace(/\D/g) sozinho deixaria o "12" do device
  // colado no número. Preserva o 9 (NÃO usa canonicalE164).
  const digits = meIdToDigits(phoneOrMeId ?? '');
  if (!digits || digits.length < 8) return false; // não grava número inválido/curto

  const r = await query<{ slot: string }>(
    `UPDATE flow_clones
        SET alert_owner_phone = $1, updated_at = NOW()
      WHERE slot = $2
        AND (alert_owner_phone IS NULL OR alert_owner_phone = '')
      RETURNING slot`,
    [digits, slot],
  );
  const updated = (r.rowCount ?? 0) > 0;
  if (updated) invalidateCloneCache({ slot });
  return updated;
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
// Pausa/retomada SELF-SERVICE pelo DONO no portal (suspended_kind='owner_request')
//
// SEPARADO dos helpers legados suspendClone/resumeClone (que NÃO setam/filtram por
// suspended_kind). O contrato é estrito: o cliente só mexe na PRÓPRIA pausa.
//   - pauseBotByOwner: só pausa se HOJE flow_enabled=true. Se já suspenso pela Startap
//     (billing/manual_other/abuse), NÃO sobrescreve o kind — devolve {changed:false}.
//   - resumeBotByOwner: só destrava se suspended_kind='owner_request'. Suspensão da
//     Startap não casa o WHERE -> {changed:false} -> o caller responde 409.
// NUNCA usa suspended_kind='billing' aqui (senão o PIX reativaria a pausa do dono).
// invalidateCloneCache é IMPRESCINDÍVEL (cache TTL 60s; senão a pausa demora a valer).
// ---------------------------------------------------------------------------

/** kind canônico da pausa self-service. NUNCA 'billing' (anti auto-resume do PIX). */
export const OWNER_PAUSE_KIND = 'owner_request' as const;
const OWNER_PAUSE_REASON = 'Pausado pelo cliente no portal';

export interface OwnerPauseResult {
  /** true se ESTA chamada mudou o estado (pausou/retomou de fato). */
  changed: boolean;
  /** estado de flow_enabled APÓS a operação (refletido para o caller responder). */
  flow_enabled: boolean;
}

/**
 * Pausa o bot a pedido do DONO (self-service no portal): flow_enabled=false,
 * suspended_kind='owner_request'. WAHA permanece conectada.
 *
 * Idempotência/segurança (UPDATE condicional, sem read-then-write):
 *  - WHERE flow_enabled = TRUE -> só pausa quem está ATIVO. Se já suspenso (por
 *    qualquer kind), 0 linhas -> NÃO sobrescreve o kind da Startap (changed:false).
 *  - Idempotente em retry: 2ª chamada não casa o WHERE (já está false) -> changed:false,
 *    mas devolve flow_enabled=false (estado correto). SEM efeito colateral duplicado
 *    (não loga 2 vezes; o INSERT no log só roda quando rowCount>0).
 *  - slot é a âncora do tenant (vem da sessão pelo caller — anti-IDOR).
 */
export async function pauseBotByOwner(slot: string, actor: string): Promise<OwnerPauseResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query<{ slot: string; waha_sessao: string | null }>(
      `UPDATE flow_clones
          SET flow_enabled     = FALSE,
              suspended_kind   = $2,
              suspended_reason = $3,
              suspended_at     = NOW(),
              updated_at       = NOW()
        WHERE slot = $1
          AND flow_enabled = TRUE
        RETURNING slot, waha_sessao`,
      [slot, OWNER_PAUSE_KIND, OWNER_PAUSE_REASON],
    );

    const changed = (r.rowCount ?? 0) > 0;
    let sessao: string | null = null;
    if (changed) {
      sessao = r.rows[0].waha_sessao;
      await client.query(
        `INSERT INTO flow_suspension_log (slot, action, reason, actor)
         VALUES ($1, 'suspend', $2, $3)`,
        [slot, OWNER_PAUSE_REASON, actor],
      );
    }

    await client.query('COMMIT');
    if (changed) invalidateCloneCache({ slot, sessao: sessao ?? undefined });
    // flow_enabled APÓS a operação é sempre false (pausou agora ou já estava pausado).
    return { changed, flow_enabled: false };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Retoma o bot a pedido do DONO: SÓ destrava a PRÓPRIA pausa (owner_request).
 *
 * UPDATE condicional WHERE flow_enabled=FALSE AND suspended_kind='owner_request':
 *  - Suspensão da Startap (billing/manual_other/abuse) NÃO casa -> 0 linhas ->
 *    changed:false -> o caller responde 409 suspensao_startap (o cliente NÃO levanta).
 *  - Já ativo -> 0 linhas -> changed:false; o caller trata como "nada a fazer" (200).
 *  - Idempotente em retry (2ª chamada não casa após reativar).
 * Limpa kind/reason/at ao reativar. Loga 'resume' apenas quando rowCount>0.
 */
export async function resumeBotByOwner(slot: string, actor: string): Promise<OwnerPauseResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query<{ slot: string; waha_sessao: string | null }>(
      `UPDATE flow_clones
          SET flow_enabled     = TRUE,
              suspended_kind   = NULL,
              suspended_reason = NULL,
              suspended_at     = NULL,
              updated_at       = NOW()
        WHERE slot = $1
          AND flow_enabled = FALSE
          AND suspended_kind = $2
        RETURNING slot, waha_sessao`,
      [slot, OWNER_PAUSE_KIND],
    );

    const changed = (r.rowCount ?? 0) > 0;
    let sessao: string | null = null;
    if (changed) {
      sessao = r.rows[0].waha_sessao;
      await client.query(
        `INSERT INTO flow_suspension_log (slot, action, reason, actor)
         VALUES ($1, 'resume', NULL, $2)`,
        [slot, actor],
      );
    }

    await client.query('COMMIT');
    if (changed) invalidateCloneCache({ slot, sessao: sessao ?? undefined });
    return { changed, flow_enabled: changed };
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
    // suspended_kind: só vem de SELECTs que pedem a coluna (getCloneBySlot). Rows de
    // outras origens (getCloneBySession, RETURNING * de queries legadas) -> null.
    suspended_kind:
      ((row as unknown as { suspended_kind?: unknown }).suspended_kind as string | null) ?? null,
    suspended_at:
      ((row as unknown as { suspended_at?: unknown }).suspended_at as Date | null) ?? null,
    horarios_funcionamento: parseJsonbOrNull<HorariosFuncionamento>(row.horarios_funcionamento),
    servicos: parseJsonbOrNull<ServicoConfig[]>(row.servicos),
    // timezone (migration 068): só vem de SELECTs que pedem a coluna. Rows de outras
    // origens (RETURNING * legado) ou antes da migration em dev -> 'America/Sao_Paulo'
    // (default chumbado = byte-idêntico ao comportamento de hoje).
    timezone:
      ((row as unknown as { timezone?: unknown }).timezone as string | null) ?? 'America/Sao_Paulo',
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
