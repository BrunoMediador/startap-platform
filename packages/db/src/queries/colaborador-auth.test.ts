/**
 * Testes da data layer do LOGIN do colaborador (SCRUM-32).
 *
 * `../client.js` é MOCKADO (`query`) — não toca banco. Validamos:
 *  - slugifyColaboradorUsername / deriveColaboradorUsername: regra de username (PURAS).
 *  - findColaboradorForAuth: SQL com lower(username) (login case-insensitive).
 *  - getComissaoColaborador (atendimentos): ESCOPO anti-IDOR — WHERE cc.id = $3 (o
 *    colaborador_id da sessão) + cc.slot/tenant; nunca devolve dado de outro colaborador.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: { connect: vi.fn() },
  query: (...a: unknown[]) => mockQuery(...a),
}));

const {
  slugifyColaboradorUsername,
  deriveColaboradorUsername,
  findColaboradorForAuth,
  recordColaboradorFailedLogin,
} = await import('./colaborador-auth.js');
const { getComissaoColaborador } = await import('./atendimentos.js');

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

function lastCall(): [string, unknown[]] {
  const calls = mockQuery.mock.calls;
  return calls[calls.length - 1] as [string, unknown[]];
}

describe('slugifyColaboradorUsername', () => {
  it('minúsculas, sem acento, espaços viram hífen', () => {
    expect(slugifyColaboradorUsername('Bene Silva')).toBe('bene-silva');
    expect(slugifyColaboradorUsername('João Coração')).toBe('joao-coracao');
  });
  it('colapsa não-alfanumérico e tira hífen das bordas', () => {
    expect(slugifyColaboradorUsername('  --Thomas!! ')).toBe('thomas');
  });
  it('vazio/sem alfanumérico -> fallback "colaborador"', () => {
    expect(slugifyColaboradorUsername('')).toBe('colaborador');
    expect(slugifyColaboradorUsername('@@@')).toBe('colaborador');
  });
});

describe('deriveColaboradorUsername — desambiguação global por sufixo', () => {
  it('slug livre -> sem sufixo', () => {
    expect(deriveColaboradorUsername('Bene', [])).toBe('bene');
  });
  it('slug em uso -> sufixo numérico crescente (-2, -3)', () => {
    expect(deriveColaboradorUsername('Bruno', ['bruno'])).toBe('bruno-2');
    expect(deriveColaboradorUsername('Bruno', ['bruno', 'bruno-2'])).toBe('bruno-3');
  });
  it('dois nomes que geram o mesmo slug (João/Joao) também desambiguam', () => {
    // "João" -> "joao"; se "joao" já existe (de "Joao"), ganha sufixo.
    expect(deriveColaboradorUsername('João', ['joao'])).toBe('joao-2');
  });
  it('case-insensitive no conjunto de tomados', () => {
    expect(deriveColaboradorUsername('Bene', ['BENE'])).toBe('bene-2');
  });
});

describe('findColaboradorForAuth', () => {
  it('busca por lower(username) e normaliza colaborador_id para number', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          colaborador_id: '4',
          slot: 'clone_x',
          tenant_id: 'tid-1',
          username: 'bene-silva',
          nome: 'Bene Silva',
          password_hash: '$2a$12$h',
          active: true,
          colaborador_ativo: true,
          failed_attempts: 0,
          locked_until: null,
        },
      ],
    });
    const row = await findColaboradorForAuth('Bene-Silva');
    expect(row?.colaborador_id).toBe(4);
    const [sql, params] = lastCall();
    expect(sql).toMatch(/lower\(ca\.username\) = lower\(\$1\)/);
    expect(params).toEqual(['Bene-Silva']);
  });

  it('null quando não existe', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await findColaboradorForAuth('ninguem')).toBeNull();
  });
});

describe('recordColaboradorFailedLogin', () => {
  it('incrementa/zera e trava por lockMinutes (escopo por colaborador_id)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ failed_attempts: 0, locked_until: new Date() }] });
    await recordColaboradorFailedLogin(9, 5, 15);
    const [sql, params] = lastCall();
    expect(sql).toMatch(/UPDATE colaborador_auth/);
    expect(sql).toMatch(/WHERE colaborador_id = \$1/);
    expect(params).toEqual([9, 5, '15']);
  });
});

describe('getComissaoColaborador — escopo anti-IDOR (SCRUM-32)', () => {
  it('filtra por cc.id = $3 (colaborador da sessão) + slot/tenant; nunca cruza colaborador', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          colaborador_id: 7,
          profissional_nome: 'Bene',
          total_bruto_cents: '10000',
          comissao_pct: '50',
          comissao_cents: '5000',
          count: '2',
        },
      ],
    });
    const out = await getComissaoColaborador(
      'clone_seven',
      'tid-7',
      7,
      '2026-06-01',
      '2026-06-30',
      'faturado',
    );
    const [sql, params] = lastCall();
    // ESCOPO: parte de clone_colaboradores cc com cc.slot=$1, cc.id=$3, cc.ativo=TRUE.
    expect(sql).toMatch(/FROM clone_colaboradores cc/);
    expect(sql).toMatch(/WHERE cc\.slot = \$1 AND cc\.id = \$3 AND cc\.ativo = TRUE/);
    // tenant_id ($2) entra no ON do JOIN de atendimentos — defesa RLS.
    expect(sql).toMatch(/a\.tenant_id = \$2/);
    expect(params).toEqual(['clone_seven', 'tid-7', 7, '2026-06-01', '2026-06-30']);
    expect(out?.comissao_cents).toBe(5000);
    expect(out?.total_bruto_cents).toBe(10000);
  });

  it('colaborador fora do slot/tenant (ou inativo) -> null (não vaza existência)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const out = await getComissaoColaborador(
      'clone_x',
      'tid-x',
      999,
      '2026-06-01',
      '2026-06-30',
      'previsao',
    );
    expect(out).toBeNull();
  });
});
