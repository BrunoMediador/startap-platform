/**
 * bot-courses — catálogo de cursos por slot (multi-tenant).
 *
 * Criado em Missão 006-A. CRUD completo será adicionado em 006-B.
 * Esta versão exporta apenas o tipo e a query de leitura usada pela clone factory
 * e pelo bot em 006-B.
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
}

/**
 * Retorna cursos habilitados do slot, ordenados por position_order.
 * Usado pelo bot para montar a lista de cursos disponíveis.
 */
export async function listCoursesBySlot(slot: string): Promise<BotCourseRow[]> {
  const r = await query<BotCourseRow & { id: string; price: string; position_order: string }>(
    `SELECT id, slot, course_slug, name, description, price, duration, position_order, enabled, created_at, updated_at
     FROM bot_courses
     WHERE slot = $1
     ORDER BY position_order, id`,
    [slot],
  );
  return r.rows.map((row) => ({
    ...row,
    id: Number(row.id),
    price: Number(row.price),
    position_order: Number(row.position_order),
  }));
}
