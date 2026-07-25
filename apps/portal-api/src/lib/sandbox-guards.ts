/**
 * Guardas anti-abuso/custo do "Testar conversa" (SCRUM-101).
 *
 * O endpoint é AUTENTICADO (withTenant) — risco de custo menor que a demo anônima, mas o
 * sandbox ainda chama LLM por turno. Camadas (espelham prompt-builder-guards.ts):
 *  1. teto de turns por SESSÃO de teste — enforçado no route pelo tamanho do histórico (Zod);
 *  2. teto de mensagens/dia por TENANT (slot) — Redis INCR + EXPIRE;
 *  3. hard cap GLOBAL diário (kill-switch de custo) — Redis INCR com TTL até virar o dia.
 *
 * Contadores no Redis (auto-expiram por TTL nativo, nada a limpar). Fail-closed: erro de Redis
 * NEGA o turn (o LLM — custo real — só roda com contador confiável). O slot vem SEMPRE da sessão
 * (withTenant), nunca de input — isolamento por tenant de graça.
 *
 * LGPD: nunca loga conteúdo; só slot, blocked_reason, contadores.
 */
import type { Redis } from 'ioredis';
import { config } from '../config.js';
import { spDateKey } from './demo-guards.js';

const NS = 'sandbox:';
/** TTL folgado (> 1 dia) das chaves diárias — a chave já carrega a data, então some sozinha. */
const DAILY_TTL_SECONDS = 25 * 60 * 60;

export type SandboxBlock = 'msgs_dia_tenant' | 'cap_global_diario';

export interface SandboxGuardResult {
  ok: boolean;
  reason?: SandboxBlock;
}

/** INCR + EXPIRE (só na 1ª escrita da janela). Retorna o contador. */
async function bump(redis: Redis, key: string, ttl: number): Promise<number> {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, ttl);
  return count;
}

/**
 * Reserva 1 mensagem no orçamento (tenant/dia + cap global/dia), ANTES de chamar o LLM.
 * Fail-closed. Retorna o motivo do bloqueio pra copy canned + log.
 */
export async function reserveSandboxBudget(
  redis: Redis,
  slot: string,
): Promise<SandboxGuardResult> {
  try {
    const date = spDateKey();
    // 2. teto por tenant/dia (mais específico, corta um tenant abusivo sem afetar outros).
    const perTenant = await bump(redis, `${NS}msgs:${slot}:${date}`, DAILY_TTL_SECONDS);
    if (perTenant > config.SANDBOX_MAX_MSGS_DAY) {
      return { ok: false, reason: 'msgs_dia_tenant' };
    }
    // 3. hard cap global/dia (kill-switch de custo somando todos os tenants).
    const global = await bump(redis, `${NS}spend:${date}`, DAILY_TTL_SECONDS);
    if (global > config.SANDBOX_DAILY_CALL_CAP) {
      return { ok: false, reason: 'cap_global_diario' };
    }
    return { ok: true };
  } catch {
    // Redis down: fail-closed (não chama o LLM sem contador confiável).
    return { ok: false, reason: 'cap_global_diario' };
  }
}

/** Copy canned (SEM LLM) devolvida quando uma guarda corta o turn. UX: bloqueio gentil. */
export const SANDBOX_CANNED = {
  msgs_dia_tenant:
    'Você testou bastante o seu assistente hoje :) Dá uma pausa e continue amanhã — nada disso foi enviado a ninguém.',
  cap_global_diario: 'O modo de teste está a mil agora. Tenta de novo daqui a pouco, tá?',
  turns_sessao:
    'Esta simulação já ficou longa. Clique em "Recomeçar" pra testar do zero — lembrando que nada aqui é enviado de verdade.',
} as const;
