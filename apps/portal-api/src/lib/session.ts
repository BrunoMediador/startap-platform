/**
 * Sessao no Redis (ADR 0012, Decisao 2). Cookie httpOnly assinado guarda apenas
 * um session id opaco; os dados da sessao vivem no Redis com TTL.
 *
 * Por que Redis e nao JWT: revogacao imediata. Desativar um user / inadimplencia
 * precisa derrubar a sessao na hora — basta deletar a chave no Redis.
 */
import { randomBytes } from 'node:crypto';
import { logger } from '@startap/core/logger';
import { Redis } from 'ioredis';
import { config } from '../config.js';

const log = logger.child({ service: 'portal-api', module: 'session' });

const KEY_PREFIX = 'portal:sess:';
// Indice por user: set dos session ids ativos daquele user. Permite invalidar
// as DEMAIS sessoes (troca de senha) sem SCAN no keyspace inteiro.
const USER_INDEX_PREFIX = 'portal:sess:user:';

function userIndexKey(userId: number): string {
  return USER_INDEX_PREFIX + userId;
}

/**
 * Chave de índice de sessões role-aware. OWNER usa o id do portal_users; COLABORADOR
 * (SCRUM-32) usa um namespace SEPARADO (`colab:<id>`) pra NÃO colidir com o id de um
 * portal_user homônimo no set de invalidação (um owner #7 não derruba um colaborador #7).
 */
function sessionIndexKey(data: SessionData): string {
  return data.role === 'colaborador'
    ? `${USER_INDEX_PREFIX}colab:${data.colaboradorId}`
    : userIndexKey(data.userId);
}

/** Papel do dono da sessão. Ausente = 'owner' (compat com sessões pré-SCRUM-32). */
export type SessionRole = 'owner' | 'colaborador';

export interface SessionData {
  /** owner: portal_users.id. colaborador: 0 (a identidade é colaboradorId). */
  userId: number;
  username: string;
  slot: string;
  createdAt: number;
  /**
   * Papel da sessão (SCRUM-32). Ausente/'owner' = dono (comportamento atual byte-a-byte).
   * 'colaborador' = barbeiro de estabelecimento com visão READ-ONLY escopada.
   */
  role?: SessionRole;
  /** Presente SÓ em sessão de colaborador: clone_colaboradores.id (a identidade dele). */
  colaboradorId?: number;
}

let redis: Redis | null = null;

/** Lazy singleton do cliente Redis (reuso entre requests). */
export function getRedis(): Redis {
  if (redis) return redis;
  redis = new Redis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
  });
  redis.on('error', (err) => log.error({ err: err.message }, 'Redis error'));
  return redis;
}

function newSessionId(): string {
  return randomBytes(24).toString('hex');
}

/** Cria uma sessao no Redis e retorna o id (a ser gravado no cookie). */
export async function createSession(data: SessionData): Promise<string> {
  const sid = newSessionId();
  const r = getRedis();
  await r.set(KEY_PREFIX + sid, JSON.stringify(data), 'EX', config.PORTAL_SESSION_TTL_SECONDS);
  // Indexa a sessao no set do principal (owner por userId / colaborador por colab:id).
  // TTL do set > TTL da sessao para nao expirar o indice no meio de uma sessao
  // deslizante (sliding); membros stale sao ignorados na invalidacao.
  const idxKey = sessionIndexKey(data);
  await r.sadd(idxKey, sid);
  await r.expire(idxKey, config.PORTAL_SESSION_TTL_SECONDS * 2);
  return sid;
}

/** Le a sessao do Redis. Renova o TTL (sliding) em acesso valido. */
export async function getSession(sid: string): Promise<SessionData | null> {
  if (!sid) return null;
  const raw = await getRedis().get(KEY_PREFIX + sid);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as SessionData;
    // Sliding expiration: renova o TTL a cada uso valido.
    await getRedis().expire(KEY_PREFIX + sid, config.PORTAL_SESSION_TTL_SECONDS);
    return data;
  } catch {
    return null;
  }
}

/** Destroi a sessao (logout / revogacao). Idempotente. Remove do indice do user. */
export async function destroySession(sid: string): Promise<void> {
  if (!sid) return;
  const r = getRedis();
  // Le o userId (se ainda existir) para limpar o indice tambem.
  const raw = await r.get(KEY_PREFIX + sid);
  await r.del(KEY_PREFIX + sid);
  if (raw) {
    try {
      const data = JSON.parse(raw) as SessionData;
      await r.srem(sessionIndexKey(data), sid);
    } catch {
      // payload corrompido: a sessao ja foi removida; ignora o indice.
    }
  }
}

/**
 * Invalida TODAS as sessoes do user, exceto `keepSid`. Usado na troca de senha
 * self-service (derruba outros dispositivos, mantem o atual). Retorna quantas
 * sessoes foram destruidas.
 *
 * Caveat documentado: sessoes criadas ANTES deste deploy nao estao no indice
 * (portal:sess:user:*) e expiram apenas pelo TTL normal — sao raras (TTL 7d) e
 * o caminho seguro continua sendo o usuario trocar a senha + as novas sessoes
 * ja entrarem indexadas. Sem SCAN no keyspace (barato e bounded ao user).
 */
export async function invalidateOtherUserSessions(
  userId: number,
  keepSid: string,
): Promise<number> {
  const r = getRedis();
  const sids = await r.smembers(userIndexKey(userId));
  let destroyed = 0;
  for (const sid of sids) {
    if (sid === keepSid) continue;
    const removed = await r.del(KEY_PREFIX + sid);
    await r.srem(userIndexKey(userId), sid);
    if (removed > 0) destroyed += 1;
  }
  return destroyed;
}

/** Fecha a conexao Redis (shutdown/testes). */
export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit().catch(() => {});
    redis = null;
  }
}
