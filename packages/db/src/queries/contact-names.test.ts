/**
 * Unit de contact-names.ts (SCRUM-144) — store durável do pushName por contato.
 * Mocka `query` do client (sem DB real) e `@startap/core/phone` com uma reimplementação
 * fiel do canonicalE164 (o ESM real não resolve no Vitest sem build — mesmo padrão do
 * router.test.ts). Foco: SQL/params gerados + a INVARIÂNCIA ao 9º dígito na chave.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock('@startap/core/phone', () => ({
  canonicalE164: (raw: string): string | null => {
    if (!raw) return null;
    let d = raw.split('@')[0]?.split(':')[0]?.replace(/\D/g, '').replace(/^0+/, '') ?? '';
    if (d.length < 10 || d.length > 15) return null;
    if (d.length === 10 || d.length === 11) d = `55${d}`;
    if (d.startsWith('55')) {
      if (d.length === 13 && d[4] === '9') return d.slice(0, 4) + d.slice(5);
      if (d.length === 12 || d.length === 13) return d;
      return null;
    }
    return d;
  },
}));

const { upsertContactName, getContactName } = await import('./contact-names.js');

describe('upsertContactName — grava só INBOUND, chave invariante ao 9º dígito', () => {
  beforeEach(() => mockQuery.mockReset());

  it('grava push_name trimado + phone_key canônico (sem o 9) + ON CONFLICT preserva o antigo', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1 });
    await upsertContactName({ session: 'SESS', telefone: '5535991746797', pushName: '  Wal  ' });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO contact_names/i);
    expect(sql).toMatch(/ON CONFLICT \(session, phone_key\) DO UPDATE/i);
    // Só sobrescreve com nome NOVO não-vazio; senão mantém o já gravado.
    expect(sql).toMatch(
      /push_name = COALESCE\(NULLIF\(EXCLUDED\.push_name, ''\), contact_names\.push_name\)/i,
    );
    // $1 session, $2 phone_key (canônico SEM o 9 → 12 díg), $3 push_name trimado, $4 dígitos crus.
    expect(params[0]).toBe('SESS');
    expect(params[1]).toBe('553591746797');
    expect(params[2]).toBe('Wal');
    expect(params[3]).toBe('5535991746797');
  });

  it('NO-OP quando pushName vazio — não toca o banco (não-vácuo)', async () => {
    await upsertContactName({ session: 'SESS', telefone: '5535991746797', pushName: '   ' });
    await upsertContactName({ session: 'SESS', telefone: '5535991746797', pushName: null });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('NO-OP quando telefone irrecuperável (curto) — não grava lixo', async () => {
    await upsertContactName({ session: 'SESS', telefone: '123', pushName: 'X' });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('getContactName — lookup pela chave canônica', () => {
  beforeEach(() => mockQuery.mockReset());

  it('COM o 9 e SEM o 9 batem na MESMA phone_key (invariância provada)', async () => {
    mockQuery.mockResolvedValue({ rows: [{ push_name: 'Wal' }] });

    const comNove = await getContactName({ session: 'SESS', telefone: '5535991746797' }); // 13 díg
    const semNove = await getContactName({ session: 'SESS', telefone: '553591746797' }); // 12 díg

    expect(comNove).toBe('Wal');
    expect(semNove).toBe('Wal');
    const key1 = (mockQuery.mock.calls[0] as [string, unknown[]])[1][1];
    const key2 = (mockQuery.mock.calls[1] as [string, unknown[]])[1][1];
    expect(key1).toBe('553591746797');
    expect(key2).toBe(key1); // mesma chave → mesmo contato
  });

  it('sem linha → null; telefone irrecuperável → null sem tocar o banco', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await getContactName({ session: 'SESS', telefone: '5535991746797' })).toBeNull();

    mockQuery.mockReset();
    expect(await getContactName({ session: 'SESS', telefone: '12' })).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
