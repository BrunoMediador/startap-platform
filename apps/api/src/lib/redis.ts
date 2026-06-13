/**
 * Cliente Redis singleton da API (ADR 0019, passo 1).
 *
 * A API ate hoje NAO conectava no Redis para nada funcional — o /health so dava
 * um TCP ping (routes/health.ts). Este modulo introduz o client funcional,
 * reusando a MESMA config (REDIS_HOST/REDIS_PORT/REDIS_PASSWORD) do worker e do
 * portal-api (apps/portal-api/src/lib/session.ts e o precedente direto).
 *
 * Lazy: o client so e criado quando alguem chama getRedis(). Com a flag de dedup
 * OFF (default) ninguem chama, entao a API segue sem conexao Redis — zero
 * mudanca de comportamento. So conecta quando IDEMPOTENCY_DEDUP=true.
 *
 * Resiliencia (alinhado ao padrao do portal-api):
 *  - maxRetriesPerRequest: 1 — falha rapido, nao acumula no caminho quente.
 *  - enableOfflineQueue: false — se o Redis estiver down, o comando REJEITA na
 *    hora em vez de enfileirar; quem chama trata como fail-open (processa mesmo).
 *  - erros de conexao sao logados (warn), NUNCA derrubam o processo.
 */
import { logger } from '@startap/core/logger';
import { Redis } from 'ioredis';
import { config } from '../config.js';

const log = logger.child({ module: 'redis' });

let client: Redis | null = null;

/** Lazy singleton do cliente Redis (reuso entre requests). */
export function getRedis(): Redis {
  if (client) return client;
  client = new Redis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  client.on('error', (err) => log.warn({ err: err.message }, 'Redis error'));
  client.on('connect', () => log.info('Redis conectado'));
  return client;
}

/** Para testes: injeta um client fake e zera o singleton. */
export function __setRedisForTest(fake: Redis | null): void {
  client = fake;
}
