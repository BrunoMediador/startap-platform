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

import {
  applyGeneratedPrompt,
  migrateCloneToCartaoRuntime,
  revertCloneCartaoRuntime,
} from './bot-prompt.js';

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

  // ── SCRUM-92 inc.2: nascer em runtime + guard anti-cartão-duplo ──────────────────
  const PERSONA_ONLY = 'Você é o assistente da Barbearia X. Simpático.';

  it('cartaoMode=runtime seta cartao_mode na MESMA transação (persona-only)', async () => {
    const client = makeClient({ currentPrompt: 'persona antiga', maxVersion: 0 });
    connectMock.mockResolvedValue(client);

    await applyGeneratedPrompt('clone_x', PERSONA_ONLY, 'portal:builder:x', 'prompt-builder', {
      cartaoMode: 'runtime',
      bakedMarker: '===== REGRAS DO SISTEMA',
    });

    const upd = client.calls.find((c) => c.sql.startsWith('UPDATE flow_clones SET prompt_custom'));
    expect(upd?.sql).toContain("cartao_mode = 'runtime'");
  });

  it('cartaoMode=runtime ABORTA se o finalPrompt ainda tem o cartão baked (bakedMarker)', async () => {
    // FINAL contém o marcador → guard dispara ANTES de abrir a transação (anti cartão duplo).
    await expect(
      applyGeneratedPrompt('clone_x', FINAL, 'x', 'prompt-builder', {
        cartaoMode: 'runtime',
        bakedMarker: '===== REGRAS DO SISTEMA',
      }),
    ).rejects.toThrow(/SEM cartão baked/);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('OFF (sem opts) NÃO toca cartao_mode — UPDATE só de prompt_custom', async () => {
    const client = makeClient({ currentPrompt: 'x', maxVersion: 0 });
    connectMock.mockResolvedValue(client);
    await applyGeneratedPrompt('clone_x', FINAL, 'admin');
    const upd = client.calls.find((c) => c.sql.startsWith('UPDATE flow_clones SET prompt_custom'));
    expect(upd?.sql).not.toContain('cartao_mode');
  });
});

// ── Migração VERBATIM pra runtime (SCRUM-92 inc.2 / ADR 0032) ──────────────────────
function makeMigrateClient(opts: {
  promptCustom?: boolean | null;
  hasClone?: boolean;
  currentPrompt?: string | null;
  maxVersion?: number;
}): FakeClient {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const q = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql.startsWith('ROLLBACK')) return { rows: [] };
    if (sql.startsWith('SELECT prompt_custom FROM flow_clones')) {
      return opts.hasClone === false
        ? { rows: [] }
        : { rows: [{ prompt_custom: opts.promptCustom ?? false }] };
    }
    if (sql.startsWith('SELECT prompt FROM bot_prompt')) {
      return opts.currentPrompt == null ? { rows: [] } : { rows: [{ prompt: opts.currentPrompt }] };
    }
    if (sql.includes('MAX(version)')) return { rows: [{ m: String(opts.maxVersion ?? 0) }] };
    if (sql.startsWith('INSERT INTO bot_prompt_versions')) {
      return { rows: [{ version: (opts.maxVersion ?? 0) + 1 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  return { query: q as unknown as PoolClient['query'], release: vi.fn(), calls };
}

describe('migrateCloneToCartaoRuntime', () => {
  it('EXCLUI prompt_custom=true (fica baked; invariante do arquiteto) e dá ROLLBACK', async () => {
    const client = makeMigrateClient({ promptCustom: true, currentPrompt: 'baked' });
    connectMock.mockResolvedValue(client);
    const res = await migrateCloneToCartaoRuntime({
      slot: 'clone_ingrid',
      personaOnlyPrompt: 'persona',
      cartaoConfig: { verbatim: 'cartão' },
      editedBy: 'script',
    });
    expect(res).toEqual({ migrated: false, skipped: 'prompt_custom' });
    expect(client.calls.some((c) => c.sql.startsWith('ROLLBACK'))).toBe(true);
    expect(client.calls.some((c) => c.sql.startsWith('UPDATE bot_prompt'))).toBe(false);
  });

  it('migra: snapshot + persona-only + cartao_mode=runtime + cartao_config + prompt_custom=true', async () => {
    const client = makeMigrateClient({
      promptCustom: false,
      currentPrompt: 'persona\n\n[CARTAO DE CONFIRMACAO]\nx',
      maxVersion: 4,
    });
    connectMock.mockResolvedValue(client);
    const res = await migrateCloneToCartaoRuntime({
      slot: 'clone_cirilo',
      personaOnlyPrompt: 'persona',
      cartaoConfig: { verbatim: '[CARTAO DE CONFIRMACAO]\nx', emojis: { marca: '💈' } },
      editedBy: 'script',
    });
    expect(res).toEqual({ migrated: true, versionSaved: 5 });
    const setPrompt = client.calls.find((c) => c.sql.startsWith('UPDATE bot_prompt SET prompt'));
    expect(setPrompt?.params?.[1]).toBe('persona');
    const setMode = client.calls.find((c) => c.sql.includes("cartao_mode = 'runtime'"));
    expect(setMode?.params?.[1]).toContain('[CARTAO DE CONFIRMACAO]');
    // ARMA prompt_custom=true na MESMA transação (arquiteto 23/07): protege do clobber do
    // re-render da matriz (updateClone) que reintroduziria o cartão baked → cartão-duplo.
    expect(setMode?.sql).toContain('prompt_custom = true');
    expect(client.calls[client.calls.length - 1].sql).toBe('COMMIT');
  });

  it('clone inexistente → skipped sem_clone', async () => {
    const client = makeMigrateClient({ hasClone: false });
    connectMock.mockResolvedValue(client);
    const res = await migrateCloneToCartaoRuntime({
      slot: 'nao_existe',
      personaOnlyPrompt: 'persona',
      cartaoConfig: {},
      editedBy: 'script',
    });
    expect(res).toEqual({ migrated: false, skipped: 'sem_clone' });
  });
});

describe('revertCloneCartaoRuntime', () => {
  function makeRevertClient(opts: {
    hasClone?: boolean;
    snapshot?: { version: number; prompt: string } | null;
  }): FakeClient {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const q = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql.startsWith('ROLLBACK')) return { rows: [] };
      if (sql.startsWith('SELECT slot FROM flow_clones')) {
        return opts.hasClone === false ? { rows: [] } : { rows: [{ slot: 's' }] };
      }
      if (sql.startsWith('SELECT version, prompt FROM bot_prompt_versions')) {
        return opts.snapshot ? { rows: [opts.snapshot] } : { rows: [] };
      }
      return { rows: [], rowCount: 1 };
    });
    return { query: q as unknown as PoolClient['query'], release: vi.fn(), calls };
  }

  it('restaura o baked do snapshot + cartao_mode=baked + limpa config + prompt_custom=false', async () => {
    const client = makeRevertClient({ snapshot: { version: 7, prompt: 'baked antigo' } });
    connectMock.mockResolvedValue(client);
    const res = await revertCloneCartaoRuntime('clone_cirilo');
    expect(res).toEqual({ reverted: true, restoredVersion: 7 });
    const setPrompt = client.calls.find((c) => c.sql.startsWith('UPDATE bot_prompt SET prompt'));
    expect(setPrompt?.params?.[1]).toBe('baked antigo');
    const setMode = client.calls.find((c) => c.sql.includes("cartao_mode = 'baked'"));
    expect(setMode).toBeDefined();
    // Revert LIMPO: desarma prompt_custom=false (valor pré-flip) junto com o restore do baked.
    expect(setMode?.sql).toContain('prompt_custom = false');
  });

  it('sem snapshot marcado → reverted:false (nada a fazer)', async () => {
    const client = makeRevertClient({ snapshot: null });
    connectMock.mockResolvedValue(client);
    const res = await revertCloneCartaoRuntime('clone_x');
    expect(res).toEqual({ reverted: false, skipped: 'sem_snapshot' });
  });
});
