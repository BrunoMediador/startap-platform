/**
 * Testa o lock de acao com efeito externo (ADR 0019, passo 3).
 *
 * Caminhos cobertos (DoD do ADR):
 *  - lock ADQUIRIDO (SET NX -> 'OK')   -> EXECUTA a action e libera (check-and-del).
 *  - lock NAO adquirido (SET NX -> null)-> PULA, NAO executa a action (1 evento, nao 2).
 *  - Redis DOWN/erro no acquire         -> FAIL-OPEN: executa a action mesmo assim.
 *  - Redis TIMEOUT no acquire           -> FAIL-OPEN: executa a action mesmo assim.
 *  - chave de lock GCal normaliza telefone (so digitos).
 *
 * Mocka ../config.js (TTL/timeout) e ./redis.js (getRedis) para isolar a logica
 * pura — nao toca Redis real, nao cria evento real no GCal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  eval: vi.fn(),
}));

vi.mock('../config.js', () => ({
  config: {
    IDEMPOTENCY_ACTION_LOCK_TTL_MS: 10000,
    IDEMPOTENCY_REDIS_TIMEOUT_MS: 500,
    ACTION_LOCK_PHONE_PEPPER: 'action-lock-pepper-test-32-bytes',
  },
}));

vi.mock('./redis.js', () => ({
  getRedis: () => ({ set: mocks.set, eval: mocks.eval }),
}));

const { withActionLock, gcalActionLockKey } = await import('./action-lock.js');

describe('withActionLock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eval.mockResolvedValue(1);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lock adquirido (SET NX -> OK) => executa a action e libera', async () => {
    mocks.set.mockResolvedValue('OK');
    const action = vi.fn().mockResolvedValue({ id: 'evt-1' });

    const r = await withActionLock('actionlock:gcal:x', action);

    expect(r).toEqual({ executed: true, value: { id: 'evt-1' }, degraded: false });
    expect(action).toHaveBeenCalledTimes(1);
    // Primitivo do acquire: SET key <token> PX <ttl> NX.
    expect(mocks.set).toHaveBeenCalledWith(
      'actionlock:gcal:x',
      expect.any(String),
      'PX',
      10000,
      'NX',
    );
    // Release: check-and-del via Lua com o mesmo token do acquire.
    const token = mocks.set.mock.calls[0][1];
    expect(mocks.eval).toHaveBeenCalledWith(expect.any(String), 1, 'actionlock:gcal:x', token);
  });

  it('lock NAO adquirido (SET NX -> null) => pula, NAO executa a action', async () => {
    mocks.set.mockResolvedValue(null);
    const action = vi.fn().mockResolvedValue({ id: 'evt-dup' });

    const r = await withActionLock('actionlock:gcal:x', action);

    expect(r).toEqual({ executed: false, degraded: false });
    expect(action).not.toHaveBeenCalled();
    // Nao adquiriu -> nao tenta liberar lock alheio.
    expect(mocks.eval).not.toHaveBeenCalled();
  });

  it('Redis down no acquire (set rejeita) => FAIL-OPEN executa a action', async () => {
    mocks.set.mockRejectedValue(new Error('ECONNREFUSED'));
    const action = vi.fn().mockResolvedValue({ id: 'evt-failopen' });

    const r = await withActionLock('actionlock:gcal:x', action);

    expect(r).toEqual({ executed: true, value: { id: 'evt-failopen' }, degraded: true });
    expect(action).toHaveBeenCalledTimes(1);
    // Nao adquiriu lock -> nao tenta liberar.
    expect(mocks.eval).not.toHaveBeenCalled();
  });

  it('Redis timeout no acquire => FAIL-OPEN executa a action', async () => {
    // set que nunca resolve -> o withTimeout interno estoura e rejeita.
    mocks.set.mockReturnValue(new Promise(() => {}));
    const action = vi.fn().mockResolvedValue({ id: 'evt-timeout' });

    const r = await withActionLock('actionlock:gcal:x', action);

    expect(r.executed).toBe(true);
    expect(r.degraded).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('release falhando nao quebra o resultado (expira por TTL)', async () => {
    mocks.set.mockResolvedValue('OK');
    mocks.eval.mockRejectedValue(new Error('redis gone'));
    const action = vi.fn().mockResolvedValue({ id: 'evt-1' });

    const r = await withActionLock('actionlock:gcal:x', action);

    expect(r.executed).toBe(true);
    expect(r.value).toEqual({ id: 'evt-1' });
  });

  it('propaga erro da PROPRIA action (nao mascara como fail-open)', async () => {
    mocks.set.mockResolvedValue('OK');
    const action = vi.fn().mockRejectedValue(new Error('GCal 403'));

    await expect(withActionLock('actionlock:gcal:x', action)).rejects.toThrow('GCal 403');
    // Mesmo com erro da action, o lock e liberado no finally.
    expect(mocks.eval).toHaveBeenCalledTimes(1);
  });
});

describe('gcalActionLockKey', () => {
  it('monta chave por slot+telefone+inicio e normaliza o telefone', () => {
    const key = gcalActionLockKey(
      'teste_barbearia',
      '+55 (35) 99174-6797@c.us',
      '2026-06-14T10:00:00-03:00',
    );
    expect(key).toMatch(/^actionlock:gcal:teste_barbearia:[a-f0-9]{64}:2026-06-14T10:00:00-03:00$/);
    expect(key).not.toContain('5535991746797');
  });

  it('mesma intencao com formatacao diferente gera a MESMA chave', () => {
    const a = gcalActionLockKey('s', '5535991746797', '2026-06-14T10:00:00-03:00');
    const b = gcalActionLockKey('s', '55 35 99174-6797', '2026-06-14T10:00:00-03:00');
    expect(a).toBe(b);
  });

  it('sem pepper dedicado desliga o lock sem criar chave com telefone em claro', async () => {
    const { config } = await import('../config.js');
    const previous = config.ACTION_LOCK_PHONE_PEPPER;
    (config as { ACTION_LOCK_PHONE_PEPPER?: string }).ACTION_LOCK_PHONE_PEPPER = undefined;
    expect(gcalActionLockKey('s', '5535991746797', '2026-06-14T10:00:00-03:00')).toBeNull();
    (config as { ACTION_LOCK_PHONE_PEPPER?: string }).ACTION_LOCK_PHONE_PEPPER = previous;
  });
});
