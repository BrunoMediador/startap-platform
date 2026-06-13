/**
 * Testes do dual-write de tenant_id (ADR 0018, Fase 2).
 *
 * `../client.js` é MOCKADO — não toca banco. Cobre os 3 cenários exigidos:
 *  1. Caminho feliz: slot com clone conhecido -> resolveTenantId devolve o UUID e o
 *     INSERT do hot path (model_usage) grava tenant_id.
 *  2. Slot de plataforma SEM clone (sem linha em flow_clones) -> NULL, sem erro.
 *  3. Falha na resolução (DB lança) -> NULL, NUNCA propaga (o write não quebra).
 * + cache: 2ª resolução do mesmo slot não bate no banco de novo (hot path barato).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock('../client.js', () => ({
  query: queryMock,
  pool: {},
}));

import { logUsage, summaryByPeriod } from './model-usage.js';
import { invalidateTenantCache, isTenantReadCutoverEnabled, resolveTenantId } from './tenant.js';

const TENANT_UUID = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  queryMock.mockReset();
  invalidateTenantCache(); // cada teste parte de cache limpo
});

describe('resolveTenantId', () => {
  it('caminho feliz: slot com clone conhecido resolve o tenant_id (UUID)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ tenant_id: TENANT_UUID }], rowCount: 1 });

    const tid = await resolveTenantId('clone_cirilobarbearia_c8w2f0');

    expect(tid).toBe(TENANT_UUID);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql.replace(/\s+/g, ' ')).toContain('SELECT tenant_id FROM flow_clones WHERE slot = $1');
    expect(params).toEqual(['clone_cirilobarbearia_c8w2f0']);
  });

  it('slot de plataforma sem clone (0 linhas) resolve NULL sem erro', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const tid = await resolveTenantId('startap');

    expect(tid).toBeNull();
  });

  it('falha de DB na resolução devolve NULL e NUNCA propaga (fail-safe)', async () => {
    queryMock.mockRejectedValueOnce(new Error('connection terminated'));

    // não deve lançar
    const tid = await resolveTenantId('clone_qualquer');

    expect(tid).toBeNull();
  });

  it('cacheia o resultado: 2ª chamada do mesmo slot não vai ao banco (hot path barato)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ tenant_id: TENANT_UUID }], rowCount: 1 });

    const a = await resolveTenantId('clone_x');
    const b = await resolveTenantId('clone_x'); // cache hit

    expect(a).toBe(TENANT_UUID);
    expect(b).toBe(TENANT_UUID);
    expect(queryMock).toHaveBeenCalledTimes(1); // só a 1ª bateu no DB
  });

  it('cacheia NULL: slot de plataforma não martela o banco a cada turno', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await resolveTenantId('teste_barbearia');
    await resolveTenantId('teste_barbearia');

    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('NÃO cacheia erro: após falha, a próxima chamada tenta o banco de novo', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'));
    queryMock.mockResolvedValueOnce({ rows: [{ tenant_id: TENANT_UUID }], rowCount: 1 });

    const first = await resolveTenantId('clone_y'); // erro -> null, não cacheia
    const second = await resolveTenantId('clone_y'); // tenta de novo -> resolve

    expect(first).toBeNull();
    expect(second).toBe(TENANT_UUID);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});

describe('logUsage dual-write (hot path model_usage)', () => {
  const baseInput = {
    slot: 'clone_cirilobarbearia_c8w2f0',
    provider: 'openai' as const,
    model: 'gpt-4o',
    prompt: 100,
    completion: 50,
    total: 150,
  };

  it('grava tenant_id resolvido no INSERT de model_usage (clone conhecido)', async () => {
    // 1ª query: resolveTenantId -> UUID. 2ª query: INSERT INTO model_usage.
    queryMock.mockResolvedValueOnce({ rows: [{ tenant_id: TENANT_UUID }], rowCount: 1 });
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await logUsage(baseInput);

    const insertCall = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO model_usage'),
    ) as [string, unknown[]];
    expect(insertCall[0]).toContain('tenant_id');
    // tenant_id é o ÚLTIMO parâmetro do INSERT.
    expect(insertCall[1][insertCall[1].length - 1]).toBe(TENANT_UUID);
  });

  it('slot de plataforma sem clone: INSERT grava tenant_id NULL, não quebra', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // resolve NULL
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT ok

    await expect(logUsage({ ...baseInput, slot: 'startap' })).resolves.toBeUndefined();

    const insertCall = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO model_usage'),
    ) as [string, unknown[]];
    expect(insertCall[1][insertCall[1].length - 1]).toBeNull();
  });

  it('falha ao resolver tenant_id NÃO impede o INSERT (grava NULL, fail-safe)', async () => {
    queryMock.mockRejectedValueOnce(new Error('resolve falhou')); // resolveTenantId -> null
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT segue

    await expect(logUsage(baseInput)).resolves.toBeUndefined();

    const insertCall = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO model_usage'),
    ) as [string, unknown[]];
    expect(insertCall).toBeDefined();
    expect(insertCall[1][insertCall[1].length - 1]).toBeNull();
  });
});

describe('isTenantReadCutoverEnabled (READ CUTOVER, ADR 0018 Fase 2b)', () => {
  it('OFF por default quando a env está ausente', () => {
    expect(isTenantReadCutoverEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
  it('ON só com o valor exato "true"', () => {
    expect(isTenantReadCutoverEnabled({ TENANT_READ_CUTOVER: 'true' } as NodeJS.ProcessEnv)).toBe(
      true,
    );
  });
  it('qualquer outro valor mantém OFF (safe-by-default)', () => {
    for (const v of ['1', 'TRUE', 'yes', 'on', '']) {
      expect(isTenantReadCutoverEnabled({ TENANT_READ_CUTOVER: v } as NodeJS.ProcessEnv)).toBe(
        false,
      );
    }
  });
});

describe('summaryByPeriod READ CUTOVER (model_usage rollup)', () => {
  it('flag OFF: SQL atual (GROUP BY slot, provider, model), sem JOIN flow_clones', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await summaryByPeriod(7, {} as NodeJS.ProcessEnv);

    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    const norm = sql.replace(/\s+/g, ' ');
    expect(norm).toContain('GROUP BY slot, provider, model');
    expect(norm).not.toContain('flow_clones');
  });

  it('flag ON: junta flow_clones e agrupa por tenant_id, expõe tenant_id na linha', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          slot: 'clone_cirilobarbearia_c8w2f0',
          tenant_id: TENANT_UUID,
          provider: 'openai',
          model: 'gpt-4o',
          calls: '10',
          prompt_tokens: '100',
          completion_tokens: '50',
          total_tokens: '150',
          cost_usd: '0.01',
        },
      ],
      rowCount: 1,
    });

    const rows = await summaryByPeriod(7, { TENANT_READ_CUTOVER: 'true' } as NodeJS.ProcessEnv);

    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    const norm = sql.replace(/\s+/g, ' ');
    expect(norm).toContain('LEFT JOIN flow_clones fc ON fc.slot = mu.slot');
    expect(norm).toContain('GROUP BY COALESCE(fc.tenant_id::text, mu.slot)');
    expect(rows[0].tenant_id).toBe(TENANT_UUID);
    expect(rows[0].slot).toBe('clone_cirilobarbearia_c8w2f0');
  });
});
