/**
 * Testes da data layer de aceite de termos (SCRUM-1 / LGPD prova).
 *
 * `../client.js` é MOCKADO (`query`) — não toca banco. Validamos:
 *  - recordTermsAcceptance: SQL parametrizado ($1..$7), ordem dos params, normalização
 *    de id/portal_user_id (BIGSERIAL vem como string do pg).
 *  - tenant_id é parâmetro PRÓPRIO ($2), nunca reusa o $1 do slot (lição #309/ADR 0018).
 *  - getLatestAcceptanceForSlot: escopo por slot (anti-IDOR), null quando vazio.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  query: (...a: unknown[]) => mockQuery(...a),
}));

const { recordTermsAcceptance, getLatestAcceptanceForSlot } = await import('./terms-acceptance.js');

function lastCall(): [string, unknown[]] {
  const calls = mockQuery.mock.calls;
  return calls[calls.length - 1] as [string, unknown[]];
}

beforeEach(() => {
  mockQuery.mockReset();
});

describe('recordTermsAcceptance', () => {
  it('INSERT parametrizado na ordem certa + normaliza ids string->number', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: '42',
          slot: 'clone_x',
          tenant_id: 't-uuid',
          portal_user_id: '7',
          terms_version: 'v1',
          privacy_version: 'v1',
          ip: '203.0.113.7',
          user_agent: 'UA/1.0',
          accepted_at: new Date('2026-06-26T00:00:00Z'),
          created_at: new Date('2026-06-26T00:00:00Z'),
        },
      ],
    });

    const row = await recordTermsAcceptance({
      slot: 'clone_x',
      tenantId: 't-uuid',
      portalUserId: 7,
      termsVersion: 'v1',
      privacyVersion: 'v1',
      ip: '203.0.113.7',
      userAgent: 'UA/1.0',
    });

    expect(row.id).toBe(42);
    expect(row.portal_user_id).toBe(7);

    const [sql, params] = lastCall();
    expect(sql).toContain('INSERT INTO terms_acceptances');
    // Ordem: slot, tenant_id, portal_user_id, terms_version, privacy_version, ip, user_agent
    expect(params).toEqual(['clone_x', 't-uuid', 7, 'v1', 'v1', '203.0.113.7', 'UA/1.0']);
    // tenant_id é o 2º placeholder ($2) — NÃO reusa o $1 do slot.
    expect(sql).toMatch(/VALUES\s*\(\$1,\s*\$2,\s*\$3,\s*\$4,\s*\$5,\s*\$6,\s*\$7\)/);
  });

  it('tenant_id null e portal_user_id null são tolerados (fail-safe RLS / churn)', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: '1',
          slot: 'clone_y',
          tenant_id: null,
          portal_user_id: null,
          terms_version: 'v1',
          privacy_version: 'v1',
          ip: null,
          user_agent: null,
          accepted_at: new Date(),
          created_at: new Date(),
        },
      ],
    });
    const row = await recordTermsAcceptance({
      slot: 'clone_y',
      tenantId: null,
      portalUserId: null,
      termsVersion: 'v1',
      privacyVersion: 'v1',
      ip: null,
      userAgent: null,
    });
    expect(row.tenant_id).toBeNull();
    expect(row.portal_user_id).toBeNull();
    const [, params] = lastCall();
    expect(params[1]).toBeNull(); // tenant_id
    expect(params[2]).toBeNull(); // portal_user_id
  });
});

describe('getLatestAcceptanceForSlot', () => {
  it('filtra por slot ($1) e devolve a linha normalizada', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: '9',
          slot: 'clone_z',
          tenant_id: 't',
          portal_user_id: '3',
          terms_version: 'v1',
          privacy_version: 'v1',
          ip: null,
          user_agent: null,
          accepted_at: new Date(),
          created_at: new Date(),
        },
      ],
    });
    const row = await getLatestAcceptanceForSlot('clone_z');
    expect(row?.id).toBe(9);
    const [sql, params] = lastCall();
    expect(sql).toContain('WHERE slot = $1');
    expect(params).toEqual(['clone_z']);
  });

  it('devolve null quando o tenant nunca aceitou', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const row = await getLatestAcceptanceForSlot('clone_vazio');
    expect(row).toBeNull();
  });
});
