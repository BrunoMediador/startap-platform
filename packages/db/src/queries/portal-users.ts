/**
 * portal-users — CRUD e auth dos usuarios do Portal do Cliente (ADR 0012, Decisao 2).
 *
 * A camada de DB NUNCA gera nem compara hash — ela so persiste/le `password_hash`.
 * bcrypt (cost 12) e aplicado na camada de aplicacao (painel-admin cria/reseta;
 * portal-api compara no login). Assim o pacote @startap/db nao ganha dep nativa.
 *
 * Modelagem: portal_users (credenciais) + portal_user_clones (vinculo user->slot).
 * Na v1, 1 user => 1 slot (travado por ux_portal_user_single_clone_v1).
 */
import { pool, query } from '../client.js';

export interface PortalUserRow {
  id: number;
  slot: string;
  username: string;
  display_name: string | null;
  active: boolean;
  must_change_password: boolean;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Linha completa de auth — inclui password_hash e estado de lockout. So uso interno do login. */
export interface PortalUserAuthRow extends PortalUserRow {
  password_hash: string;
  failed_attempts: number;
  locked_until: Date | null;
}

function normalize(row: PortalUserRow & { id: string | number }): PortalUserRow {
  return { ...row, id: Number(row.id) };
}

// ---------------------------------------------------------------------------
// CRUD (usado pelo painel-admin)
// ---------------------------------------------------------------------------

/**
 * Cria um user do portal e vincula ao slot (1:1 na v1, em transacao).
 * `passwordHash` ja vem hasheado (bcrypt cost 12) pela camada de aplicacao.
 */
export async function createPortalUser(input: {
  slot: string;
  username: string;
  passwordHash: string;
  displayName?: string | null;
  mustChangePassword?: boolean;
}): Promise<PortalUserRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query<PortalUserRow & { id: string }>(
      `INSERT INTO portal_users
         (slot, username, password_hash, display_name, must_change_password, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       RETURNING id, slot, username, display_name, active, must_change_password,
                 last_login_at, created_at, updated_at`,
      [
        input.slot,
        input.username,
        input.passwordHash,
        input.displayName ?? null,
        input.mustChangePassword ?? true,
      ],
    );
    const user = r.rows[0];
    await client.query(
      `INSERT INTO portal_user_clones (user_id, slot, role, created_at)
       VALUES ($1, $2, 'owner', NOW())
       ON CONFLICT (user_id, slot) DO NOTHING`,
      [Number(user.id), input.slot],
    );
    await client.query('COMMIT');
    return normalize(user);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Lista todos os users do portal (sem hash), mais recentes primeiro. */
export async function listPortalUsers(): Promise<PortalUserRow[]> {
  const r = await query<PortalUserRow & { id: string }>(
    `SELECT id, slot, username, display_name, active, must_change_password,
            last_login_at, created_at, updated_at
     FROM portal_users
     ORDER BY created_at DESC`,
  );
  return r.rows.map(normalize);
}

export async function getPortalUserById(id: number): Promise<PortalUserRow | null> {
  const r = await query<PortalUserRow & { id: string }>(
    `SELECT id, slot, username, display_name, active, must_change_password,
            last_login_at, created_at, updated_at
     FROM portal_users WHERE id = $1`,
    [id],
  );
  return r.rows[0] ? normalize(r.rows[0]) : null;
}

/**
 * Lista (id, username) de TODOS os users — base do matching por forma CANONICA
 * de telefone (dedup do signup + fallback do login), feito em JS na camada de
 * aplicacao (canonicalE164 vive em @startap/core; SQL nao canonicaliza).
 *
 * v1: full scan aceitavel — portal_users e minuscula (1 row por cliente) e os
 * callers sao rate-limited. Quando escalar: trocar por coluna username_canonical
 * indexada (gerada no INSERT) e aposentar esta funcao.
 */
export async function listPortalUsernames(): Promise<Array<{ id: number; username: string }>> {
  const r = await query<{ id: string; username: string }>('SELECT id, username FROM portal_users');
  return r.rows.map((row) => ({ id: Number(row.id), username: row.username }));
}

/** Verdadeiro se o username (case-insensitive) ja existe. */
export async function usernameExists(username: string): Promise<boolean> {
  const r = await query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM portal_users WHERE lower(username) = lower($1)',
    [username],
  );
  return Number(r.rows[0]?.count ?? 0) > 0;
}

/** Ativa/desativa o user. Desativar tambem reseta lockout. */
export async function setPortalUserActive(
  id: number,
  active: boolean,
): Promise<PortalUserRow | null> {
  const r = await query<PortalUserRow & { id: string }>(
    `UPDATE portal_users
       SET active = $2,
           failed_attempts = CASE WHEN $2 THEN failed_attempts ELSE 0 END,
           locked_until = CASE WHEN $2 THEN locked_until ELSE NULL END,
           updated_at = NOW()
     WHERE id = $1
     RETURNING id, slot, username, display_name, active, must_change_password,
               last_login_at, created_at, updated_at`,
    [id, active],
  );
  return r.rows[0] ? normalize(r.rows[0]) : null;
}

/**
 * Reseta a senha (hash ja calculado pelo chamador). Marca must_change_password
 * e limpa lockout para o user conseguir entrar com a senha nova.
 */
export async function resetPortalUserPassword(
  id: number,
  passwordHash: string,
): Promise<PortalUserRow | null> {
  const r = await query<PortalUserRow & { id: string }>(
    `UPDATE portal_users
       SET password_hash = $2,
           must_change_password = TRUE,
           failed_attempts = 0,
           locked_until = NULL,
           updated_at = NOW()
     WHERE id = $1
     RETURNING id, slot, username, display_name, active, must_change_password,
               last_login_at, created_at, updated_at`,
    [id, passwordHash],
  );
  return r.rows[0] ? normalize(r.rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Auth (usado pelo portal-api)
// ---------------------------------------------------------------------------

/** Busca user por username (case-insensitive) com campos de auth. Null se nao existe. */
export async function findPortalUserForAuth(username: string): Promise<PortalUserAuthRow | null> {
  const r = await query<PortalUserAuthRow & { id: string }>(
    `SELECT id, slot, username, password_hash, display_name, active, must_change_password,
            failed_attempts, locked_until, last_login_at, created_at, updated_at
     FROM portal_users
     WHERE lower(username) = lower($1)`,
    [username],
  );
  if (!r.rows[0]) return null;
  return { ...r.rows[0], id: Number(r.rows[0].id) };
}

/** Busca user por id com campos de auth (inclui hash). So uso interno (troca de senha self-service). */
export async function findPortalUserAuthById(id: number): Promise<PortalUserAuthRow | null> {
  const r = await query<PortalUserAuthRow & { id: string }>(
    `SELECT id, slot, username, password_hash, display_name, active, must_change_password,
            failed_attempts, locked_until, last_login_at, created_at, updated_at
     FROM portal_users
     WHERE id = $1`,
    [id],
  );
  if (!r.rows[0]) return null;
  return { ...r.rows[0], id: Number(r.rows[0].id) };
}

/**
 * Troca de senha pelo proprio user (self-service). Diferente de resetPortalUserPassword:
 * limpa must_change_password (FALSE) pois o user escolheu a senha conscientemente.
 * Hash ja vem calculado pela camada de aplicacao (portal-api, mesmo bcrypt cost).
 */
export async function changePortalUserPassword(
  id: number,
  passwordHash: string,
): Promise<PortalUserRow | null> {
  const r = await query<PortalUserRow & { id: string }>(
    `UPDATE portal_users
       SET password_hash = $2,
           must_change_password = FALSE,
           updated_at = NOW()
     WHERE id = $1
     RETURNING id, slot, username, display_name, active, must_change_password,
               last_login_at, created_at, updated_at`,
    [id, passwordHash],
  );
  return r.rows[0] ? normalize(r.rows[0]) : null;
}

/**
 * Resolve o slot do user a partir de portal_user_clones (fonte do withTenant).
 * Na v1 retorna no maximo 1 slot. Null se o user nao tem vinculo ou esta inativo.
 */
export async function getSlotForActivePortalUser(userId: number): Promise<string | null> {
  const r = await query<{ slot: string }>(
    `SELECT puc.slot
     FROM portal_user_clones puc
     JOIN portal_users pu ON pu.id = puc.user_id
     WHERE puc.user_id = $1 AND pu.active = TRUE
     LIMIT 1`,
    [userId],
  );
  return r.rows[0]?.slot ?? null;
}

/** Registra login bem-sucedido: zera lockout e grava last_login_at. */
export async function recordSuccessfulLogin(id: number): Promise<void> {
  await query(
    `UPDATE portal_users
       SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [id],
  );
}

/**
 * Registra tentativa falha: incrementa failed_attempts. Ao atingir `maxAttempts`,
 * grava locked_until = now() + lockMinutes e zera o contador. Retorna o novo estado.
 */
export async function recordFailedLogin(
  id: number,
  maxAttempts: number,
  lockMinutes: number,
): Promise<{ failed_attempts: number; locked_until: Date | null }> {
  const r = await query<{ failed_attempts: number; locked_until: Date | null }>(
    `UPDATE portal_users
       SET failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END,
           locked_until = CASE
             WHEN failed_attempts + 1 >= $2 THEN NOW() + ($3 || ' minutes')::interval
             ELSE locked_until
           END,
           updated_at = NOW()
     WHERE id = $1
     RETURNING failed_attempts, locked_until`,
    [id, maxAttempts, String(lockMinutes)],
  );
  return r.rows[0] ?? { failed_attempts: 0, locked_until: null };
}
