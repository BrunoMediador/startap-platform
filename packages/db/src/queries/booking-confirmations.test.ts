import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../client.js', () => ({ query: (...args: unknown[]) => mockQuery(...args) }));

const confirmations = await import('./booking-confirmations.js');
const scope = { tenantId: 'tenant-a', slot: 'clone-a', contactHmac: 'a'.repeat(64) };

beforeEach(() => mockQuery.mockReset());

describe('booking confirmations queries', () => {
  it('substitui proposta pendente sob advisory lock e sempre escopa tenant+slot+hmac', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'p1',
          tenant_id: 'tenant-a',
          slot: 'clone-a',
          contact_hmac: scope.contactHmac,
          colaborador_id: 1,
          servico: 'Corte',
          inicio_at: '2026-08-26T20:00:00Z',
          fim_at: '2026-08-26T20:30:00Z',
          timezone: 'America/Sao_Paulo',
          usa_pacote: null,
          event_id: 'startapbookingp1',
          status: 'pending',
          expires_at: '2026-08-26T20:15:00Z',
          card_sent_at: '2026-08-26T20:00:00Z',
          created_at: '2026-08-26T20:00:00Z',
          updated_at: '2026-08-26T20:00:00Z',
        },
      ],
    });
    await confirmations.replacePending({
      id: 'p1',
      ...scope,
      colaboradorId: 1,
      servico: 'Corte',
      inicioAt: '2026-08-26T20:00:00Z',
      fimAt: '2026-08-26T20:30:00Z',
      timezone: 'America/Sao_Paulo',
      usaPacote: null,
      eventId: 'startapbookingp1',
      expiresAt: '2026-08-26T20:15:00Z',
    });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain("status='superseded'");
    expect(sql).toContain('tenant_id=$1 AND slot=$3 AND contact_hmac=$4');
    expect(params).toContain(scope.contactHmac);
  });

  it('SIM é CAS por pending+TTL e não aceita proposal de outro tenant', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(confirmations.claimForConfirmation(scope)).resolves.toBeNull();
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status='pending' AND expires_at > now()");
    expect(sql).toContain('tenant_id=$1 AND slot=$2 AND contact_hmac=$3');
    expect(params).toEqual(['tenant-a', 'clone-a', scope.contactHmac]);
  });

  it('a leitura de retry não atravessa tenant ou slot', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(confirmations.latestForContact(scope)).resolves.toBeNull();
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('tenant_id=$1 AND slot=$2 AND contact_hmac=$3');
    expect(params).toEqual(['tenant-a', 'clone-a', scope.contactHmac]);
  });

  it('retenção só seleciona estados terminais e recebe cutoff parametrizado', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '2' }] });
    await expect(confirmations.countTerminalBefore('2026-07-01T00:00:00.000Z')).resolves.toBe(2);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      "status IN ('booked','expired','superseded','conflict','recovery_required')",
    );
    expect(sql).not.toContain("'pending'");
    expect(params).toEqual(['2026-07-01T00:00:00.000Z']);
  });
});
