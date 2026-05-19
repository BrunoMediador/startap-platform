/**
 * Testa o comportamento do cache TTL de flow-clones.
 * Usa vi.useFakeTimers() para controlar Date.now() sem depender de DB real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
}));

// Importação dinâmica após mock para garantir que o módulo usa o mock
const { getCloneBySession, getCloneBySlot, invalidateCloneCache } = await import('./flow-clones.js');

const FAKE_ROW = {
  id: '1',
  slot: 'clone_test_abc123',
  matriz_slot: 'barbearia',
  display_name: 'Teste',
  cliente_nome: null,
  cliente_telefone: null,
  personalizacao: {},
  waha_sessao: 'sessao_teste',
  status: 'conectado' as const,
  created_at: new Date(),
  updated_at: new Date(),
};

describe('flow-clones cache TTL', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invalidateCloneCache();
    mockQuery.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('getCloneBySession: segunda chamada usa cache sem query', async () => {
    mockQuery.mockResolvedValue({ rows: [FAKE_ROW] });

    await getCloneBySession('sessao_teste');
    await getCloneBySession('sessao_teste');

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('getCloneBySession: cache expira após 60s e recarrega', async () => {
    mockQuery.mockResolvedValue({ rows: [FAKE_ROW] });

    await getCloneBySession('sessao_teste');
    vi.advanceTimersByTime(61_000);
    await getCloneBySession('sessao_teste');

    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('getCloneBySlot: segunda chamada usa cache sem query', async () => {
    mockQuery.mockResolvedValue({ rows: [FAKE_ROW] });

    await getCloneBySlot('clone_test_abc123');
    await getCloneBySlot('clone_test_abc123');

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('getCloneBySlot: cache expira após 60s e recarrega', async () => {
    mockQuery.mockResolvedValue({ rows: [FAKE_ROW] });

    await getCloneBySlot('clone_test_abc123');
    vi.advanceTimersByTime(61_000);
    await getCloneBySlot('clone_test_abc123');

    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('invalidateCloneCache por slot força nova query', async () => {
    mockQuery.mockResolvedValue({ rows: [FAKE_ROW] });

    await getCloneBySlot('clone_test_abc123');
    invalidateCloneCache({ slot: 'clone_test_abc123' });
    await getCloneBySlot('clone_test_abc123');

    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('invalidateCloneCache por sessao força nova query', async () => {
    mockQuery.mockResolvedValue({ rows: [FAKE_ROW] });

    await getCloneBySession('sessao_teste');
    invalidateCloneCache({ sessao: 'sessao_teste' });
    await getCloneBySession('sessao_teste');

    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('getCloneBySession retorna null e faz cache de null', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const first = await getCloneBySession('sessao_nao_existe');
    const second = await getCloneBySession('sessao_nao_existe');

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
