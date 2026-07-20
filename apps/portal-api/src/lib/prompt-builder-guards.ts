/**
 * Guardas anti-abuso/custo do builder conversacional de persona (SCRUM-92).
 *
 * O endpoint é AUTENTICADO (withTenant) — risco de custo menor que a demo anônima, mas o
 * meta-agente ainda chama LLM por turno. Camadas (espelham demo-guards.ts):
 *  1. teto de turns por ENTREVISTA — enforçado no route pelo tamanho do estado (Redis);
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

const NS = 'promptbuilder:';
/** TTL folgado (> 1 dia) das chaves diárias — a chave já carrega a data, então some sozinha. */
const DAILY_TTL_SECONDS = 25 * 60 * 60;

export type PromptBuilderBlock = 'msgs_dia_tenant' | 'cap_global_diario';

export interface PbGuardResult {
  ok: boolean;
  reason?: PromptBuilderBlock;
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
export async function reserveMessageBudget(redis: Redis, slot: string): Promise<PbGuardResult> {
  try {
    const date = spDateKey();
    // 2. teto por tenant/dia (mais específico, corta um tenant abusivo sem afetar outros).
    const perTenant = await bump(redis, `${NS}msgs:${slot}:${date}`, DAILY_TTL_SECONDS);
    if (perTenant > config.PROMPT_BUILDER_MAX_MSGS_DAY) {
      return { ok: false, reason: 'msgs_dia_tenant' };
    }
    // 3. hard cap global/dia (kill-switch de custo somando todos os tenants).
    const global = await bump(redis, `${NS}spend:${date}`, DAILY_TTL_SECONDS);
    if (global > config.PROMPT_BUILDER_DAILY_CALL_CAP) {
      return { ok: false, reason: 'cap_global_diario' };
    }
    return { ok: true };
  } catch {
    // Redis down: fail-closed (não chama o LLM sem contador confiável).
    return { ok: false, reason: 'cap_global_diario' };
  }
}

/** Copy canned (SEM LLM) devolvida quando uma guarda corta o turn. UX: bloqueio gentil. */
export const PROMPT_BUILDER_CANNED = {
  msgs_dia_tenant:
    'Você já mexeu bastante no seu assistente hoje :) Dá uma pausa e continue amanhã — o que você aprovou já está salvo.',
  cap_global_diario: 'O montador de assistente está a mil agora. Tenta de novo daqui a pouco, tá?',
  turns_entrevista:
    'Já temos bastante coisa pra montar seu assistente! Clique em "Gerar" pra ver a prévia, ou me diga o que ajustar.',
} as const;
