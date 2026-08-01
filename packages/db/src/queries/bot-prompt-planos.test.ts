/**
 * Testes de botPrompt.migrateClonePlanosToBotPrompt (migração planos_beneficios→bot_prompt, 01/08 —
 * repete a ETAPA 1 do FAQ, PR #552, com a mesma disciplina de hardening F1-F3).
 *
 * O `pool.connect()` de ../client.js é MOCKADO — não toca banco. Prova a transação:
 *  - BEGIN → SELECT flow_clones FOR UPDATE (lock primeiro) → lê planos_beneficios do
 *    personalizacao já carregado → SELECT bot_prompt FOR UPDATE → snapshot
 *    (comment=PLANOS_MIGRATION_SNAPSHOT_COMMENT) → UPDATE bot_prompt (prompt atual + bloco
 *    anexado) → UPDATE personalizacao remove a chave NO SQL (nunca via objeto JS) → COMMIT;
 *  - GUARD IDEMPOTENTE: header já presente no prompt → NO-OP, sem UPDATE nenhum;
 *  - clone inexistente / sem planos → skip sem abrir mutação;
 *  - FAIL-CLOSED: colisão de version no snapshot aborta SEM gravar bot_prompt;
 *  - ROLLBACK em erro.
 */
import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { connectMock } = vi.hoisted(() => ({ connectMock: vi.fn() }));

vi.mock('../client.js', () => ({
  query: vi.fn(),
  pool: { connect: connectMock },
}));

import {
  PLANOS_BLOCK_HEADER,
  PLANOS_MIGRATION_SNAPSHOT_COMMENT,
  migrateClonePlanosToBotPrompt,
} from './bot-prompt.js';

interface FakeClient extends Pick<PoolClient, 'query' | 'release'> {
  calls: Array<{ sql: string; params?: unknown[] }>;
}

function makeClient(opts: {
  hasClone?: boolean;
  personalizacao?: Record<string, unknown> | null;
  currentPrompt?: string | null;
  maxVersion?: number;
}): FakeClient {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const q = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql.startsWith('ROLLBACK')) return { rows: [] };
    if (sql.startsWith('SELECT personalizacao FROM flow_clones')) {
      return opts.hasClone === false
        ? { rows: [] }
        : { rows: [{ personalizacao: opts.personalizacao ?? {} }] };
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

beforeEach(() => {
  connectMock.mockReset();
});

const PLANOS_TEXTO =
  'Pacote Mensal com 4 sessões: R$ 396,00 (99,00 por sessão)\nOu 2x 198,00 quinzenalmente';

describe('migrateClonePlanosToBotPrompt', () => {
  it('anexa o texto de planos ao FIM do prompt, snapshota o ANTES e remove a chave do JSONB no SQL', async () => {
    const client = makeClient({
      personalizacao: { planos_beneficios: PLANOS_TEXTO },
      currentPrompt: 'Você é a Ingrid, psicoterapeuta.',
      maxVersion: 22,
    });
    connectMock.mockResolvedValue(client);

    const res = await migrateClonePlanosToBotPrompt(
      'clone_psicoterapeuta_ingrid_ou1cwu',
      'script:migrate-planos-para-prompt',
    );

    expect(res).toEqual({ migrated: true, versionSaved: 23 });

    const seq = client.calls.map((c) => c.sql.split('\n')[0].trim());
    expect(seq[0]).toBe('BEGIN');
    expect(seq[seq.length - 1]).toBe('COMMIT');
    // lock de flow_clones vem ANTES do lock de bot_prompt (ordem de lock do módulo).
    const idxFlow = seq.findIndex((s) => s.startsWith('SELECT personalizacao FROM flow_clones'));
    const idxPrompt = seq.findIndex((s) => s.startsWith('SELECT prompt FROM bot_prompt'));
    expect(idxFlow).toBeGreaterThanOrEqual(0);
    expect(idxPrompt).toBeGreaterThan(idxFlow);

    // snapshot grava o prompt ATUAL (pré-update), com o comment marcador.
    const snap = client.calls.find((c) => c.sql.startsWith('INSERT INTO bot_prompt_versions'));
    expect(snap?.params).toEqual([
      'clone_psicoterapeuta_ingrid_ou1cwu',
      23,
      'Você é a Ingrid, psicoterapeuta.',
      'script:migrate-planos-para-prompt',
      PLANOS_MIGRATION_SNAPSHOT_COMMENT,
    ]);

    // bot_prompt atualizado = prompt atual + bloco (header + texto byte-a-byte) ao FIM.
    const setPrompt = client.calls.find((c) => c.sql.startsWith('UPDATE bot_prompt SET prompt'));
    expect(setPrompt?.params?.[1]).toBe(
      `Você é a Ingrid, psicoterapeuta.\n\n${PLANOS_BLOCK_HEADER}\n${PLANOS_TEXTO}`,
    );
    // texto do dono preservado byte-a-byte (as 2 linhas do exemplo real).
    expect(setPrompt?.params?.[1]).toContain('R$ 396,00 (99,00 por sessão)');
    expect(setPrompt?.params?.[1]).toContain('Ou 2x 198,00 quinzenalmente');

    // anti-duplicação: remove a chave do JSONB NA MESMA transação, reconciliando NO SQL contra
    // a linha do banco (operador `-`), nunca a partir de um objeto JS montado pelo caller.
    const clearKey = client.calls.find((c) =>
      c.sql.includes("personalizacao - 'planos_beneficios'"),
    );
    expect(clearKey).toBeDefined();
    expect(clearKey?.params).toEqual(['clone_psicoterapeuta_ingrid_ou1cwu']);
  });

  it('GUARD IDEMPOTENTE: header já presente no prompt → NO-OP, sem escrever nada', async () => {
    const jaMigrado = `Você é a Ingrid.\n\n${PLANOS_BLOCK_HEADER}\n${PLANOS_TEXTO}`;
    const client = makeClient({
      personalizacao: { planos_beneficios: PLANOS_TEXTO },
      currentPrompt: jaMigrado,
      maxVersion: 23,
    });
    connectMock.mockResolvedValue(client);

    const res = await migrateClonePlanosToBotPrompt('clone_x', 'script');

    expect(res).toEqual({ migrated: false, skipped: 'ja_migrado' });
    expect(client.calls.some((c) => c.sql.startsWith('ROLLBACK'))).toBe(true);
    expect(client.calls.some((c) => c.sql.startsWith('UPDATE bot_prompt'))).toBe(false);
    expect(client.calls.some((c) => c.sql.includes("personalizacao - 'planos_beneficios'"))).toBe(
      false,
    );
  });

  it('clone inexistente → skipped sem_clone, sem UPDATE', async () => {
    const client = makeClient({ hasClone: false });
    connectMock.mockResolvedValue(client);
    const res = await migrateClonePlanosToBotPrompt('nao_existe', 'script');
    expect(res).toEqual({ migrated: false, skipped: 'sem_clone' });
    expect(client.calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
  });

  it('planos_beneficios ausente/vazio → skipped sem_planos, nunca lê bot_prompt', async () => {
    const semChave = makeClient({ personalizacao: {} });
    connectMock.mockResolvedValue(semChave);
    const r1 = await migrateClonePlanosToBotPrompt('clone_x', 'script');
    expect(r1).toEqual({ migrated: false, skipped: 'sem_planos' });
    expect(semChave.calls.some((c) => c.sql.startsWith('SELECT prompt FROM bot_prompt'))).toBe(
      false,
    );

    connectMock.mockReset();
    const vazio = makeClient({ personalizacao: { planos_beneficios: '   ' } });
    connectMock.mockResolvedValue(vazio);
    const r2 = await migrateClonePlanosToBotPrompt('clone_x', 'script');
    expect(r2).toEqual({ migrated: false, skipped: 'sem_planos' });
  });

  it('clone sem bot_prompt ainda (nunca teve prompt salvo) → bloco de planos vira o prompt inicial', async () => {
    const client = makeClient({
      personalizacao: { planos_beneficios: PLANOS_TEXTO },
      currentPrompt: null,
      maxVersion: 0,
    });
    connectMock.mockResolvedValue(client);

    const res = await migrateClonePlanosToBotPrompt('clone_novo', 'script');
    expect(res).toEqual({ migrated: true, versionSaved: 1 });

    const setPrompt = client.calls.find((c) => c.sql.startsWith('UPDATE bot_prompt SET prompt'));
    expect(setPrompt?.params?.[1]).toBe(`${PLANOS_BLOCK_HEADER}\n${PLANOS_TEXTO}`);
  });

  it('SELECT prompt FROM bot_prompt usa FOR UPDATE (mesmo hardening F2 do FAQ)', async () => {
    const client = makeClient({
      personalizacao: { planos_beneficios: PLANOS_TEXTO },
      currentPrompt: 'persona',
      maxVersion: 1,
    });
    connectMock.mockResolvedValue(client);
    await migrateClonePlanosToBotPrompt('clone_x', 'script');
    const selectPrompt = client.calls.find((c) =>
      c.sql.startsWith('SELECT prompt FROM bot_prompt'),
    );
    expect(selectPrompt?.sql).toMatch(/FOR UPDATE/);
  });

  it('SELECT ... FROM flow_clones usa FOR UPDATE (lock primeiro, ordem do módulo)', async () => {
    const client = makeClient({
      personalizacao: { planos_beneficios: PLANOS_TEXTO },
      currentPrompt: 'persona',
      maxVersion: 1,
    });
    connectMock.mockResolvedValue(client);
    await migrateClonePlanosToBotPrompt('clone_x', 'script');
    const selectClone = client.calls.find((c) =>
      c.sql.startsWith('SELECT personalizacao FROM flow_clones'),
    );
    expect(selectClone?.sql).toMatch(/FOR UPDATE/);
  });

  it('FAIL-CLOSED: colisão de version no snapshot aborta SEM gravar bot_prompt (sem backup = sem migração)', async () => {
    const client = makeClient({
      personalizacao: { planos_beneficios: PLANOS_TEXTO },
      currentPrompt: 'persona',
      maxVersion: 1,
    });
    const originalQuery = client.query as unknown as (
      sql: string,
      params?: unknown[],
    ) => Promise<{ rows: unknown[]; rowCount?: number }>;
    client.query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.startsWith('INSERT INTO bot_prompt_versions')) {
        // Simula corrida concorrente: nenhuma linha gravada (sem ON CONFLICT DO NOTHING aqui —
        // é o próprio guard fail-closed que decide não seguir).
        return { rows: [], rowCount: 0 };
      }
      return originalQuery(sql, params);
    }) as unknown as PoolClient['query'];
    connectMock.mockResolvedValue(client);

    await expect(migrateClonePlanosToBotPrompt('clone_x', 'script')).rejects.toThrow(
      /colidiu em version/,
    );
    expect(client.calls.some((c) => c.sql.startsWith('ROLLBACK'))).toBe(true);
    expect(client.calls.some((c) => c.sql.startsWith('UPDATE bot_prompt SET prompt'))).toBe(false);
    expect(client.calls.some((c) => c.sql.includes("personalizacao - 'planos_beneficios'"))).toBe(
      false,
    );
  });

  it('ROLLBACK em erro de query — nunca deixa o prompt salvo pela metade', async () => {
    const client = makeClient({
      personalizacao: { planos_beneficios: PLANOS_TEXTO },
      currentPrompt: 'persona',
      maxVersion: 1,
    });
    const originalQuery = client.query as unknown as (
      sql: string,
      params?: unknown[],
    ) => Promise<unknown>;
    client.query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.startsWith('UPDATE bot_prompt SET prompt')) {
        throw new Error('boom');
      }
      return originalQuery(sql, params);
    }) as unknown as PoolClient['query'];
    connectMock.mockResolvedValue(client);

    await expect(migrateClonePlanosToBotPrompt('clone_x', 'script')).rejects.toThrow('boom');
    expect(client.calls.some((c) => c.sql.startsWith('ROLLBACK'))).toBe(true);
  });
});
