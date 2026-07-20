/**
 * Testes de botPrompt.applyGeneratedPrompt (SCRUM-92).
 *
 * O `query` e o `pool.connect()` de ../client.js são MOCKADOS — não tocam banco.
 * Prova a receita transacional SCRUM-83 extraída pro packages/db:
 *  - BEGIN → snapshot (só se mudou) → upsert bot_prompt → UPDATE prompt_custom=true → COMMIT;
 *  - o finalPrompt persistido é EXATAMENTE o passado pelo caller (garantia colada por ele);
 *  - ROLLBACK em erro (nunca deixa o prompt salvo sem versioning);
 *  - version_saved refletido no retorno.
 */
import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, connectMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  connectMock: vi.fn(),
}));

vi.mock('../client.js', () => ({
  query: queryMock,
  pool: { connect: connectMock },
}));

import { applyGeneratedPrompt } from './bot-prompt.js';

interface FakeClient extends Pick<PoolClient, 'query' | 'release'> {
  calls: Array<{ sql: string; params?: unknown[] }>;
}

/** Cria um client de transação falso que roteia por substring do SQL. */
function makeClient(opts: { currentPrompt?: string | null; maxVersion?: number }): FakeClient {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const clientQuery = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql.startsWith('ROLLBACK')) return { rows: [] };
    if (sql.startsWith('SELECT prompt FROM bot_prompt')) {
      return opts.currentPrompt == null ? { rows: [] } : { rows: [{ prompt: opts.currentPrompt }] };
    }
    if (sql.includes('MAX(version)')) return { rows: [{ m: String(opts.maxVersion ?? 0) }] };
    if (sql.startsWith('INSERT INTO bot_prompt_versions')) {
      return { rows: [{ version: (opts.maxVersion ?? 0) + 1 }], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO bot_prompt')) {
      return {
        rows: [{ slot: 'clone_x', prompt: params?.[1], updated_at: new Date('2026-07-20') }],
        rowCount: 1,
      };
    }
    if (sql.startsWith('UPDATE flow_clones SET prompt_custom')) return { rows: [], rowCount: 1 };
    return { rows: [] };
  });
  return { query: clientQuery as unknown as PoolClient['query'], release: vi.fn(), calls };
}

beforeEach(() => {
  queryMock.mockReset();
  connectMock.mockReset();
});

const FINAL = 'Você é o assistente da Barbearia X.\n\n===== REGRAS DO SISTEMA =====\ncartão + SIM';

describe('applyGeneratedPrompt', () => {
  it('roda a transação SCRUM-83 na ordem certa e persiste o finalPrompt do caller', async () => {
    const client = makeClient({ currentPrompt: 'persona antiga', maxVersion: 2 });
    connectMock.mockResolvedValue(client);

    const res = await applyGeneratedPrompt('clone_x', FINAL, 'portal:builder:cirilo');

    const seq = client.calls.map((c) => c.sql.split('\n')[0].trim());
    expect(seq[0]).toBe('BEGIN');
    expect(seq[seq.length - 1]).toBe('COMMIT');
    // snapshot pré-edição, upsert, prompt_custom sticky
    expect(client.calls.some((c) => c.sql.startsWith('INSERT INTO bot_prompt_versions'))).toBe(
      true,
    );
    const upsert = client.calls.find((c) => c.sql.startsWith('INSERT INTO bot_prompt '));
    expect(upsert?.params?.[1]).toBe(FINAL); // finalPrompt intacto, byte-a-byte
    expect(client.calls.some((c) => c.sql.startsWith('UPDATE flow_clones SET prompt_custom'))).toBe(
      true,
    );
    expect(res.version_saved).toBe(3);
    expect(res.prompt).toBe(FINAL);
    expect(client.release).toHaveBeenCalled();
  });

  it('não cria snapshot quando o prompt é idêntico ao atual', async () => {
    const client = makeClient({ currentPrompt: FINAL, maxVersion: 0 });
    connectMock.mockResolvedValue(client);

    const res = await applyGeneratedPrompt('clone_x', FINAL, 'admin');

    expect(client.calls.some((c) => c.sql.startsWith('INSERT INTO bot_prompt_versions'))).toBe(
      false,
    );
    expect(res.version_saved).toBeNull();
  });

  it('slot novo (sem prompt atual) não faz snapshot mas grava e arma prompt_custom', async () => {
    const client = makeClient({ currentPrompt: null });
    connectMock.mockResolvedValue(client);

    const res = await applyGeneratedPrompt('clone_novo', FINAL, 'admin');

    expect(client.calls.some((c) => c.sql.startsWith('INSERT INTO bot_prompt_versions'))).toBe(
      false,
    );
    expect(client.calls.some((c) => c.sql.startsWith('UPDATE flow_clones SET prompt_custom'))).toBe(
      true,
    );
    expect(res.version_saved).toBeNull();
  });

  it('ROLLBACK + rethrow quando uma query falha', async () => {
    const calls: Array<{ sql: string }> = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push({ sql });
        if (sql === 'BEGIN') return { rows: [] };
        if (sql.startsWith('SELECT prompt')) throw new Error('boom');
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValue(client as unknown as PoolClient);

    await expect(applyGeneratedPrompt('clone_x', FINAL, 'admin')).rejects.toThrow('boom');
    expect(calls.some((c) => c.sql.startsWith('ROLLBACK'))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  it('recusa finalPrompt vazio (não abre transação)', async () => {
    await expect(applyGeneratedPrompt('clone_x', '   ', 'admin')).rejects.toThrow(/vazio/);
    expect(connectMock).not.toHaveBeenCalled();
  });
});
