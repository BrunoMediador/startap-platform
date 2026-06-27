/**
 * colaborador-auth — credenciais de LOGIN do COLABORADOR (barbeiro) de um cliente
 * ESTABELECIMENTO no Portal do Cliente (SCRUM-32, migration 065).
 *
 * A camada de DB NUNCA gera nem compara hash — só persiste/lê `password_hash`. bcrypt
 * (cost 12) é aplicado na camada de aplicação (painel-admin gera no "GERAR SENHA";
 * portal-api compara no login). Mesmo contrato de portal-users.ts.
 *
 * ISOLAMENTO (regra de ouro 5, ADR 0018): toda leitura escopa por colaborador (PK) e
 * carrega slot + tenant_id pro caller carimbar/filtrar. O portal NUNCA aceita
 * colaborador_id/slot de input — vem SEMPRE da sessão (anti-IDOR).
 *
 * A linha de auth SÓ é válida pra login enquanto o colaborador está ATIVO em
 * clone_colaboradores (cc.ativo) E a credencial está ativa (ca.active): desativar o
 * colaborador no painel derruba o login (defesa em profundidade — o portal recheca).
 */
import { query } from '../client.js';

/** Linha de auth do colaborador (join colaborador_auth + clone_colaboradores). */
export interface ColaboradorAuthRow {
  /** clone_colaboradores.id — a identidade do colaborador (e PK de colaborador_auth). */
  colaborador_id: number;
  slot: string;
  tenant_id: string;
  username: string;
  /** Nome do colaborador (clone_colaboradores.nome) — display do painel. */
  nome: string;
  password_hash: string;
  /** Credencial ativa (colaborador_auth.active). */
  active: boolean;
  /** Colaborador ativo no estabelecimento (clone_colaboradores.ativo). */
  colaborador_ativo: boolean;
  failed_attempts: number;
  locked_until: Date | null;
}

interface ColaboradorAuthRaw extends Omit<ColaboradorAuthRow, 'colaborador_id'> {
  colaborador_id: string | number;
}

function normalize(row: ColaboradorAuthRaw): ColaboradorAuthRow {
  return { ...row, colaborador_id: Number(row.colaborador_id) };
}

// Colunas do join — a auth (ca) + nome/ativo do colaborador (cc). NUNCA expõe o
// gcal_calendar_id nem outros campos sensíveis aqui (só o necessário pro login).
const SELECT_AUTH_COLS = `
  ca.colaborador_id, ca.slot, ca.tenant_id, ca.username, ca.password_hash,
  ca.active, cc.nome, cc.ativo AS colaborador_ativo, ca.failed_attempts, ca.locked_until`;

/**
 * Busca a credencial por username (case-insensitive) pro LOGIN. Junta
 * clone_colaboradores pra trazer nome + ativo. Null se não existe.
 *
 * O username é GLOBALMENTE único (ux_colaborador_auth_username_global) — o login recebe
 * só o username, sem slot, então a resolução é inequívoca. O caller (portal-api) ainda
 * confere active + colaborador_ativo antes de liberar.
 */
export async function findColaboradorForAuth(username: string): Promise<ColaboradorAuthRow | null> {
  const r = await query<ColaboradorAuthRaw>(
    `SELECT ${SELECT_AUTH_COLS}
       FROM colaborador_auth ca
       JOIN clone_colaboradores cc ON cc.id = ca.colaborador_id
      WHERE lower(ca.username) = lower($1)
      LIMIT 1`,
    [username],
  );
  return r.rows[0] ? normalize(r.rows[0]) : null;
}

/**
 * Busca a credencial por colaborador_id (re-derivação defensiva do withColaborador —
 * NÃO confia no payload da sessão). Null se não existe.
 */
export async function findColaboradorAuthById(
  colaboradorId: number,
): Promise<ColaboradorAuthRow | null> {
  const r = await query<ColaboradorAuthRaw>(
    `SELECT ${SELECT_AUTH_COLS}
       FROM colaborador_auth ca
       JOIN clone_colaboradores cc ON cc.id = ca.colaborador_id
      WHERE ca.colaborador_id = $1
      LIMIT 1`,
    [colaboradorId],
  );
  return r.rows[0] ? normalize(r.rows[0]) : null;
}

/** Registra login bem-sucedido: zera lockout e grava last_login_at. */
export async function recordColaboradorSuccessfulLogin(colaboradorId: number): Promise<void> {
  await query(
    `UPDATE colaborador_auth
        SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW(), updated_at = NOW()
      WHERE colaborador_id = $1`,
    [colaboradorId],
  );
}

/**
 * Registra tentativa falha: incrementa failed_attempts. Ao atingir `maxAttempts`, grava
 * locked_until = now() + lockMinutes e zera o contador. Retorna o novo estado. MESMA
 * lógica de portal_users.recordFailedLogin.
 */
export async function recordColaboradorFailedLogin(
  colaboradorId: number,
  maxAttempts: number,
  lockMinutes: number,
): Promise<{ failed_attempts: number; locked_until: Date | null }> {
  const r = await query<{ failed_attempts: number; locked_until: Date | null }>(
    `UPDATE colaborador_auth
        SET failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END,
            locked_until = CASE
              WHEN failed_attempts + 1 >= $2 THEN NOW() + ($3 || ' minutes')::interval
              ELSE locked_until
            END,
            updated_at = NOW()
      WHERE colaborador_id = $1
      RETURNING failed_attempts, locked_until`,
    [colaboradorId, maxAttempts, String(lockMinutes)],
  );
  return r.rows[0] ?? { failed_attempts: 0, locked_until: null };
}

/**
 * Lê os usernames JÁ EXISTENTES (lower-case) — base da desambiguação por sufixo na
 * geração de credencial (painel-admin). `exceptColaboradorId` exclui a própria linha
 * (regenerar não colide consigo mesma). v1: full scan (tabela minúscula).
 */
export async function listTakenUsernames(exceptColaboradorId?: number): Promise<string[]> {
  const r =
    exceptColaboradorId != null
      ? await query<{ u: string }>(
          'SELECT lower(username) AS u FROM colaborador_auth WHERE colaborador_id <> $1',
          [exceptColaboradorId],
        )
      : await query<{ u: string }>('SELECT lower(username) AS u FROM colaborador_auth');
  return r.rows.map((row) => row.u);
}

/**
 * Cria OU regenera a credencial de um colaborador (idempotente pela PK colaborador_id).
 * `passwordHash` já vem hasheado (bcrypt cost 12) pela camada de aplicação. Regenerar
 * INVALIDA a senha anterior (novo hash sobrescreve), reseta lockout e reativa
 * (active=TRUE). slot/tenant_id vêm resolvidos do clone pelo CALLER, nunca de input.
 */
export async function upsertCredentials(input: {
  colaboradorId: number;
  slot: string;
  tenantId: string;
  username: string;
  passwordHash: string;
}): Promise<{ colaborador_id: number; username: string }> {
  const r = await query<{ colaborador_id: string | number; username: string }>(
    `INSERT INTO colaborador_auth
       (colaborador_id, slot, tenant_id, username, password_hash, active,
        failed_attempts, locked_until, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, TRUE, 0, NULL, NOW(), NOW())
     ON CONFLICT (colaborador_id) DO UPDATE
       SET username = EXCLUDED.username,
           password_hash = EXCLUDED.password_hash,
           active = TRUE,
           failed_attempts = 0,
           locked_until = NULL,
           updated_at = NOW()
     RETURNING colaborador_id, username`,
    [input.colaboradorId, input.slot, input.tenantId, input.username, input.passwordHash],
  );
  const row = r.rows[0];
  return { colaborador_id: Number(row.colaborador_id), username: row.username };
}

/**
 * Slug de um nome pra username: minúsculas, sem acento, runs de não-alfanumérico → '-',
 * sem hífen nas bordas, máx 60. PURA (testável). Vazio -> 'colaborador'. ESPELHADA em
 * painel-admin/server.js (_colabSlugify) — fonte de verdade da regra de username.
 */
export function slugifyColaboradorUsername(nome: string): string {
  const slug = String(nome ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // tira acentos (combining diacritics pós-NFD)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'colaborador';
}

/**
 * Deriva um username GLOBALMENTE único a partir do nome: slug + sufixo numérico (-2,
 * -3, ...) se o slug já estiver em uso (case-insensitive) por OUTRO colaborador. PURA
 * (testável sem banco). `takenLower` = usernames existentes em minúsculas
 * (listTakenUsernames). ESPELHADA em painel-admin/server.js (_colabDeriveUsername).
 *
 * Resolve duas colisões: (a) nome igual em OUTRO clone; (b) dois nomes distintos que
 * geram o mesmo slug ("João"/"Joao") no MESMO clone — o `takenLower` cobre os dois.
 */
export function deriveColaboradorUsername(nome: string, takenLower: Iterable<string>): string {
  const base = slugifyColaboradorUsername(nome);
  const taken = new Set<string>();
  for (const u of takenLower) taken.add(u.toLowerCase());
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const cand = `${base}-${n}`;
    if (!taken.has(cand)) return cand;
  }
  // Fallback extremo (1000 homônimos) — sufixo temporal garante unicidade.
  return `${base}-${Date.now()}`;
}
