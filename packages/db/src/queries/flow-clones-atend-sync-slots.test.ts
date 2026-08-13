/**
 * listAtendSyncSlots (SCRUM-89 / ADR 0031) — enumera os clones que o reconciler GCal→atendimentos
 * percorre. UNIÃO env→coluna (mesmo gate do hook): billing_from_agenda_enabled=TRUE OR slot=ANY(csv).
 *
 * Mocka a camada de query (../client.js) — sem DB real (padrão dos flow-clones-*.test.ts). Valida a
 * STRING do SQL (WHERE correto, placeholder do array) e o mapeamento (tenant_id null preservado,
 * timezone default, product_type normalizado).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { listAtendSyncSlots } = await import('./flow-clones.js');

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('listAtendSyncSlots', () => {
  it('SQL: une billing env/coluna e exclui modo efetivo atendente por coluna/env', async () => {
    await listAtendSyncSlots(['clone_a', 'clone_b'], ['clone_atendente'], false);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('billing_from_agenda_enabled = TRUE');
    expect(sql).toContain('slot = ANY($1::text[])');
    expect(sql).toContain('FROM flow_clones');
    // projeta o escopo mínimo que o job usa.
    expect(sql).toContain('SELECT slot, tenant_id, timezone, product_type, modo_atendente_enabled');
    expect(sql).toContain("COALESCE(personalizacao->>'agenda_automatica' = 'false', FALSE)");
    expect(sql).toContain('modo_atendente_enabled = TRUE');
    expect(sql).toContain('slot = ANY($2::text[])');
    expect(sql).toContain('$3::boolean = TRUE');
    expect(params).toEqual([['clone_a', 'clone_b'], ['clone_atendente'], false]);
  });

  it('CSV vazio → só a coluna decide (ANY de array vazio)', async () => {
    await listAtendSyncSlots([]);
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([[], [], false]);
  });

  it('mapeia tenant_id null preservado, timezone default SP e product_type normalizado', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          slot: 'clone_estab',
          tenant_id: 't1',
          timezone: 'America/Cuiaba',
          product_type: 'estabelecimento',
          modo_atendente_enabled: false,
          agenda_automatica: null,
        },
        {
          slot: 'clone_ind',
          tenant_id: 't2',
          timezone: null,
          product_type: 'individual',
          modo_atendente_enabled: true,
          agenda_automatica: 'false',
        },
        {
          slot: 'clone_sem_tenant',
          tenant_id: null,
          timezone: null,
          product_type: null,
          modo_atendente_enabled: null,
          agenda_automatica: 'true',
        },
      ],
      rowCount: 3,
    });
    const rows = await listAtendSyncSlots(['clone_ind']);
    expect(rows).toEqual([
      {
        slot: 'clone_estab',
        tenant_id: 't1',
        timezone: 'America/Cuiaba',
        product_type: 'estabelecimento',
        modo_atendente_enabled: false,
        agenda_automatica: null,
      },
      {
        slot: 'clone_ind',
        tenant_id: 't2',
        timezone: 'America/Sao_Paulo',
        product_type: 'individual',
        modo_atendente_enabled: true,
        agenda_automatica: 'false',
      },
      // product_type != 'estabelecimento' (null) normaliza p/ 'individual'; tenant_id null preservado
      // (o job pula slot sem tenant_id, regra 5).
      {
        slot: 'clone_sem_tenant',
        tenant_id: null,
        timezone: 'America/Sao_Paulo',
        product_type: 'individual',
        modo_atendente_enabled: false,
        agenda_automatica: 'true',
      },
    ]);
  });
});
