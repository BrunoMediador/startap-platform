/**
 * Regressão de TIPO do dual-write de tenant_id (ADR 0018, Fase 2).
 *
 * Bug P0 (2026-06-14): as queries de dual-write reusavam o MESMO placeholder ($1)
 * em dois contextos de tipo distintos — o `slot` no alvo do INSERT
 * (bot_prompt.slot/bot_media.slot = varchar(50)) e o `slot` do subselect
 * `(SELECT tenant_id FROM flow_clones WHERE slot = $1)` (flow_clones.slot =
 * varchar(80)). O Postgres 16 deduz tipos conflitantes pro mesmo parâmetro e
 * lança "inconsistent types deduced for parameter $1" → a query FALHA. Isso
 * quebrava o signup self-service (regerarPromptClone + billing) e o salvar
 * perfil "Meu negócio" (updateClone re-render do bot_prompt).
 *
 * Fix: o `slot` do subselect passou a ser um parâmetro SEPARADO, de modo que
 * cada placeholder viva em UM único contexto de tipo. Estes testes pinam o
 * invariante: NENHUM placeholder usado no subselect de tenant_id pode ser o
 * mesmo $1 do alvo do INSERT, e o array de params cobre todos os placeholders.
 *
 * `../client.js` é MOCKADO — não toca banco.
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

import { insertPendingCharge } from './billing-charges.js';
import { createCourse } from './bot-courses.js';
import { upsertMedia } from './bot-media.js';
import { setPrompt } from './bot-prompt.js';
import { registerPayment, upsertBilling } from './client-billing.js';

beforeEach(() => {
  queryMock.mockReset();
  connectMock.mockReset();
  // default: toda query devolve 0 linhas (suficiente p/ inspecionar SQL+params).
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
});

/** Acha o índice (1-based) do placeholder usado no subselect de tenant_id. */
function subselectSlotPlaceholder(sql: string): number {
  const norm = sql.replace(/\s+/g, ' ');
  const m = norm.match(/SELECT tenant_id FROM flow_clones WHERE slot = \$(\d+)/);
  expect(m, `subselect de tenant_id não encontrado em: ${norm}`).not.toBeNull();
  return Number((m as RegExpMatchArray)[1]);
}

/** Maior índice de placeholder ($N) presente no SQL. */
function maxPlaceholder(sql: string): number {
  const nums = [...sql.matchAll(/\$(\d+)/g)].map((x) => Number(x[1]));
  return Math.max(...nums);
}

/**
 * Invariante anti-regressão: a query NÃO pode reusar $1 entre o alvo do INSERT
 * e o subselect de tenant_id, e o array de params precisa cobrir todo $N.
 */
function assertDualWriteTypeSafe(sql: string, params: unknown[], expectedSlot: string): void {
  const subselectIdx = subselectSlotPlaceholder(sql);
  // 1) o subselect NUNCA reusa $1 (o slot do alvo do INSERT).
  expect(subselectIdx, 'subselect de tenant_id NÃO pode reusar $1').toBeGreaterThan(1);
  // 2) o param do subselect existe e é o mesmo valor de slot.
  expect(params).toHaveLength(maxPlaceholder(sql));
  expect(params[subselectIdx - 1]).toBe(expectedSlot);
  // 3) $1 (alvo do INSERT) também é o slot — mesmo valor, contexto de tipo distinto.
  expect(params[0]).toBe(expectedSlot);
}

function lastCall(): [string, unknown[]] {
  const calls = queryMock.mock.calls;
  return calls[calls.length - 1] as [string, unknown[]];
}

describe('dual-write tenant_id: nenhum site reusa $1 entre INSERT e subselect', () => {
  it('setPrompt (bot_prompt) — quebrava o salvar perfil/signup', async () => {
    const slot = 'clone_cirilobarbearia_c8w2f0';
    await setPrompt(slot, 'persona nova');
    const [sql, params] = lastCall();
    expect(sql).toContain('INSERT INTO bot_prompt');
    assertDualWriteTypeSafe(sql, params, slot);
  });

  it('upsertMedia (bot_media) — slot varchar(50) vs flow_clones varchar(80)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: '1', position_order: '0' }],
      rowCount: 1,
    });
    const slot = 'clone_cirilobarbearia_c8w2f0';
    await upsertMedia({ slot, position: 'intro', url: 'http://x/y.mp4' });
    const [sql, params] = lastCall();
    expect(sql).toContain('INSERT INTO bot_media');
    assertDualWriteTypeSafe(sql, params, slot);
  });

  it('createCourse (bot_courses)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: '1', price: '0', position_order: '0' }],
      rowCount: 1,
    });
    const slot = 'clone_curso_x';
    await createCourse({ slot, course_slug: 'corte', name: 'Corte' });
    const [sql, params] = lastCall();
    expect(sql).toContain('INSERT INTO bot_courses');
    assertDualWriteTypeSafe(sql, params, slot);
  });

  it('upsertBilling (client_billing)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ slot: 'clone_x' }], rowCount: 1 });
    const slot = 'clone_x';
    await upsertBilling({ slot, amountCents: 8500 });
    const [sql, params] = lastCall();
    expect(sql).toContain('INSERT INTO client_billing');
    assertDualWriteTypeSafe(sql, params, slot);
  });

  it('registerPayment (client_billing) — só $2 antes; subselect ganha placeholder próprio', async () => {
    // getBillingBySlot (1ª query) -> sem linha; depois o INSERT.
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    queryMock.mockResolvedValueOnce({ rows: [{ slot: 'clone_x' }], rowCount: 1 });
    const slot = 'clone_x';
    await registerPayment({ slot });
    const [sql, params] = lastCall();
    expect(sql).toContain('INSERT INTO client_billing');
    assertDualWriteTypeSafe(sql, params, slot);
  });

  it('insertPendingCharge (billing_charges)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ slot: 'clone_x', cycle: '2026-06' }],
      rowCount: 1,
    });
    const slot = 'clone_x';
    await insertPendingCharge({ query: queryMock } as unknown as PoolClient, {
      slot,
      cycle: '2026-06',
      externalId: 'clone_x-2026-06',
      amountCents: 8500,
    });
    const [sql, params] = lastCall();
    expect(sql).toContain('INSERT INTO billing_charges');
    assertDualWriteTypeSafe(sql, params, slot);
  });
});

describe('dual-write tenant_id: NULL-safe preservado (semântica inalterada)', () => {
  it('slot de plataforma sem clone: subselect devolve NULL e o INSERT não quebra', async () => {
    // o subselect inline resolve NULL no próprio banco; aqui só garantimos que a
    // função não lança quando a query "executa" normalmente.
    const slot = 'startap';
    await expect(setPrompt(slot, 'persona da Lola')).resolves.toBeUndefined();
    const [sql, params] = lastCall();
    assertDualWriteTypeSafe(sql, params, slot);
    // COALESCE de preservação do tenant_id existente continua presente.
    expect(sql).toContain('COALESCE(bot_prompt.tenant_id, EXCLUDED.tenant_id)');
  });
});
