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

export interface SessionData {
  userId: number;
  username: string;
  slot: string;
  createdAt: number;
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
  await getRedis().set(
    KEY_PREFIX + sid,
    JSON.stringify(data),
    'EX',
    config.PORTAL_SESSION_TTL_SECONDS,
  );
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

/** Destroi a sessao (logout / revogacao). Idempotente. */
export async function destroySession(sid: string): Promise<void> {
  if (!sid) return;
  await getRedis().del(KEY_PREFIX + sid);
}

/** Fecha a conexao Redis (shutdown/testes). */
export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit().catch(() => {});
    redis = null;
  }
}
