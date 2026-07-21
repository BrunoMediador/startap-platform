/**
 * Estado EFÊMERO da entrevista do builder de persona no Redis (SCRUM-92, ADR 0032).
 *
 * A conversa é artefato DESCARTÁVEL de onboarding, não system-of-record — o único artefato
 * durável é o prompt APROVADO (bot_prompt + bot_prompt_versions no Postgres). Por isso vive só
 * no Redis com TTL sliding (~2h): abandono se auto-limpa (sem cron), e a transcrição não fica
 * acumulando (LGPD-friendly). Se a key expirar antes de aprovar, o dono re-roda (idempotente).
 *
 * 1 entrevista viva por slot. O slot vem SEMPRE da sessão (withTenant) — a key é escopada por
 * tenant, nunca por input.
 */
import type { Redis } from 'ioredis';
import { config } from '../config.js';

const KEY_PREFIX = 'portal:promptbuilder:';

export interface PbTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface PbDraft {
  /** Persona JÁ validada/limpa (sem dados operacionais/PII/tokens estruturais). */
  persona: string;
  nome_do_bot: string | null;
  resumo: string;
}

export interface PromptBuilderState {
  slot: string;
  nomeNegocio: string;
  area: string;
  modo: 'agenda' | 'atendente';
  turns: PbTurn[];
  draft: PbDraft | null;
  updatedAt: number;
}

function key(slot: string): string {
  return KEY_PREFIX + slot;
}

/** Lê o estado da entrevista (ou null se não há/expirou). Renova o TTL (sliding). */
export async function getState(redis: Redis, slot: string): Promise<PromptBuilderState | null> {
  const raw = await redis.get(key(slot));
  if (!raw) return null;
  try {
    const state = JSON.parse(raw) as PromptBuilderState;
    await redis.expire(key(slot), config.PROMPT_BUILDER_STATE_TTL_SECONDS);
    return state;
  } catch {
    return null;
  }
}

/** Persiste o estado com TTL sliding. */
export async function saveState(redis: Redis, state: PromptBuilderState): Promise<void> {
  state.updatedAt = Date.now();
  await redis.set(
    key(state.slot),
    JSON.stringify(state),
    'EX',
    config.PROMPT_BUILDER_STATE_TTL_SECONDS,
  );
}

/** Apaga o estado (approve concluído / reset). Idempotente. */
export async function deleteState(redis: Redis, slot: string): Promise<void> {
  await redis.del(key(slot));
}
