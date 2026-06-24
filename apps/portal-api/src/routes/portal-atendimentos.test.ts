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
  listAtendimentosMock,
  getAtendimentoByEventMock,
  patchAtendimentoMock,
  softDeleteByIdMock,
} = vi.hoisted(() => ({
  configMock: { ATENDIMENTOS_ENABLED: true } as { ATENDIMENTOS_ENABLED: boolean },
  getScopeBySlotMock: vi.fn(),
  getColaboradorComissaoMock: vi.fn(),
  createAtendimentoMock: vi.fn(),
  getFaturamentoMock: vi.fn(),
  getComissaoMock: vi.fn(),
  listAtendimentosMock: vi.fn(),
  getAtendimentoByEventMock: vi.fn(),
  patchAtendimentoMock: vi.fn(),
  softDeleteByIdMock: vi.fn(),
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
    listAtendimentos: (...a: unknown[]) => listAtendimentosMock(...a),
    getAtendimentoByEvent: (...a: unknown[]) => getAtendimentoByEventMock(...a),
    patchAtendimento: (...a: unknown[]) => patchAtendimentoMock(...a),
    softDeleteAtendimentoById: (...a: unknown[]) => softDeleteByIdMock(...a),
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
  it('200: SOLO retorna vazio/0, escopado, balde DEFAULT=faturado quando ausente', async () => {
    getComissaoMock.mockResolvedValue({
      de: '2026-06-01',
      ate: '2026-06-30',
      balde: 'faturado',
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
    expect(res.json().balde).toBe('faturado');
    // balde ausente -> default 'faturado' (comportamento histórico inalterado).
    expect(getComissaoMock).toHaveBeenCalledWith(
      injectedSlot,
      injectedTenant,
      '2026-06-01',
      '2026-06-30',
      'faturado',
    );
    await app.close();
  });

  it('200: balde=previsao repassa o balde à data layer (comissão projetada)', async () => {
    getComissaoMock.mockResolvedValue({
      de: '2026-06-01',
      ate: '2026-06-30',
      balde: 'previsao',
      total_cents: 4000,
      por_profissional: [
        {
          colaborador_id: 9,
          profissional_nome: 'Eduardo',
          total_bruto_cents: 10000,
          comissao_pct: 40,
          comissao_cents: 4000,
          count: 3,
        },
      ],
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/relatorios/comissao?balde=previsao&de=2026-06-01&ate=2026-06-30',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().balde).toBe('previsao');
    expect(res.json().total_cents).toBe(4000);
    expect(res.json().por_profissional[0]).toMatchObject({
      colaborador_id: 9,
      comissao_pct: 40,
      comissao_cents: 4000,
      total_bruto_cents: 10000,
    });
    expect(getComissaoMock).toHaveBeenCalledWith(
      injectedSlot,
      injectedTenant,
      '2026-06-01',
      '2026-06-30',
      'previsao',
    );
    await app.close();
  });

  it('400: balde inválido (fora de previsao|faturado)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/relatorios/comissao?balde=tudo&de=2026-06-01&ate=2026-06-30',
    });
    expect(res.statusCode).toBe(400);
    expect(getComissaoMock).not.toHaveBeenCalled();
    await app.close();
  });
});

// ── ADR 0027 — GET por balde / PATCH (sticky) / DELETE (soft-delete) ─────────────────
describe('GET /portal/atendimentos — balde previsao/faturado', () => {
  it('200: balde=previsao repassa escopo+período à data layer', async () => {
    listAtendimentosMock.mockResolvedValue({ atendimentos: [], total_cents: 0 });
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/atendimentos?balde=previsao&de=2026-06-01&ate=2026-06-30',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ atendimentos: [], total_cents: 0 });
    expect(listAtendimentosMock).toHaveBeenCalledWith(
      injectedSlot,
      injectedTenant,
      'previsao',
      '2026-06-01',
      '2026-06-30',
    );
    await app.close();
  });

  it('200: balde=faturado devolve linhas + total', async () => {
    listAtendimentosMock.mockResolvedValue({
      atendimentos: [{ ...ROW, origem: 'manual', dirty_fields: [], inicio_at: null, fim_at: null }],
      total_cents: 5000,
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/atendimentos?balde=faturado&de=2026-06-01&ate=2026-06-30',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total_cents).toBe(5000);
    expect(listAtendimentosMock.mock.calls[0][2]).toBe('faturado');
    await app.close();
  });

  it('400: balde inválido', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/atendimentos?balde=tudo&de=2026-06-01&ate=2026-06-30',
    });
    expect(res.statusCode).toBe(400);
    expect(listAtendimentosMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('404 quando a flag está OFF', async () => {
    configMock.ATENDIMENTOS_ENABLED = false;
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/atendimentos?balde=faturado&de=2026-06-01&ate=2026-06-30',
    });
    expect(res.statusCode).toBe(404);
    expect(listAtendimentosMock).not.toHaveBeenCalled();
    await app.close();
  });
});

// ── MUDANÇA 2: GET /portal/atendimentos/by-evento/:eventId (pré-req do frontend) ─────
describe('GET /portal/atendimentos/by-evento/:eventId — resolve a linha pelo gcal_event_id', () => {
  const ENRICHED = {
    id: 9,
    data: '2026-06-23',
    inicio_at: '2026-06-23T13:00:00Z',
    fim_at: '2026-06-23T13:30:00Z',
    cliente_nome: null,
    cliente_contato: null,
    servico_nome: 'Corte',
    valor_cents: 5000,
    desconto_cents: 0,
    forma_pagamento: null,
    colaborador_id: 1,
    profissional_nome: 'Eduardo',
    origem: 'agenda',
    dirty_fields: [],
    status: 'agendado',
  };

  it('200: devolve a AtendimentoListRow DIRETO (sem envelope), escopo slot+tenant da sessão', async () => {
    getAtendimentoByEventMock.mockResolvedValue(ENRICHED);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/atendimentos/by-evento/evt_abc' });
    expect(res.statusCode).toBe(200);
    // CONTRATO: a Row vem direto (front consome AtendimentoListRow | 404).
    expect(res.json()).toMatchObject({
      id: 9,
      profissional_nome: 'Eduardo',
      servico_nome: 'Corte',
    });
    // Anti-IDOR: slot+tenant da SESSÃO, eventId do path.
    expect(getAtendimentoByEventMock).toHaveBeenCalledWith(injectedSlot, injectedTenant, 'evt_abc');
    await app.close();
  });

  it('404 (anti-IDOR): eventId fora do escopo / inexistente -> data layer null -> 404', async () => {
    getAtendimentoByEventMock.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/atendimentos/by-evento/evt_de_outro_tenant',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('400: eventId com caracteres inválidos -> não toca a data layer', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/atendimentos/by-evento/evt%20com%20espaco%21',
    });
    expect(res.statusCode).toBe(400);
    expect(getAtendimentoByEventMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('404 quando a flag ATENDIMENTOS_ENABLED está OFF (gate)', async () => {
    configMock.ATENDIMENTOS_ENABLED = false;
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/atendimentos/by-evento/evt_abc' });
    expect(res.statusCode).toBe(404);
    expect(getAtendimentoByEventMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('PATCH /portal/atendimentos/:id — sticky', () => {
  it('200: edita valor + pina dirty_fields; devolve Row enriquecida (profissional_nome); id coage string->number', async () => {
    // Row enriquecida (igual ao GET list): a data layer já traz profissional_nome via JOIN.
    patchAtendimentoMock.mockResolvedValue({
      id: 9,
      data: '2026-06-23',
      inicio_at: null,
      fim_at: null,
      cliente_nome: null,
      cliente_contato: null,
      servico_nome: 'Corte',
      valor_cents: 7000,
      desconto_cents: 0,
      forma_pagamento: 'pix',
      colaborador_id: 9,
      profissional_nome: 'Eduardo',
      origem: 'agenda',
      dirty_fields: ['valor_cents'],
      status: 'agendado',
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/atendimentos/9',
      payload: { valor_cents: 7000 },
    });
    expect(res.statusCode).toBe(200);
    const atend = res.json().atendimento;
    expect(atend.dirty_fields).toEqual(['valor_cents']);
    // QA nit P3: a resposta do PATCH carrega profissional_nome (não pisca "Sem profissional").
    expect(atend.profissional_nome).toBe('Eduardo');
    expect(atend.colaborador_id).toBe(9);
    // id coagido pra Number; escopo slot+tenant da SESSÃO (não do body).
    expect(patchAtendimentoMock).toHaveBeenCalledWith(injectedSlot, injectedTenant, 9, {
      valorCents: 7000,
      descontoCents: undefined,
      formaPagamento: undefined,
      servicoNome: undefined,
      clienteNome: undefined,
    });
    await app.close();
  });

  it('404 (anti-IDOR): id de outro tenant -> data layer retorna null -> 404', async () => {
    patchAtendimentoMock.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/atendimentos/999',
      payload: { valor_cents: 1 },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('400: body vazio (nenhum campo)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/atendimentos/9',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(patchAtendimentoMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('400 (strict): tentar forjar campo proibido (dirty_fields/origem/comissao_cents)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/atendimentos/9',
      payload: { valor_cents: 1, dirty_fields: ['x'], comissao_cents: 99999 },
    });
    expect(res.statusCode).toBe(400);
    expect(patchAtendimentoMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('404 quando a flag está OFF', async () => {
    configMock.ATENDIMENTOS_ENABLED = false;
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/atendimentos/9',
      payload: { valor_cents: 1 },
    });
    expect(res.statusCode).toBe(404);
    expect(patchAtendimentoMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('DELETE /portal/atendimentos/:id — soft-delete', () => {
  it('200: soft-delete escopado por slot+tenant', async () => {
    softDeleteByIdMock.mockResolvedValue(true);
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/portal/atendimentos/9' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(softDeleteByIdMock).toHaveBeenCalledWith(injectedSlot, injectedTenant, 9);
    await app.close();
  });

  it('404 (anti-IDOR / idempotente): ausente ou já deletado -> false -> 404', async () => {
    softDeleteByIdMock.mockResolvedValue(false);
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/portal/atendimentos/999' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('404 quando a flag está OFF', async () => {
    configMock.ATENDIMENTOS_ENABLED = false;
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/portal/atendimentos/9' });
    expect(res.statusCode).toBe(404);
    expect(softDeleteByIdMock).not.toHaveBeenCalled();
    await app.close();
  });
});
