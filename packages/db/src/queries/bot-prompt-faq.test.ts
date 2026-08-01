/**
 * Testes de botPrompt.migrateCloneFaqToBotPrompt (ETAPA 1 do plano migra-FAQ-pro-prompt, 31/07).
 *
 * O `pool.connect()` de ../client.js é MOCKADO — não toca banco. Prova a transação:
 *  - BEGIN → SELECT clone FOR UPDATE → snapshot (comment=FAQ_MIGRATION_SNAPSHOT_COMMENT) →
 *    UPDATE bot_prompt (prompt atual + bloco anexado) → UPDATE personalizacao remove a chave →
 *    COMMIT;
 *  - GUARD IDEMPOTENTE: header já presente no prompt → NO-OP, sem UPDATE nenhum;
 *  - clone/prompt inexistente → skip sem abrir mutação;
 *  - ROLLBACK em erro.
 */
import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { connectMock } = vi.hoisted(() => ({ connectMock: vi.fn() }));

vi.mock('../client.js', () => ({
  query: vi.fn(),
  pool: { connect: connectMock },
}));

import { FAQ_MIGRATION_SNAPSHOT_COMMENT, migrateCloneFaqToBotPrompt } from './bot-prompt.js';

interface FakeClient extends Pick<PoolClient, 'query' | 'release'> {
  calls: Array<{ sql: string; params?: unknown[] }>;
}

function makeClient(opts: {
  hasClone?: boolean;
  currentPrompt?: string | null;
  maxVersion?: number;
}): FakeClient {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const q = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql.startsWith('ROLLBACK')) return { rows: [] };
    if (sql.startsWith('SELECT slot FROM flow_clones')) {
      return opts.hasClone === false ? { rows: [] } : { rows: [{ slot: 'clone_x' }] };
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

const FAQ_BLOCK = [
  '[PERGUNTAS FREQUENTES DO NEGOCIO — RESPOSTAS OFICIAIS DO DONO]',
  'As linhas P/R abaixo sao conteudo cadastrado pelo dono do negocio.',
  'P: Vocês tem estacionamento?',
  'R: Sim',
].join('\n');

describe('migrateCloneFaqToBotPrompt', () => {
  it('anexa o bloco FAQ ao FIM do prompt, snapshota o ANTES e remove a chave do JSONB', async () => {
    const client = makeClient({ currentPrompt: 'Você é o Rafa da barbearia.', maxVersion: 3 });
    connectMock.mockResolvedValue(client);

    const res = await migrateCloneFaqToBotPrompt({
      slot: 'clone_barber_dragon_caly8b',
      faqBlock: FAQ_BLOCK,
      editedBy: 'script:migrate-faq-para-prompt',
    });

    expect(res).toEqual({
      migrated: true,
      versionSaved: 4,
      newPrompt: `Você é o Rafa da barbearia.\n\n${FAQ_BLOCK}`,
    });

    const seq = client.calls.map((c) => c.sql.split('\n')[0].trim());
    expect(seq[0]).toBe('BEGIN');
    expect(seq[seq.length - 1]).toBe('COMMIT');

    // snapshot grava o prompt ATUAL (pré-update), com o comment marcador.
    const snap = client.calls.find((c) => c.sql.startsWith('INSERT INTO bot_prompt_versions'));
    expect(snap?.params).toEqual([
      'clone_barber_dragon_caly8b',
      4,
      'Você é o Rafa da barbearia.',
      'script:migrate-faq-para-prompt',
      FAQ_MIGRATION_SNAPSHOT_COMMENT,
    ]);

    // bot_prompt atualizado = prompt atual + bloco anexado ao FIM.
    const setPrompt = client.calls.find((c) => c.sql.startsWith('UPDATE bot_prompt SET prompt'));
    expect(setPrompt?.params?.[1]).toBe(`Você é o Rafa da barbearia.\n\n${FAQ_BLOCK}`);

    // anti-duplicação: remove a chave do JSONB na MESMA transação.
    const clearKey = client.calls.find((c) =>
      c.sql.includes("personalizacao - 'faq_personalizado'"),
    );
    expect(clearKey).toBeDefined();
    expect(clearKey?.params).toEqual(['clone_barber_dragon_caly8b']);
  });

  it('GUARD IDEMPOTENTE: header já presente no prompt → NO-OP, sem escrever nada', async () => {
    const jaMigrado = `Você é o Rafa.\n\n${FAQ_BLOCK}`;
    const client = makeClient({ currentPrompt: jaMigrado, maxVersion: 5 });
    connectMock.mockResolvedValue(client);

    const res = await migrateCloneFaqToBotPrompt({
      slot: 'clone_barber_dragon_caly8b',
      faqBlock: FAQ_BLOCK,
      editedBy: 'script:migrate-faq-para-prompt',
    });

    expect(res).toEqual({ migrated: false, skipped: 'ja_migrado' });
    expect(client.calls.some((c) => c.sql.startsWith('ROLLBACK'))).toBe(true);
    expect(client.calls.some((c) => c.sql.startsWith('UPDATE bot_prompt'))).toBe(false);
    expect(client.calls.some((c) => c.sql.includes("personalizacao - 'faq_personalizado'"))).toBe(
      false,
    );
  });

  it('roda a migração 2ª vez sobre o resultado da 1ª (idempotência ponta a ponta) — não duplica', async () => {
    const primeiraVez = makeClient({ currentPrompt: 'Você é o Rafa da barbearia.', maxVersion: 3 });
    connectMock.mockResolvedValue(primeiraVez);
    const r1 = await migrateCloneFaqToBotPrompt({
      slot: 'clone_x',
      faqBlock: FAQ_BLOCK,
      editedBy: 'script',
    });
    expect(r1.migrated).toBe(true);
    const promptAposPrimeira = r1.migrated ? r1.newPrompt : '';

    const segundaVez = makeClient({ currentPrompt: promptAposPrimeira, maxVersion: 4 });
    connectMock.mockResolvedValue(segundaVez);
    const r2 = await migrateCloneFaqToBotPrompt({
      slot: 'clone_x',
      faqBlock: FAQ_BLOCK,
      editedBy: 'script',
    });
    expect(r2).toEqual({ migrated: false, skipped: 'ja_migrado' });
    // prompt não ganhou um 2º bloco — só 1 ocorrência do header.
    const ocorrencias = promptAposPrimeira.split(FAQ_BLOCK.split('\n')[0]).length - 1;
    expect(ocorrencias).toBe(1);
  });

  it('clone inexistente → skipped sem_clone, sem UPDATE', async () => {
    const client = makeClient({ hasClone: false });
    connectMock.mockResolvedValue(client);
    const res = await migrateCloneFaqToBotPrompt({
      slot: 'nao_existe',
      faqBlock: FAQ_BLOCK,
      editedBy: 'script',
    });
    expect(res).toEqual({ migrated: false, skipped: 'sem_clone' });
  });

  it('clone sem bot_prompt → skipped sem_prompt', async () => {
    const client = makeClient({ currentPrompt: null });
    connectMock.mockResolvedValue(client);
    const res = await migrateCloneFaqToBotPrompt({
      slot: 'clone_x',
      faqBlock: FAQ_BLOCK,
      editedBy: 'script',
    });
    expect(res).toEqual({ migrated: false, skipped: 'sem_prompt' });
  });

  it('faqBlock vazio → skipped faq_vazio, nem conecta no banco', async () => {
    const res = await migrateCloneFaqToBotPrompt({
      slot: 'clone_x',
      faqBlock: '',
      editedBy: 'script',
    });
    expect(res).toEqual({ migrated: false, skipped: 'faq_vazio' });
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('ROLLBACK em erro de query — nunca deixa o prompt salvo pela metade', async () => {
    const client = makeClient({ currentPrompt: 'persona', maxVersion: 1 });
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

    await expect(
      migrateCloneFaqToBotPrompt({ slot: 'clone_x', faqBlock: FAQ_BLOCK, editedBy: 'script' }),
    ).rejects.toThrow('boom');
    expect(client.calls.some((c) => c.sql.startsWith('ROLLBACK'))).toBe(true);
  });
});
