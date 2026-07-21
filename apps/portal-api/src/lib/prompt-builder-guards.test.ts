/**
 * Testes das guardas de custo/abuso do builder conversacional (SCRUM-92).
 *
 * Redis MOCKADO (fake in-memory com INCR/EXPIRE) — nada bate em serviço real. Espelha o
 * padrão de demo-guards.test.ts. Foco no que protege o BOLSO antes do LLM:
 *  - happy path libera dentro dos dois tetos;
 *  - teto por TENANT/dia corta o slot abusivo (reason msgs_dia_tenant);
 *  - hard cap GLOBAL/dia corta o custo somado de todos (reason cap_global_diario);
 *  - FAIL-CLOSED: erro de Redis NEGA o turn (não libera o LLM sem contador confiável).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({
  PROMPT_BUILDER_MAX_MSGS_DAY: 60,
  PROMPT_BUILDER_DAILY_CALL_CAP: 2000,
  // demo-guards.js (fonte do spDateKey) também importa config — precisa existir sem quebrar.
  DEMO_IP_HASH_SALT: 'salt-de-teste',
}));
vi.mock('../config.js', () => ({ config: cfg }));

import type { Redis } from 'ioredis';
import { reserveMessageBudget } from './prompt-builder-guards.js';

/** Fake Redis mínimo: INCR + EXPIRE em Map. Opcional: força erro no incr (fail-closed). */
function fakeRedis(opts: { throwOn?: 'incr' } = {}): Redis {
  const store = new Map<string, number>();
  const r = {
    async incr(key: string): Promise<number> {
      if (opts.throwOn === 'incr') throw new Error('redis down');
      const v = (store.get(key) ?? 0) + 1;
      store.set(key, v);
      return v;
    },
    async expire(): Promise<number> {
      return 1;
    },
  };
  return r as unknown as Redis;
}

describe('reserveMessageBudget', () => {
  beforeEach(() => {
    cfg.PROMPT_BUILDER_MAX_MSGS_DAY = 60;
    cfg.PROMPT_BUILDER_DAILY_CALL_CAP = 2000;
  });

  it('libera dentro dos dois tetos (happy path)', async () => {
    const redis = fakeRedis();
    const res = await reserveMessageBudget(redis, 'clone_x');
    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
  });

  it('corta no teto por TENANT/dia — reason msgs_dia_tenant', async () => {
    cfg.PROMPT_BUILDER_MAX_MSGS_DAY = 2; // 3ª chamada do mesmo slot estoura
    cfg.PROMPT_BUILDER_DAILY_CALL_CAP = 1000; // afrouxa o global pra isolar o teto de tenant
    const redis = fakeRedis();
    expect((await reserveMessageBudget(redis, 'clone_x')).ok).toBe(true); // 1
    expect((await reserveMessageBudget(redis, 'clone_x')).ok).toBe(true); // 2
    const third = await reserveMessageBudget(redis, 'clone_x'); // 3 > 2
    expect(third.ok).toBe(false);
    expect(third.reason).toBe('msgs_dia_tenant');
  });

  it('corta no CAP GLOBAL/dia (kill-switch de custo) — reason cap_global_diario', async () => {
    cfg.PROMPT_BUILDER_MAX_MSGS_DAY = 1000; // afrouxa o per-tenant pra isolar o cap global
    cfg.PROMPT_BUILDER_DAILY_CALL_CAP = 2;
    const redis = fakeRedis();
    // Slots DIFERENTES a cada chamada: o global soma todos, o per-tenant nunca estoura.
    expect((await reserveMessageBudget(redis, 'clone_a')).ok).toBe(true); // global 1
    expect((await reserveMessageBudget(redis, 'clone_b')).ok).toBe(true); // global 2
    const third = await reserveMessageBudget(redis, 'clone_c'); // global 3 > 2
    expect(third.ok).toBe(false);
    expect(third.reason).toBe('cap_global_diario');
  });

  it('FAIL-CLOSED: erro de Redis NEGA o turn (não libera o LLM sem contador)', async () => {
    const redis = fakeRedis({ throwOn: 'incr' });
    const res = await reserveMessageBudget(redis, 'clone_x');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('cap_global_diario'); // motivo canned do caminho de erro
  });
});
