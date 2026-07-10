/**
 * Testes do packages (read-only) — ADR 0025 BLOCO 2a.
 *
 * `../client.js` é MOCKADO (sem banco). Validamos:
 *  - ISOLAMENTO: toda query escopa por slot (e por HMAC nos créditos) — parâmetros,
 *    nunca interpolados; nunca seleciona o número cru;
 *  - SALDO vem do LEDGER (sessoes_total + SUM(delta)), não do cache;
 *  - estados EXPIRADO / ESGOTADO / CANCELADO calculados server-side;
 *  - cobertura (cobre()) e escopo (casa vs colaborador) corretos;
 *  - funciona pra individual (colaborador_id NULL) E estabelecimento (preenchido).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { listActiveTemplates, listClientCredits, listActiveClientCredits, normalizeServiceName } =
  await import('./packages.js');

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [] });
});

/** Linha de crédito "crua" como o pg devolve (saldo_ledger pode vir string). */
function rawCredit(over: Partial<Record<string, unknown>> = {}) {
  return {
    credit_id: '10',
    package_id: '3',
    slot: 'cirilobarbearia',
    nome: 'Pacote 5 Cortes',
    sessoes_total: 5,
    sessoes_restantes_cache: 5,
    saldo_ledger: '5',
    data_expiracao: '2999-12-31',
    expirado: false,
    status: 'active',
    servicos_cobertos: ['Corte', 'Barba'],
    colaborador_id: null,
    preco_cents: 8500,
    ...over,
  };
}

describe('listActiveTemplates — listagem por slot (isolamento)', () => {
  it('escopa por slot + ativo, parametrizado; não interpola', async () => {
    await listActiveTemplates('cirilobarbearia');
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE slot = $1 AND ativo = TRUE');
    expect(params).toEqual(['cirilobarbearia']);
  });

  it('normaliza ids/servicos_cobertos/preço (pg pode devolver string/JSONB)', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: '7',
          slot: 'cirilobarbearia',
          nome: 'Combo',
          descricao: null,
          servicos_cobertos: ['Corte'],
          total_sessoes: 4,
          validade_dias: 90,
          data_validade_fixa: null,
          preco_cents: 12000,
          colaborador_id: null,
          ativo: true,
        },
      ],
    });
    const out = await listActiveTemplates('cirilobarbearia');
    expect(out[0]).toMatchObject({
      id: 7,
      total_sessoes: 4,
      validade_dias: 90,
      data_validade_fixa: null,
      preco_cents: 12000,
      colaborador_id: null,
      servicos_cobertos: ['Corte'],
    });
  });

  it('suporta validade por DATA FIXA (validade_dias NULL, data_validade_fixa setada)', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: '8',
          slot: 's',
          nome: 'Promo Verão',
          descricao: null,
          servicos_cobertos: [],
          total_sessoes: 3,
          validade_dias: null,
          data_validade_fixa: '2027-01-31',
          preco_cents: null,
          colaborador_id: null,
          ativo: true,
        },
      ],
    });
    const out = await listActiveTemplates('s');
    expect(out[0]?.validade_dias).toBeNull();
    expect(out[0]?.data_validade_fixa).toBe('2027-01-31');
  });
});

describe('listClientCredits — isolamento + saldo do ledger', () => {
  it('escopa por (slot, cliente_phone_hmac) parametrizado; saldo = total + SUM(delta) do ledger', async () => {
    await listClientCredits({ slot: 'cirilobarbearia', phoneHmac: 'abc123' });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE c.slot = $1 AND c.cliente_phone_hmac = $2');
    expect(sql).toContain('c.sessoes_total + COALESCE(SUM(pr.delta), 0)');
    expect(sql).toContain('LEFT JOIN package_redemptions pr');
    // Preço do pacote no SELECT + no GROUP BY (pro bot informar "R$ X,XX").
    expect(sql).toContain('sp.preco_cents');
    expect(sql).toMatch(/GROUP BY[\s\S]*sp\.preco_cents/);
    expect(params).toEqual(['cirilobarbearia', 'abc123']);
  });

  it('NUNCA seleciona o número cru (LGPD): só HMAC entra como parâmetro', async () => {
    await listClientCredits({ slot: 's', phoneHmac: 'h' });
    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).not.toContain('cliente_telefone');
    expect(sql.toLowerCase()).not.toContain('phone_hint'); // bloco/tool não dependem do hint
  });

  it('estado ATIVO: saldo>0 e dentro da validade', async () => {
    mockQuery.mockResolvedValue({ rows: [rawCredit()] });
    const [c] = await listClientCredits({ slot: 's', phoneHmac: 'h' });
    expect(c?.estado).toBe('ATIVO');
    expect(c?.sessoes_restantes).toBe(5);
    expect(c?.cobre('corte')).toBe(true); // case-insensitive
    expect(c?.cobre('Hidratação')).toBe(false); // fora da cobertura
    expect(c?.colaborador_id).toBeNull(); // pacote da casa (individual)
    expect(c?.preco_cents).toBe(8500); // preço do template normalizado (pro bot)
  });

  it('estado EXPIRADO: data_expiracao no passado (expirado=true do SQL) mesmo com saldo', async () => {
    mockQuery.mockResolvedValue({
      rows: [rawCredit({ expirado: true, saldo_ledger: '3', data_expiracao: '2020-01-01' })],
    });
    const [c] = await listClientCredits({ slot: 's', phoneHmac: 'h' });
    expect(c?.estado).toBe('EXPIRADO');
    expect(c?.sessoes_restantes).toBe(3);
  });

  it('estado ESGOTADO: saldo do ledger zerou (ledger é a verdade, não o cache)', async () => {
    // cache diz 5, mas o ledger consumiu tudo (saldo_ledger=0) → ESGOTADO.
    mockQuery.mockResolvedValue({
      rows: [rawCredit({ sessoes_restantes_cache: 5, saldo_ledger: '0' })],
    });
    const [c] = await listClientCredits({ slot: 's', phoneHmac: 'h' });
    expect(c?.estado).toBe('ESGOTADO');
    expect(c?.sessoes_restantes).toBe(0);
  });

  it('estado CANCELADO: status cancelled vence saldo/validade', async () => {
    mockQuery.mockResolvedValue({ rows: [rawCredit({ status: 'cancelled' })] });
    const [c] = await listClientCredits({ slot: 's', phoneHmac: 'h' });
    expect(c?.estado).toBe('CANCELADO');
  });

  it('ESTABELECIMENTO: colaborador_id preenchido = escopo por colaborador', async () => {
    mockQuery.mockResolvedValue({ rows: [rawCredit({ colaborador_id: '42' })] });
    const [c] = await listClientCredits({ slot: 'clone_estab_x', phoneHmac: 'h' });
    expect(c?.colaborador_id).toBe(42);
    expect(c?.estado).toBe('ATIVO');
  });

  it('saldo negativo do ledger nunca vaza: clampa em 0', async () => {
    mockQuery.mockResolvedValue({ rows: [rawCredit({ saldo_ledger: '-1' })] });
    const [c] = await listClientCredits({ slot: 's', phoneHmac: 'h' });
    expect(c?.sessoes_restantes).toBe(0);
    expect(c?.estado).toBe('ESGOTADO');
  });
});

describe('validade no FUSO DO CLONE, não UTC (SCRUM-46)', () => {
  // A validade do pacote (data_expiracao, uma DATE de parede) tem de ser comparada contra o dia
  // do RELÓGIO DO DONO. Antes usava (NOW() AT TIME ZONE 'utc')::date: perto da meia-noite (a
  // partir de ~21h BRT) um pacote que vence HOJE aparecia expirado cedo demais.
  it('listClientCredits: expirado deriva o "hoje" de flow_clones.timezone, não de UTC', async () => {
    await listClientCredits({ slot: 'clone_barbearia_seven_7', phoneHmac: 'h' });
    const [sql] = mockQuery.mock.calls[0] as [string];
    // compara a validade contra o dia-de-parede no fuso do clone (subquery em flow_clones)
    expect(sql).toMatch(/c\.data_expiracao\s*<\s*\(NOW\(\) AT TIME ZONE COALESCE/);
    expect(sql).toContain('SELECT fc.timezone FROM flow_clones fc WHERE fc.slot = c.slot');
    // fallback defensivo pro default de produção (migration 068)
    expect(sql).toContain("'America/Sao_Paulo'");
    // a comparação de validade NÃO pode mais depender de UTC
    expect(sql).not.toMatch(/data_expiracao\s*<\s*\(NOW\(\) AT TIME ZONE 'utc'\)/i);
  });
});

describe('listActiveClientCredits — só utilizáveis', () => {
  it('filtra para ATIVO (descarta EXPIRADO/ESGOTADO/CANCELADO)', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        rawCredit({ credit_id: '1' }), // ATIVO
        rawCredit({ credit_id: '2', expirado: true }), // EXPIRADO
        rawCredit({ credit_id: '3', saldo_ledger: '0' }), // ESGOTADO
        rawCredit({ credit_id: '4', status: 'cancelled' }), // CANCELADO
      ],
    });
    const out = await listActiveClientCredits({ slot: 's', phoneHmac: 'h' });
    expect(out.map((c) => c.credit_id)).toEqual([1]);
  });

  it('cliente sem pacote => lista vazia (não injeta bloco no caller)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await listActiveClientCredits({ slot: 's', phoneHmac: 'h' })).toEqual([]);
  });
});

describe('normalizeServiceName + cobre() — casamento acento/caixa-insensível', () => {
  it('normaliza acento + caixa + espaços', () => {
    expect(normalizeServiceName('  Hidratação ')).toBe('hidratacao');
    expect(normalizeServiceName('Pé e Mão')).toBe('pe e mao');
    expect(normalizeServiceName('CORTE')).toBe('corte');
  });

  it('cobre() casa "Hidratacao" pedido contra "Hidratação" cadastrado (sem acento perde a baixa antes)', async () => {
    mockQuery.mockResolvedValue({ rows: [rawCredit({ servicos_cobertos: ['Hidratação'] })] });
    const [c] = await listClientCredits({ slot: 's', phoneHmac: 'h' });
    expect(c?.cobre('Hidratacao')).toBe(true); // sem acento no pedido
    expect(c?.cobre('hidratação')).toBe(true); // caixa diferente
    expect(c?.cobre('Corte')).toBe(false); // continua não cobrindo o que não é o serviço
  });
});
