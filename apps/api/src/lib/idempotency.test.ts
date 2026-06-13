/**
 * Testa o dedup de evento de mensagem (ADR 0019, passo 2).
 *
 * Caminhos cobertos (DoD do ADR):
 *  - chave NOVA (SET NX retorna 'OK')   -> nao e duplicata -> chamador PROCESSA.
 *  - chave EXISTE (SET NX retorna null) -> e duplicata     -> chamador PULA.
 *  - Redis DOWN/erro/timeout            -> FAIL-OPEN (degraded, nao duplicata).
 *  - sem messageId                      -> FAIL-OPEN (nao da pra deduplicar).
 *
 * Mocka ../config.js (TTL/timeout) e ./redis.js (getRedis) para isolar a logica
 * pura — nao toca Redis real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
}));

vi.mock('../config.js', () => ({
  config: {
    IDEMPOTENCY_DEDUP_TTL_SECONDS: 300,
    IDEMPOTENCY_REDIS_TIMEOUT_MS: 500,
  },
}));

vi.mock('./redis.js', () => ({
  getRedis: () => ({ set: mocks.set }),
}));

const { checkAndMarkDuplicate } = await import('./idempotency.js');

describe('checkAndMarkDuplicate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('chave nova (SET NX -> OK) => nao duplicata, processa', async () => {
    mocks.set.mockResolvedValue('OK');
    const r = await checkAndMarkDuplicate('teste', 'msg-1');
    expect(r).toEqual({ duplicate: false, degraded: false });
    // Confirma o primitivo: SET key 1 EX <ttl> NX
    expect(mocks.set).toHaveBeenCalledWith('dedup:msg:teste:msg-1', '1', 'EX', 300, 'NX');
  });

  it('chave ja existe (SET NX -> null) => duplicata, pula', async () => {
    mocks.set.mockResolvedValue(null);
    const r = await checkAndMarkDuplicate('teste', 'msg-1');
    expect(r).toEqual({ duplicate: true, degraded: false });
  });

  it('Redis down (set rejeita) => FAIL-OPEN (nao duplicata, degraded)', async () => {
    mocks.set.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await checkAndMarkDuplicate('teste', 'msg-1');
    expect(r).toEqual({ duplicate: false, degraded: true });
  });

  it('Redis timeout => FAIL-OPEN (nao duplicata, degraded)', async () => {
    // set que nunca resolve -> o withTimeout interno estoura e rejeita.
    mocks.set.mockReturnValue(new Promise(() => {}));
    const r = await checkAndMarkDuplicate('teste', 'msg-1');
    expect(r).toEqual({ duplicate: false, degraded: true });
  });

  it('sem messageId => FAIL-OPEN (nao chama Redis)', async () => {
    const r = await checkAndMarkDuplicate('teste', '');
    expect(r).toEqual({ duplicate: false, degraded: true });
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
