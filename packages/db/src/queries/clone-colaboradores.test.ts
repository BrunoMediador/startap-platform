/**
 * Testes da data layer de colaboradores — FOCO no comissao_pct (app de gestão,
 * cenário EMPRESA, ADR 0026):
 *  - READ: NUMERIC do pg chega como string -> a API entrega number (mapColaboradorRow).
 *  - CREATE: comissao_pct ausente -> 0 (default da coluna); presente -> vai no INSERT.
 *  - UPDATE parcial: SEM comissao_pct -> o SET nem menciona a coluna (não zera ninguém);
 *    COM comissao_pct -> entra no SET; valor sai saneado (clamp 0–100, 2 casas).
 *
 * `../client.js` é MOCKADO (pool.connect()/query), mesmo padrão de packages-lifecycle.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockConnect = vi.fn();
const mockRelease = vi.fn();

vi.mock('../client.js', () => ({
  pool: { connect: (...a: unknown[]) => mockConnect(...a) },
  query: (...a: unknown[]) => mockQuery(...a),
}));

const { create, update, listBySlot, getAreaPromptCustomCartao } = await import(
  './clone-colaboradores.js'
);

// Linha CRUA como o pg devolve: NUMERIC vira string ('15.50'), não number.
const RAW_ROW = {
  id: 1,
  nome: 'Ana',
  gcal_calendar_id: null,
  gcal_status: 'pending',
  servicos: ['Corte'],
  ativo: true,
  ordem: 0,
  comissao_pct: '15.50',
  created_at: '2026-06-23T00:00:00Z',
  updated_at: '2026-06-23T00:00:00Z',
};

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  mockRelease.mockReset();
  mockConnect.mockReset().mockResolvedValue({
    query: (...a: unknown[]) => mockClientQuery(...a),
    release: (...a: unknown[]) => mockRelease(...a),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('listBySlot — comissao_pct vem como number', () => {
  it('converte a string NUMERIC do pg pra number no JSON', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [RAW_ROW], rowCount: 1 });
    const [row] = await listBySlot('clone_x');
    expect(row.comissao_pct).toBe(15.5);
    expect(typeof row.comissao_pct).toBe('number');
    // SELECT escopado por slot.
    expect(mockQuery.mock.calls[0][1]).toEqual(['clone_x']);
    expect(String(mockQuery.mock.calls[0][0])).toContain('comissao_pct');
  });

  it('NULL/indefinido -> 0 (fallback seguro)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...RAW_ROW, comissao_pct: null }], rowCount: 1 });
    const [row] = await listBySlot('clone_x');
    expect(row.comissao_pct).toBe(0);
  });

  // REGRESSÃO (bug de produção 2026-06-27): id é BIGINT no banco e o driver pg devolve
  // bigint como STRING. O contrato ColaboradorRow.id é `number`; mapColaboradorRow tem
  // de honrar o tipo (senão consumidores que comparam id com `===` quebram em runtime).
  it('id (bigint do pg) chega como STRING e sai como number (honra o tipo do contrato)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...RAW_ROW, id: '4' }], rowCount: 1 });
    const [row] = await listBySlot('clone_x');
    expect(row.id).toBe(4);
    expect(typeof row.id).toBe('number');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('create — comissao_pct', () => {
  /** Programa a transação de create: BEGIN/COMMIT ok; INSERT devolve a linha crua dada. */
  function programCreate(insRow: Record<string, unknown>) {
    mockClientQuery.mockReset().mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO clone_colaboradores/i.test(sql)) return { rows: [insRow], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  }

  it('ausente -> grava 0 e devolve number', async () => {
    programCreate({ ...RAW_ROW, comissao_pct: '0' });
    const row = await create({ slot: 'clone_x', tenantId: 'tid-1', nome: 'Ana' }, null);
    const ins = mockClientQuery.mock.calls.find((c) =>
      /INSERT INTO clone_colaboradores/i.test(String(c[0])),
    );
    expect(ins?.[1]?.[6]).toBe(0); // 7º bind = comissao_pct
    expect(row.comissao_pct).toBe(0);
  });

  it('presente -> vai saneado pro INSERT (clamp + 2 casas) e volta number', async () => {
    programCreate({ ...RAW_ROW, comissao_pct: '30.00' });
    await create({ slot: 'clone_x', tenantId: 'tid-1', nome: 'Ana', comissao_pct: 30 }, null);
    const ins = mockClientQuery.mock.calls.find((c) =>
      /INSERT INTO clone_colaboradores/i.test(String(c[0])),
    );
    expect(ins?.[1]?.[6]).toBe(30);
  });

  it('acima de 100 é clampado pra 100 antes do INSERT', async () => {
    programCreate({ ...RAW_ROW, comissao_pct: '100.00' });
    await create({ slot: 'clone_x', tenantId: 'tid-1', nome: 'Ana', comissao_pct: 150 }, null);
    const ins = mockClientQuery.mock.calls.find((c) =>
      /INSERT INTO clone_colaboradores/i.test(String(c[0])),
    );
    expect(ins?.[1]?.[6]).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('update — comissao_pct (update parcial)', () => {
  function programUpdate(updRow: Record<string, unknown> | null) {
    mockClientQuery.mockReset().mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/UPDATE clone_colaboradores/i.test(sql))
        return updRow ? { rows: [updRow], rowCount: 1 } : { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
  }

  it('SEM comissao_pct no patch -> o SET NÃO toca a coluna (não zera ninguém)', async () => {
    programUpdate({ ...RAW_ROW, nome: 'Ana B' });
    await update('clone_x', 1, { nome: 'Ana B' }, null);
    const upd = mockClientQuery.mock.calls.find((c) =>
      /UPDATE clone_colaboradores/i.test(String(c[0])),
    );
    // O RETURNING sempre lista comissao_pct (lemos de volta); o que NÃO pode aparecer é
    // a ATRIBUIÇÃO `comissao_pct =` no SET — isso sobrescreveria quem não enviou.
    expect(String(upd?.[0])).not.toContain('comissao_pct =');
  });

  it('COM comissao_pct -> entra no SET e volta number', async () => {
    programUpdate({ ...RAW_ROW, comissao_pct: '20.00' });
    const row = await update('clone_x', 1, { comissao_pct: 20 }, null);
    const upd = mockClientQuery.mock.calls.find((c) =>
      /UPDATE clone_colaboradores/i.test(String(c[0])),
    );
    expect(String(upd?.[0])).toContain('comissao_pct =');
    // O valor saneado (20) está entre os binds.
    expect((upd?.[1] as unknown[]).includes(20)).toBe(true);
    expect(row?.comissao_pct).toBe(20);
  });

  it('comissao_pct=0 explícito É aplicado (zerar é intencional, ≠ ausente)', async () => {
    programUpdate({ ...RAW_ROW, comissao_pct: '0.00' });
    await update('clone_x', 1, { comissao_pct: 0 }, null);
    const upd = mockClientQuery.mock.calls.find((c) =>
      /UPDATE clone_colaboradores/i.test(String(c[0])),
    );
    expect(String(upd?.[0])).toContain('comissao_pct =');
    expect((upd?.[1] as unknown[]).includes(0)).toBe(true);
  });

  it('valor inválido (não-number) -> ColaboradorRuleError, sem tocar o banco', async () => {
    programUpdate({ ...RAW_ROW });
    await expect(update('clone_x', 1, { comissao_pct: Number.NaN }, null)).rejects.toThrow(
      /comissao_pct/,
    );
    // Nem abriu transação (validação ANTES do connect).
    expect(mockConnect).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX: serviço vinculado ao colaborador TEM que existir no catálogo do clone
// (flow_clones.servicos). Antes, qualquer free-text ("cirurgia") era aceito.
describe('create — valida serviços contra o catálogo do clone', () => {
  /**
   * Programa create + o catálogo do clone. catalogoNomes = nomes em flow_clones.servicos
   * (como { nome } — formato real). BEGIN/COMMIT ok; INSERT devolve a linha dada.
   */
  function programCreateComCatalogo(
    insRow: Record<string, unknown>,
    catalogoNomes: string[],
  ): void {
    const servicos = catalogoNomes.map((nome) => ({ nome, preco_cents: 1000, duracao_min: 30 }));
    mockClientQuery.mockReset().mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT servicos FROM flow_clones/i.test(sql))
        return { rows: [{ servicos }], rowCount: 1 };
      if (/INSERT INTO clone_colaboradores/i.test(sql)) return { rows: [insRow], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  }

  it('serviço existente (case/trim tolerado) -> cria normal', async () => {
    programCreateComCatalogo({ ...RAW_ROW, servicos: ['Corte'] }, ['Corte', 'Barba']);
    // Input com caixa/espaço diferentes do catálogo deve casar.
    const row = await create(
      { slot: 'clone_x', tenantId: 'tid-1', nome: 'Ana', servicos: ['  corte '] },
      null,
    );
    expect(row.servicos).toEqual(['Corte']);
    // O INSERT foi disparado (não houve rejeição).
    const ins = mockClientQuery.mock.calls.find((c) =>
      /INSERT INTO clone_colaboradores/i.test(String(c[0])),
    );
    expect(ins).toBeTruthy();
  });

  it('serviço fora do catálogo ("cirurgia") -> ColaboradorRuleError unknown_servico, sem INSERT', async () => {
    programCreateComCatalogo({ ...RAW_ROW }, ['Corte', 'Barba']);
    await expect(
      create({ slot: 'clone_x', tenantId: 'tid-1', nome: 'Ana', servicos: ['cirurgia'] }, null),
    ).rejects.toMatchObject({ name: 'ColaboradorRuleError', code: 'unknown_servico' });
    // Nunca chegou ao INSERT; e deu ROLLBACK.
    const ins = mockClientQuery.mock.calls.find((c) =>
      /INSERT INTO clone_colaboradores/i.test(String(c[0])),
    );
    expect(ins).toBeUndefined();
    const rolledBack = mockClientQuery.mock.calls.some((c) => /ROLLBACK/i.test(String(c[0])));
    expect(rolledBack).toBe(true);
  });

  it('lista de serviços vazia -> NÃO consulta catálogo (fallback p/ todos)', async () => {
    programCreateComCatalogo({ ...RAW_ROW, servicos: [] }, ['Corte']);
    await create({ slot: 'clone_x', tenantId: 'tid-1', nome: 'Ana', servicos: [] }, null);
    const consultou = mockClientQuery.mock.calls.some((c) =>
      /SELECT servicos FROM flow_clones/i.test(String(c[0])),
    );
    expect(consultou).toBe(false);
  });
});

describe('update — valida serviços contra o catálogo do clone', () => {
  function programUpdateComCatalogo(
    updRow: Record<string, unknown> | null,
    catalogoNomes: string[],
  ): void {
    const servicos = catalogoNomes.map((nome) => ({ nome, preco_cents: 1000, duracao_min: 30 }));
    mockClientQuery.mockReset().mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT servicos FROM flow_clones/i.test(sql))
        return { rows: [{ servicos }], rowCount: 1 };
      if (/UPDATE clone_colaboradores/i.test(sql))
        return updRow ? { rows: [updRow], rowCount: 1 } : { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
  }

  it('troca p/ serviço existente -> UPDATE normal', async () => {
    programUpdateComCatalogo({ ...RAW_ROW, servicos: ['Barba'] }, ['Corte', 'Barba']);
    const row = await update('clone_x', 1, { servicos: ['Barba'] }, null);
    expect(row?.servicos).toEqual(['Barba']);
    const upd = mockClientQuery.mock.calls.find((c) =>
      /UPDATE clone_colaboradores/i.test(String(c[0])),
    );
    expect(upd).toBeTruthy();
  });

  it('troca p/ serviço fora do catálogo -> unknown_servico, sem UPDATE', async () => {
    programUpdateComCatalogo({ ...RAW_ROW }, ['Corte', 'Barba']);
    await expect(update('clone_x', 1, { servicos: ['cirurgia'] }, null)).rejects.toMatchObject({
      name: 'ColaboradorRuleError',
      code: 'unknown_servico',
    });
    const upd = mockClientQuery.mock.calls.find((c) =>
      /UPDATE clone_colaboradores/i.test(String(c[0])),
    );
    expect(upd).toBeUndefined();
  });

  it('patch SEM serviços -> não consulta catálogo (não bloqueia edição de nome)', async () => {
    programUpdateComCatalogo({ ...RAW_ROW, nome: 'Ana B' }, ['Corte']);
    await update('clone_x', 1, { nome: 'Ana B' }, null);
    const consultou = mockClientQuery.mock.calls.some((c) =>
      /SELECT servicos FROM flow_clones/i.test(String(c[0])),
    );
    expect(consultou).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SCRUM-143 — política de falha do reader compartilhado getAreaPromptCustomCartao.
// O MESMO reader alimenta o hot-path do bot (fail-OPEN) e os guards de ESCRITA que podem
// flipar cartao_mode→runtime (fail-CLOSED via opts.failClosed). Sem o fail-closed, um erro
// transitório de DB devolvia {promptCustom:false} e o guard NÃO bloqueava um flip indevido.
describe('getAreaPromptCustomCartao — política de falha (SCRUM-143)', () => {
  const CLONE_ROW = {
    area: 'Barbearia',
    prompt_custom: true,
    cartao_mode: 'baked',
    cartao_config: null,
    display_name: 'Barbearia X',
    cliente_nome: null,
    personalizacao: null,
  };

  it('default (fail-OPEN): erro de DB NÃO lança — cai no baked seguro (hot-path do bot)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection terminated'));
    const r = await getAreaPromptCustomCartao('clone_x');
    expect(r).toEqual({
      area: null,
      promptCustom: false,
      cartaoMode: 'baked',
      cartaoConfig: null,
      nomeNegocio: null,
    });
  });

  it('failClosed:true: erro de DB RELANÇA — guard de escrita aborta (nunca flipa às cegas)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection terminated'));
    await expect(getAreaPromptCustomCartao('clone_x', { failClosed: true })).rejects.toThrow(
      /connection terminated/,
    );
  });

  it('failClosed:true no caminho FELIZ: devolve o estado REAL (não muda o happy path)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [CLONE_ROW], rowCount: 1 });
    const r = await getAreaPromptCustomCartao('clone_x', { failClosed: true });
    expect(r.promptCustom).toBe(true);
    expect(r.cartaoMode).toBe('baked');
    expect(r.area).toBe('barbearia');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseCartaoConfig (via getAreaPromptCustomCartao) — SENTINELA de emoji desabilitado
// (CARTAO_EMOJI_DISABLED_SENTINEL) precisa SOBREVIVER ao parse defensivo do JSONB: é uma
// string NÃO-VAZIA como qualquer emoji, então cai no mesmo ramo `v !== ''` sem caso especial.
describe('getAreaPromptCustomCartao — cartao_config.emojis com o SENTINELA de desabilitado', () => {
  it('sentinela numa chave sobrevive ao parse (não é descartado como blank)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          area: 'barbearia',
          prompt_custom: true,
          cartao_mode: 'runtime',
          cartao_config: { template: 'padrao', emojis: { marca: '__off__', servico: '✂️' } },
          display_name: 'Barbearia X',
          cliente_nome: null,
          personalizacao: null,
        },
      ],
      rowCount: 1,
    });
    const r = await getAreaPromptCustomCartao('clone_x');
    expect(r.cartaoConfig?.emojis?.marca).toBe('__off__');
    expect(r.cartaoConfig?.emojis?.servico).toBe('✂️');
  });

  it('string em BRANCO acidental (não o sentinela) continua descartada — guard antigo preservado', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          area: 'barbearia',
          prompt_custom: true,
          cartao_mode: 'runtime',
          cartao_config: { emojis: { marca: '' } },
          display_name: 'Barbearia X',
          cliente_nome: null,
          personalizacao: null,
        },
      ],
      rowCount: 1,
    });
    const r = await getAreaPromptCustomCartao('clone_x');
    // '' descartado no parse → chave nem existe no config → herda default no merge (mergeEmojis).
    expect(r.cartaoConfig?.emojis?.marca).toBeUndefined();
  });
});
