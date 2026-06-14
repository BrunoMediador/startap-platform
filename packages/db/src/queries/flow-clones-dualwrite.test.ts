/**
 * Regressão DEDICADA do hot path que QUEBROU em prod: updateClone re-render do
 * bot_prompt (ADR 0018, Fase 2 — dual-write tenant_id).
 *
 * Contexto (hotfix #309, 2026-06-14): o dual-write reusava o MESMO placeholder $1
 * no alvo do INSERT (bot_prompt.slot = varchar(50)) e no subselect
 * `(SELECT tenant_id FROM flow_clones WHERE slot = $1)` (flow_clones.slot =
 * varchar(80)). O Postgres 16 deduz tipos conflitantes pro mesmo parâmetro e lança
 * "inconsistent types deduced for parameter $1" → a query FALHA. Esse era
 * EXATAMENTE o caminho do botão "salvar perfil Meu negócio" do portal: quando o
 * cliente muda a personalizacao, updateClone regenera o bot_prompt a partir da
 * matriz e dispara o UPSERT com o subselect de tenant_id.
 *
 * O dualwrite-param-type.test.ts existente cobre setPrompt/upsertMedia/etc., mas
 * NÃO exercita updateClone — a função que o QA apontou como um dos dois caminhos
 * sem assertion unitária dedicada. Este teste fecha a lacuna: roda updateClone com
 * patch de personalizacao, captura o INSERT INTO bot_prompt e pina o invariante.
 * Com o padrão antigo (`slot = $1` reusado) este teste FALHARIA; com o corrigido
 * (subselect em $3) passa.
 *
 * `../client.js` é MOCKADO — não toca banco.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, connectMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  connectMock: vi.fn(),
}));

vi.mock('../client.js', () => ({
  query: queryMock,
  pool: { connect: connectMock },
}));

// invalidateTenantCache toca um cache em processo — inofensivo, mas isolamos.
vi.mock('./tenant.js', () => ({
  invalidateTenantCache: vi.fn(),
}));

import { updateClone } from './flow-clones.js';

const CLONE_ID = 42;
const CLONE_SLOT = 'clone_cirilobarbearia_c8w2f0';
const MATRIZ_SLOT = 'teste_barbearia';

/**
 * Simula a sequência de queries do updateClone quando personalizacao muda:
 *   1) UPDATE flow_clones ... RETURNING *   -> row do clone (slot do clone)
 *   2) SELECT matriz_slot FROM flow_clones  -> matriz do clone
 *   3) SELECT prompt FROM bot_prompt        -> template da matriz
 *   4) INSERT INTO bot_prompt ... (dual-write tenant_id) -> alvo da asserção
 */
function mockUpdateCloneFlow(): void {
  queryMock.mockImplementation(async (sql: string) => {
    const norm = sql.replace(/\s+/g, ' ');
    if (norm.includes('UPDATE flow_clones') && norm.includes('RETURNING *')) {
      return { rows: [{ id: String(CLONE_ID), slot: CLONE_SLOT, waha_sessao: null }], rowCount: 1 };
    }
    if (norm.includes('SELECT matriz_slot FROM flow_clones')) {
      return { rows: [{ matriz_slot: MATRIZ_SLOT }], rowCount: 1 };
    }
    if (norm.includes('SELECT prompt FROM bot_prompt')) {
      return { rows: [{ prompt: 'Oi, sou da {{nome_negocio}}.' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

/** Captura o INSERT INTO bot_prompt (o dual-write) dentre as queries emitidas. */
function botPromptInsert(): [string, unknown[]] {
  const call = queryMock.mock.calls.find(([sql]) =>
    String(sql).replace(/\s+/g, ' ').includes('INSERT INTO bot_prompt'),
  );
  expect(call, 'updateClone deveria ter feito o INSERT INTO bot_prompt (re-render)').toBeTruthy();
  return call as [string, unknown[]];
}

beforeEach(() => {
  queryMock.mockReset();
  connectMock.mockReset();
});

describe('updateClone — dual-write tenant_id NÃO reusa $1 entre INSERT e subselect (hotfix #309)', () => {
  it('re-render do bot_prompt ao mudar personalizacao usa placeholder SEPARADO no subselect', async () => {
    mockUpdateCloneFlow();

    await updateClone(CLONE_ID, { personalizacao: { nome_negocio: 'Barbearia do Cirilo' } });

    const [sql, params] = botPromptInsert();
    const norm = sql.replace(/\s+/g, ' ');

    // O subselect de tenant_id existe e NÃO pode reusar $1 (o slot do alvo do INSERT).
    const m = norm.match(/SELECT tenant_id FROM flow_clones WHERE slot = \$(\d+)/);
    expect(m, `subselect de tenant_id não encontrado em: ${norm}`).not.toBeNull();
    const subselectIdx = Number((m as RegExpMatchArray)[1]);
    // ANTI-REGRESSÃO: com o bug, o subselect era $1; o fix moveu pra $3.
    expect(
      subselectIdx,
      'subselect de tenant_id NÃO pode reusar $1 (era o bug do #309)',
    ).toBeGreaterThan(1);

    // O array de params cobre todo $N e o param do subselect é o slot do clone.
    const maxPlaceholder = Math.max(...[...norm.matchAll(/\$(\d+)/g)].map((x) => Number(x[1])));
    expect(params).toHaveLength(maxPlaceholder);
    expect(params[subselectIdx - 1]).toBe(CLONE_SLOT);
    // $1 (alvo do INSERT) também é o slot do clone — mesmo VALOR, contexto de tipo distinto.
    expect(params[0]).toBe(CLONE_SLOT);
  });

  it('semântica preservada: ON CONFLICT + COALESCE do tenant_id existente continuam no UPSERT', async () => {
    mockUpdateCloneFlow();

    await updateClone(CLONE_ID, { personalizacao: { nome_negocio: 'Outra' } });

    const [sql] = botPromptInsert();
    const norm = sql.replace(/\s+/g, ' ');
    expect(norm).toContain('ON CONFLICT (slot) DO UPDATE');
    // Não sobrescreve um tenant_id já carimbado (NULL-safe / idempotente).
    expect(norm).toContain('COALESCE(bot_prompt.tenant_id, EXCLUDED.tenant_id)');
  });

  it('sem mudar personalizacao NÃO re-renderiza bot_prompt (nenhum dual-write disparado)', async () => {
    mockUpdateCloneFlow();

    await updateClone(CLONE_ID, { displayName: 'Nome Novo' });

    const insert = queryMock.mock.calls.find(([sql]) =>
      String(sql).replace(/\s+/g, ' ').includes('INSERT INTO bot_prompt'),
    );
    expect(insert, 'sem patch de personalizacao não deve tocar bot_prompt').toBeUndefined();
  });
});
