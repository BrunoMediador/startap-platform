/**
 * Testes do POST /portal/atendimentos + GET /portal/relatorios/{faturamento,comissao}
 * (ADR 0026, Fase 1 MVP).
 *
 * Invariantes cobertos:
 *  - GATING: flag ATENDIMENTOS_ENABLED OFF -> 404 (não vaza; não toca data layer).
 *  - DOIS CENÁRIOS: SOLO (colaborador_id ausente) registra sem comissão; EMPRESA
 *    (colaborador_id) é validado pertencer ao slot ANTES de gravar (anti-IDOR).
 *  - Anti-IDOR: colaborador_id que não pertence ao slot -> 400 (não vaza cross-tenant).
 *  - Isolamento: slot + tenant_id SEMPRE da sessão/clone — nunca do body/query.
 *  - strict: campo extra (slot/tenant_id/comissao_cents forjado) -> 400.
 *  - Relatórios: período inválido -> 400; escopo slot+tenant repassado à data layer.
 *
 * DB e config mockados (mesmo padrão de portal-equipe.test.ts). A flag é variável por
 * teste (reconfigura o mock de config).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  configMock,
  getScopeBySlotMock,
  getColaboradorComissaoMock,
  createAtendimentoMock,
  getFaturamentoMock,
  getComissaoMock,
} = vi.hoisted(() => ({
  configMock: { ATENDIMENTOS_ENABLED: true } as { ATENDIMENTOS_ENABLED: boolean },
  getScopeBySlotMock: vi.fn(),
  getColaboradorComissaoMock: vi.fn(),
  createAtendimentoMock: vi.fn(),
  getFaturamentoMock: vi.fn(),
  getComissaoMock: vi.fn(),
}));

vi.mock('../config.js', () => ({ config: configMock }));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('@startap/db', () => ({
  cloneColaboradores: {
    getScopeBySlot: (...a: unknown[]) => getScopeBySlotMock(...a),
  },
  atendimentos: {
    getColaboradorComissao: (...a: unknown[]) => getColaboradorComissaoMock(...a),
    createAtendimento: (...a: unknown[]) => createAtendimentoMock(...a),
    getFaturamento: (...a: unknown[]) => getFaturamentoMock(...a),
    getComissao: (...a: unknown[]) => getComissaoMock(...a),
  },
  portalUsers: { getSlotForActivePortalUser: vi.fn() },
}));

const injectedSlot = 'clone_cirilo_x';
const injectedTenant = 'tid-cirilo';
vi.mock('../lib/tenant.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/tenant.js')>('../lib/tenant.js');
  return {
    ...actual,
    withTenant: vi.fn(async (req: { tenant?: unknown }) => {
      req.tenant = { slot: injectedSlot, userId: 7, username: 'cirilo', sid: 'sid-x' };
    }),
  };
});

import Fastify, { type FastifyInstance } from 'fastify';
import { portalAtendimentosRoutes } from './portal-atendimentos.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalAtendimentosRoutes);
  await app.ready();
  return app;
}

const ROW = {
  id: 1,
  slot: injectedSlot,
  gcal_event_id: null,
  cliente_nome: null,
  cliente_contato: null,
  servico_nome: 'Corte',
  valor_cents: 5000,
  desconto_cents: 0,
  forma_pagamento: 'pix',
  colaborador_id: null,
  comissao_pct: null,
  comissao_cents: 0,
  status: 'realizado',
  data: '2026-06-23',
  created_at: '2026-06-23T00:00:00Z',
  updated_at: '2026-06-23T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  configMock.ATENDIMENTOS_ENABLED = true;
  getScopeBySlotMock.mockResolvedValue({
    product_type: 'individual',
    seat_cap: null,
    tenant_id: injectedTenant,
  });
});

describe('gating', () => {
  it('404 em POST quando ATENDIMENTOS_ENABLED está OFF', async () => {
    configMock.ATENDIMENTOS_ENABLED = false;
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/atendimentos',
      payload: { valor_cents: 5000 },
    });
    expect(res.statusCode).toBe(404);
    expect(getScopeBySlotMock).not.toHaveBeenCalled();
    expect(createAtendimentoMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('404 nos relatórios quando a flag está OFF', async () => {
    configMock.ATENDIMENTOS_ENABLED = false;
    const app = await buildApp();
    const r1 = await app.inject({
      method: 'GET',
      url: '/portal/relatorios/faturamento?de=2026-06-01&ate=2026-06-30',
    });
    const r2 = await app.inject({
      method: 'GET',
      url: '/portal/relatorios/comissao?de=2026-06-01&ate=2026-06-30',
    });
    expect(r1.statusCode).toBe(404);
    expect(r2.statusCode).toBe(404);
    expect(getFaturamentoMock).not.toHaveBeenCalled();
    expect(getComissaoMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('409 quando o clone não tem tenant_id (dado inconsistente)', async () => {
    getScopeBySlotMock.mockResolvedValue({
      product_type: 'individual',
      seat_cap: null,
      tenant_id: null,
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/atendimentos',
      payload: { valor_cents: 5000 },
    });
    expect(res.statusCode).toBe(409);
    expect(createAtendimentoMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('POST /portal/atendimentos — SOLO', () => {
  it('201: registra com slot+tenant da sessão, sem colaborador (SOLO)', async () => {
    createAtendimentoMock.mockResolvedValue(ROW);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/atendimentos',
      payload: { servico_nome: 'Corte', valor_cents: 5000, forma_pagamento: 'pix' },
    });
    expect(res.statusCode).toBe(201);
    expect(getColaboradorComissaoMock).not.toHaveBeenCalled(); // SOLO não valida colaborador
    expect(createAtendimentoMock).toHaveBeenCalledTimes(1);
    // Isolamento: slot+tenant da SESSÃO, nunca do body.
    expect(createAtendimentoMock.mock.calls[0][0]).toMatchObject({
      slot: injectedSlot,
      tenantId: injectedTenant,
      colaboradorId: null,
      valorCents: 5000,
    });
    await app.close();
  });

  it('400: campo extra (strict — ex.: tentar forjar tenant_id/comissao_cents)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/atendimentos',
      payload: { valor_cents: 5000, tenant_id: 'forjado', comissao_cents: 99999 },
    });
    expect(res.statusCode).toBe(400);
    expect(createAtendimentoMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('400: valor_cents ausente (schema)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/atendimentos',
      payload: { servico_nome: 'Corte' },
    });
    expect(res.statusCode).toBe(400);
    expect(createAtendimentoMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('POST /portal/atendimentos — EMPRESA (com colaborador)', () => {
  it('201: valida colaborador pertence ao slot e registra com comissão', async () => {
    getColaboradorComissaoMock.mockResolvedValue({ belongs: true, comissaoPct: 40 });
    createAtendimentoMock.mockResolvedValue({
      ...ROW,
      colaborador_id: 9,
      comissao_pct: '40.00',
      comissao_cents: 2000,
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/atendimentos',
      payload: { valor_cents: 5000, colaborador_id: 9, forma_pagamento: 'pix' },
    });
    expect(res.statusCode).toBe(201);
    // Anti-IDOR: validou colaborador no slot da SESSÃO.
    expect(getColaboradorComissaoMock).toHaveBeenCalledWith(injectedSlot, 9);
    expect(createAtendimentoMock.mock.calls[0][0]).toMatchObject({
      slot: injectedSlot,
      tenantId: injectedTenant,
      colaboradorId: 9,
    });
    await app.close();
  });

  it('400 (anti-IDOR): colaborador_id de OUTRO tenant não pertence ao slot', async () => {
    getColaboradorComissaoMock.mockResolvedValue({ belongs: false, comissaoPct: null });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/atendimentos',
      payload: { valor_cents: 5000, colaborador_id: 999 },
    });
    expect(res.statusCode).toBe(400);
    expect(createAtendimentoMock).not.toHaveBeenCalled(); // não grava com colaborador alheio
    await app.close();
  });

  // O id de clone_colaboradores é BIGSERIAL -> o driver pg serializa como STRING ("4");
  // o caller pode reenviar esse id como string-numérica. z.coerce deve aceitar e coagir,
  // mas ainda rejeitar lixo não-numérico (evita 400 espúrio no estabelecimento/comissão).
  it('201: aceita colaborador_id como STRING-numérica "9" e coage pra 9 (id vem string do pg)', async () => {
    getColaboradorComissaoMock.mockResolvedValue({ belongs: true, comissaoPct: 40 });
    createAtendimentoMock.mockResolvedValue({
      ...ROW,
      colaborador_id: 9,
      comissao_pct: '40.00',
      comissao_cents: 2000,
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/atendimentos',
      payload: { valor_cents: 5000, colaborador_id: '9', forma_pagamento: 'pix' },
    });
    expect(res.statusCode).toBe(201);
    // Coagido pra Number ANTES do anti-IDOR: a data layer recebe 9, não "9".
    expect(getColaboradorComissaoMock).toHaveBeenCalledWith(injectedSlot, 9);
    expect(createAtendimentoMock.mock.calls[0][0]).toMatchObject({
      slot: injectedSlot,
      tenantId: injectedTenant,
      colaboradorId: 9,
    });
    await app.close();
  });

  it('400: colaborador_id lixo não-numérico ("abc") segue rejeitado pelo schema', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/atendimentos',
      payload: { valor_cents: 5000, colaborador_id: 'abc' },
    });
    expect(res.statusCode).toBe(400);
    expect(getColaboradorComissaoMock).not.toHaveBeenCalled();
    expect(createAtendimentoMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('GET /portal/relatorios/faturamento', () => {
  it('200: repassa período + escopo slot+tenant à data layer', async () => {
    getFaturamentoMock.mockResolvedValue({
      de: '2026-06-01',
      ate: '2026-06-30',
      total_cents: 5000,
      count: 1,
      ticket_medio_cents: 5000,
      por_forma_pagamento: [],
      por_profissional: [],
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/relatorios/faturamento?de=2026-06-01&ate=2026-06-30',
    });
    expect(res.statusCode).toBe(200);
    expect(getFaturamentoMock).toHaveBeenCalledWith(
      injectedSlot,
      injectedTenant,
      '2026-06-01',
      '2026-06-30',
    );
    await app.close();
  });

  it('400: período inválido (de fora do formato)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/relatorios/faturamento?de=ontem&ate=2026-06-30',
    });
    expect(res.statusCode).toBe(400);
    expect(getFaturamentoMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('GET /portal/relatorios/comissao', () => {
  it('200: SOLO retorna vazio/0 (sem profissionais), escopado', async () => {
    getComissaoMock.mockResolvedValue({
      de: '2026-06-01',
      ate: '2026-06-30',
      total_cents: 0,
      por_profissional: [],
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/relatorios/comissao?de=2026-06-01&ate=2026-06-30',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total_cents).toBe(0);
    expect(getComissaoMock).toHaveBeenCalledWith(
      injectedSlot,
      injectedTenant,
      '2026-06-01',
      '2026-06-30',
    );
    await app.close();
  });
});
