import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock('../client.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const {
  claimClienteWhatsAppManualSend,
  completeClienteWhatsAppManualSend,
  getClienteWhatsAppManualTargetForOwner,
} = await import('./crm-whatsapp-manual.js');

const SCOPE = {
  slot: 'clone_owner',
  tenantId: '00000000-0000-4000-8000-000000000001',
  clienteId: '11111111-1111-4111-8111-111111111111',
  operatorUserId: 7,
};

beforeEach(() => {
  mockQuery.mockReset();
});

describe('CRM WhatsApp manual queries', () => {
  it('resolve alvo somente por cliente + slot + tenant e retorna sessao WAHA do flow clone', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { telefone_raw: '553199998842', waha_sessao: 'sessao-real-do-clone', waha_shard_id: 4 },
      ],
    });

    await expect(
      getClienteWhatsAppManualTargetForOwner(SCOPE.slot, SCOPE.tenantId, SCOPE.clienteId),
    ).resolves.toEqual({
      telefone: '553199998842',
      wahaSessao: 'sessao-real-do-clone',
      wahaShardId: 4,
    });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('JOIN flow_clones fc');
    expect(sql).toContain('fc.waha_sessao');
    expect(sql).toContain('fc.waha_shard_id');
    expect(sql).toContain('c.id = $1');
    expect(sql).toContain('c.slot = $2');
    expect(sql).toContain('c.tenant_id = $3');
    expect(params).toEqual([SCOPE.clienteId, SCOPE.slot, SCOPE.tenantId]);
  });

  it('claim atomico cria auditoria sem texto/telefone e concorrente em cooldown recebe null', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: '22222222-2222-4222-8222-222222222222', cooldown_until: '2026-08-21T12:00:30Z' },
      ],
    });
    const claimed = await claimClienteWhatsAppManualSend({ ...SCOPE, cooldownMs: 30_000 });
    expect(claimed).toEqual({
      sendId: '22222222-2222-4222-8222-222222222222',
      cooldownUntil: '2026-08-21T12:00:30Z',
    });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT (slot, tenant_id, cliente_id, operator_user_id)');
    expect(sql).toContain('cooldown_until <= NOW()');
    expect(sql).toContain('crm_whatsapp_manual_send_audit');
    expect(sql).not.toContain('texto');
    expect(sql).not.toContain('telefone');
    expect(params.slice(0, 5)).toEqual([
      SCOPE.slot,
      SCOPE.tenantId,
      SCOPE.clienteId,
      SCOPE.operatorUserId,
      30_000,
    ]);

    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(
      claimClienteWhatsAppManualSend({ ...SCOPE, cooldownMs: 30_000 }),
    ).resolves.toBeNull();
  });

  it('fecha a auditoria pelo sendId e escopo, sem registrar detalhe cru do erro WAHA', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    await completeClienteWhatsAppManualSend({
      slot: SCOPE.slot,
      tenantId: SCOPE.tenantId,
      sendId: '22222222-2222-4222-8222-222222222222',
      outcome: 'failed',
      failureCode: 'timeout_or_waha_error',
    });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('id = $1');
    expect(sql).toContain('slot = $2');
    expect(sql).toContain('tenant_id = $3');
    expect(sql).not.toContain('telefone');
    expect(sql).not.toContain('texto');
    expect(params).toEqual([
      '22222222-2222-4222-8222-222222222222',
      SCOPE.slot,
      SCOPE.tenantId,
      'failed',
      'timeout_or_waha_error',
    ]);
  });
});
