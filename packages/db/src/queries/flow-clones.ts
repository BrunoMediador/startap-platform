/**
 * flow-clones — CRUD de clones de fluxos matriz.
 *
 * Um clone herda bot_config/bot_prompt/bot_media de uma matriz, com personalizacao
 * própria e sessão WAHA dedicada. Toda criação ocorre em transação única.
 */
import { pool, query } from '../client.js';

export type CloneStatus =
  | 'rascunho'
  | 'aguardando_qr'
  | 'conectado'
  | 'desconectado'
  | 'falhou';

export interface CloneRow {
  id: number;
  slot: string;
  matriz_slot: string;
  display_name: string;
  cliente_nome: string | null;
  cliente_telefone: string | null;
  personalizacao: Record<string, string>;
  waha_sessao: string | null;
  status: CloneStatus;
  created_at: Date;
  updated_at: Date;
}

export interface CloneSummary extends CloneRow {
  matriz_display_name: string | null;
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
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
function applyPersonalizacao(
  template: string,
  personalizacao: Record<string, string>,
): string {
  let result = template;

  // Substitui {{chave}} por valor correspondente
  result = result.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return Object.prototype.hasOwnProperty.call(personalizacao, key)
      ? personalizacao[key]
      : `{{${key}}}`;
  });

  // Fallback legado: [Ricardo] -> [clienteNome] quando cliente_nome fornecido
  if (personalizacao['cliente_nome']) {
    result = result.replace(/\[Ricardo\]/g, `[${personalizacao['cliente_nome']}]`);
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
    }>(
      `SELECT provider, model, temperature FROM bot_config WHERE slot = $1`,
      [matrizSlot],
    );
    if (!cfgRes.rows[0]) {
      throw new Error(`flow-clones: createClone: matriz_slot "${matrizSlot}" não encontrado em bot_config`);
    }
    const { provider, model, temperature } = cfgRes.rows[0];

    await client.query(
      `INSERT INTO bot_config (slot, display_name, provider, model, temperature, updated_at)
       VALUES ($1, $2, $3, $4, $5::numeric, NOW())`,
      [slug, displayName, provider, model, temperature],
    );

    // 2. Copia e personaliza bot_prompt
    const promptRes = await client.query<{ prompt: string }>(
      `SELECT prompt FROM bot_prompt WHERE slot = $1`,
      [matrizSlot],
    );
    if (promptRes.rows[0]) {
      const promptPersonalizado = applyPersonalizacao(promptRes.rows[0].prompt, personalizacao);
      await client.query(
        `INSERT INTO bot_prompt (slot, prompt, updated_at) VALUES ($1, $2, NOW())`,
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
        [slug, m.position, m.media_type, m.url, m.caption, m.context, m.position_order, m.enabled,
         m.course_slug ?? null, m.is_course_intro ?? false],
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
        [slug, c.course_slug, c.name, c.description, c.price, c.duration, c.position_order, c.enabled],
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
       RETURNING id, slot, matriz_slot, display_name, cliente_nome, cliente_telefone,
                 personalizacao, waha_sessao, status, created_at, updated_at`,
      [slug, matrizSlot, displayName, clienteNome ?? null, clienteTelefone ?? null, JSON.stringify(personalizacao)],
    );

    await client.query('COMMIT');
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
            fc.created_at, fc.updated_at,
            bc.display_name AS matriz_display_name
     FROM flow_clones fc
     LEFT JOIN bot_config bc ON bc.slot = fc.matriz_slot
     ORDER BY fc.created_at DESC`,
  );
  return r.rows.map((row) => ({
    ...normalizeCloneRow(row),
    matriz_display_name: (row as unknown as { matriz_display_name: string | null }).matriz_display_name,
  }));
}

export async function getClone(id: number): Promise<CloneSummary | null> {
  const r = await query<CloneSummary & { id: string }>(
    `SELECT fc.id, fc.slot, fc.matriz_slot, fc.display_name, fc.cliente_nome,
            fc.cliente_telefone, fc.personalizacao, fc.waha_sessao, fc.status,
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
    matriz_display_name: (r.rows[0] as unknown as { matriz_display_name: string | null }).matriz_display_name,
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
      `SELECT matriz_slot FROM flow_clones WHERE id = $1`,
      [id],
    );
    const matrizSlot = matrizRes.rows[0]?.matriz_slot;
    if (matrizSlot) {
      const promptRes = await query<{ prompt: string }>(
        `SELECT prompt FROM bot_prompt WHERE slot = $1`,
        [matrizSlot],
      );
      if (promptRes.rows[0]) {
        const novo = applyPersonalizacao(promptRes.rows[0].prompt, personalizacao);
        await query(
          `INSERT INTO bot_prompt (slot, prompt, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (slot) DO UPDATE SET prompt = EXCLUDED.prompt, updated_at = NOW()`,
          [row.slot, novo],
        );
      }
    }
  }

  return row;
}

export async function setCloneSession(id: number, sessaoName: string): Promise<CloneRow | null> {
  const r = await query<CloneRow & { id: string }>(
    `UPDATE flow_clones
     SET waha_sessao = $1, status = 'aguardando_qr', updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [sessaoName, id],
  );
  return r.rows[0] ? normalizeCloneRow(r.rows[0]) : null;
}

export async function setCloneStatus(id: number, status: CloneStatus): Promise<CloneRow | null> {
  const r = await query<CloneRow & { id: string }>(
    `UPDATE flow_clones SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [status, id],
  );
  return r.rows[0] ? normalizeCloneRow(r.rows[0]) : null;
}

/**
 * Remove o clone e todos os registros dependentes via CASCADE de bot_config.
 * bot_prompt, bot_media e flow_clones são limpos por FK CASCADE.
 * flow_controls usa flow_id = slot — removido explicitamente pois não tem FK.
 * Retorna o waha_sessao para o chamador poder fazer logout se necessário.
 */
export async function deleteClone(id: number): Promise<{ slot: string; waha_sessao: string | null } | null> {
  const existing = await query<{ slot: string; waha_sessao: string | null }>(
    `SELECT slot, waha_sessao FROM flow_clones WHERE id = $1`,
    [id],
  );
  const row = existing.rows[0];
  if (!row) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // flow_controls não tem FK para bot_config — remove manualmente
    await client.query(`DELETE FROM flow_controls WHERE flow_id = $1`, [row.slot]);
    // bot_config CASCADE limpa bot_prompt, bot_media e flow_clones
    await client.query(`DELETE FROM bot_config WHERE slot = $1`, [row.slot]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return { slot: row.slot, waha_sessao: row.waha_sessao };
}

/**
 * Retorna o clone associado a uma sessão WAHA dedicada.
 * Retorna null se nenhum clone estiver vinculado à sessão; lança apenas em falha de DB.
 */
export async function getCloneBySession(sessao: string): Promise<CloneRow | null> {
  const r = await query<CloneRow & { id: string }>(
    `SELECT id, slot, matriz_slot, display_name, cliente_nome, cliente_telefone,
            personalizacao, waha_sessao, status, created_at, updated_at
     FROM flow_clones WHERE waha_sessao = $1 LIMIT 1`,
    [sessao],
  );
  return r.rows[0] ? normalizeCloneRow(r.rows[0]) : null;
}

/**
 * Retorna o clone pelo slot (usado pelo dispatcher).
 */
export async function getCloneBySlot(slot: string): Promise<CloneRow | null> {
  const r = await query<CloneRow & { id: string }>(
    `SELECT id, slot, matriz_slot, display_name, cliente_nome, cliente_telefone,
            personalizacao, waha_sessao, status, created_at, updated_at
     FROM flow_clones WHERE slot = $1`,
    [slot],
  );
  return r.rows[0] ? normalizeCloneRow(r.rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Normalização de tipos
// ---------------------------------------------------------------------------

function normalizeCloneRow(row: CloneRow & { id: string | number }): CloneRow {
  return {
    ...row,
    id: Number(row.id),
    // pg retorna JSONB já parseado, mas garantimos o tipo
    personalizacao:
      typeof row.personalizacao === 'string'
        ? (JSON.parse(row.personalizacao) as Record<string, string>)
        : row.personalizacao,
  };
}
