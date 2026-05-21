/**
 * bot-courses — catálogo de cursos por slot (multi-tenant).
 *
 * Criado em Missão 006-A. CRUD completo adicionado em 006-B.
 * details_for_llm adicionado em feat/courses-details-for-llm (decisao #14).
 */
import { query } from '../client.js';

export interface BotCourseRow {
  id: number;
  slot: string;
  course_slug: string;
  name: string;
  description: string | null;
  /** Preço em centavos. Converter para reais na camada de apresentação. */
  price: number;
  duration: string | null;
  position_order: number;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
  /**
   * Texto livre com detalhes do curso para injetar no contexto do LLM.
   * NULL para cursos criados antes da migration 034. Formatado como
   * bullet points ou texto corrido pelo admin.
   */
  details_for_llm: string | null;
}

export interface CreateCourseInput {
  slot: string;
  course_slug: string;
  name: string;
  description?: string | null;
  price?: number;
  duration?: string | null;
  position_order?: number;
  enabled?: boolean;
  details_for_llm?: string | null;
}

export interface UpdateCourseInput {
  name?: string;
  description?: string | null;
  price?: number;
  duration?: string | null;
  position_order?: number;
  enabled?: boolean;
  details_for_llm?: string | null;
}

function mapRow(
  row: BotCourseRow & {
    id: string | number;
    price: string | number;
    position_order: string | number;
  },
): BotCourseRow {
  return {
    ...row,
    id: Number(row.id),
    price: Number(row.price),
    position_order: Number(row.position_order),
  };
}

/**
 * Retorna todos os cursos do slot, ordenados por position_order.
 * Inclui cursos desabilitados — filtro de `enabled` fica na camada de uso.
 */
export async function listCoursesBySlot(slot: string): Promise<BotCourseRow[]> {
  const r = await query<BotCourseRow & { id: string; price: string; position_order: string }>(
    `SELECT id, slot, course_slug, name, description, price, duration, position_order, enabled, created_at, updated_at, details_for_llm
     FROM bot_courses
     WHERE slot = $1
     ORDER BY position_order, id`,
    [slot],
  );
  return r.rows.map(mapRow);
}

/**
 * Busca um curso por slot + id.
 */
export async function getCourseById(slot: string, id: number): Promise<BotCourseRow | null> {
  const r = await query<BotCourseRow & { id: string; price: string; position_order: string }>(
    `SELECT id, slot, course_slug, name, description, price, duration, position_order, enabled, created_at, updated_at, details_for_llm
     FROM bot_courses
     WHERE slot = $1 AND id = $2`,
    [slot, id],
  );
  return r.rows[0] ? mapRow(r.rows[0]) : null;
}

/**
 * Busca um curso por slot + course_slug.
 */
export async function getCourseBySlug(
  slot: string,
  courseSlug: string,
): Promise<BotCourseRow | null> {
  const r = await query<BotCourseRow & { id: string; price: string; position_order: string }>(
    `SELECT id, slot, course_slug, name, description, price, duration, position_order, enabled, created_at, updated_at, details_for_llm
     FROM bot_courses
     WHERE slot = $1 AND course_slug = $2`,
    [slot, courseSlug],
  );
  return r.rows[0] ? mapRow(r.rows[0]) : null;
}

/**
 * Cria um curso. Lança erro 'UNIQUE_VIOLATION' se course_slug já existe no slot.
 */
export async function createCourse(input: CreateCourseInput): Promise<BotCourseRow> {
  const r = await query<BotCourseRow & { id: string; price: string; position_order: string }>(
    `INSERT INTO bot_courses
       (slot, course_slug, name, description, price, duration, position_order, enabled, details_for_llm, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
     RETURNING *`,
    [
      input.slot,
      input.course_slug,
      input.name,
      input.description ?? null,
      input.price ?? 0,
      input.duration ?? null,
      input.position_order ?? 0,
      input.enabled ?? true,
      input.details_for_llm ?? null,
    ],
  );
  return mapRow(r.rows[0]);
}

/**
 * Atualiza os campos fornecidos de um curso. Retorna null se não encontrado.
 */
export async function updateCourse(
  slot: string,
  id: number,
  input: UpdateCourseInput,
): Promise<BotCourseRow | null> {
  const fields: string[] = [];
  // Tipo union explícito para suportar todos os valores possíveis dos campos de bot_courses
  const vals: (string | number | boolean | null)[] = [];
  let idx = 1;

  if (input.name !== undefined) {
    fields.push(`name = $${idx++}`);
    vals.push(input.name);
  }
  if (input.description !== undefined) {
    fields.push(`description = $${idx++}`);
    vals.push(input.description);
  }
  if (input.price !== undefined) {
    fields.push(`price = $${idx++}`);
    vals.push(input.price);
  }
  if (input.duration !== undefined) {
    fields.push(`duration = $${idx++}`);
    vals.push(input.duration);
  }
  if (input.position_order !== undefined) {
    fields.push(`position_order = $${idx++}`);
    vals.push(input.position_order);
  }
  if (input.enabled !== undefined) {
    fields.push(`enabled = $${idx++}`);
    vals.push(input.enabled);
  }
  if (input.details_for_llm !== undefined) {
    fields.push(`details_for_llm = $${idx++}`);
    vals.push(input.details_for_llm);
  }

  if (!fields.length) return null;

  fields.push('updated_at = NOW()');
  vals.push(slot, id);

  const r = await query<BotCourseRow & { id: string; price: string; position_order: string }>(
    `UPDATE bot_courses SET ${fields.join(', ')} WHERE slot = $${idx++} AND id = $${idx} RETURNING *`,
    vals,
  );
  return r.rows[0] ? mapRow(r.rows[0]) : null;
}

/**
 * Remove um curso pelo id (DELETE físico).
 * A API valida se há bot_media vinculadas antes de chamar esta função.
 * Retorna true se deletou, false se não encontrou.
 */
export async function deleteCourse(slot: string, id: number): Promise<boolean> {
  const r = await query<{ id: string }>(
    'DELETE FROM bot_courses WHERE slot = $1 AND id = $2 RETURNING id',
    [slot, id],
  );
  return r.rows.length > 0;
}

/**
 * Lista mídias vinculadas a um curso (course_slug).
 * Retorna apenas id e position para uso na validação de delete.
 */
export async function listMediaByCourseSlug(
  slot: string,
  courseSlug: string,
): Promise<Array<{ id: number; position: string }>> {
  const r = await query<{ id: string; position: string }>(
    'SELECT id, position FROM bot_media WHERE slot = $1 AND course_slug = $2',
    [slot, courseSlug],
  );
  return r.rows.map((row) => ({ id: Number(row.id), position: row.position }));
}
