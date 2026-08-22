/**
 * CRM Clientes — contrato de rota backend.
 *
 * Cobertura principal:
 *  - flag OFF -> 404 sem tocar data layer;
 *  - owner usa slot/tenant da sessão e lista/perfila/edita no escopo correto;
 *  - colaborador só lê sob /portal/colaborador/clientes, no próprio escopo, sem nota interna.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  configMock,
  getScopeBySlotMock,
  seedClientesMock,
  listClientesOwnerMock,
  listClientesColaboradorMock,
  listAniversariantesOwnerMock,
  listAniversariantesColaboradorMock,
  listSemRetornoOwnerMock,
  listSemRetornoColaboradorMock,
  getClientesResumoMock,
  listAniversariantesCalendarioMock,
  getClienteAvatarTargetMock,
  getProfilePictureMock,
  redisMock,
  getClienteOwnerMock,
  getClienteColaboradorMock,
  listHistoricoOwnerMock,
  listHistoricoColaboradorMock,
  updateClienteOwnerMock,
} = vi.hoisted(() => ({
  configMock: {
    CRM_CLIENTES_ENABLED: true,
    COLABORADOR_PORTAL_ENABLED: true,
    RANKING_SEM_RETORNO_ENABLED: true,
    CRM_ANIVERSARIANTES_ENABLED: true,
  } as Record<string, unknown>,
  getScopeBySlotMock: vi.fn(),
  seedClientesMock: vi.fn(),
  listClientesOwnerMock: vi.fn(),
  listClientesColaboradorMock: vi.fn(),
  listAniversariantesOwnerMock: vi.fn(),
  listAniversariantesColaboradorMock: vi.fn(),
  listSemRetornoOwnerMock: vi.fn(),
  listSemRetornoColaboradorMock: vi.fn(),
  getClientesResumoMock: vi.fn(),
  listAniversariantesCalendarioMock: vi.fn(),
  getClienteAvatarTargetMock: vi.fn(),
  getProfilePictureMock: vi.fn(),
  redisMock: { get: vi.fn(), set: vi.fn() },
  getClienteOwnerMock: vi.fn(),
  getClienteColaboradorMock: vi.fn(),
  listHistoricoOwnerMock: vi.fn(),
  listHistoricoColaboradorMock: vi.fn(),
  updateClienteOwnerMock: vi.fn(),
}));

vi.mock('../config.js', () => ({ config: configMock }));
vi.mock('@startap/db', () => ({
  cloneColaboradores: {
    getScopeBySlot: (...a: unknown[]) => getScopeBySlotMock(...a),
  },
  clientes: {
    seedClientesFromAtendimentos: (...a: unknown[]) => seedClientesMock(...a),
    listClientesForOwner: (...a: unknown[]) => listClientesOwnerMock(...a),
    listClientesForColaborador: (...a: unknown[]) => listClientesColaboradorMock(...a),
    listClientesAniversariantesForOwner: (...a: unknown[]) => listAniversariantesOwnerMock(...a),
    listClientesAniversariantesForColaborador: (...a: unknown[]) =>
      listAniversariantesColaboradorMock(...a),
    listClientesSemRetornoForOwner: (...a: unknown[]) => listSemRetornoOwnerMock(...a),
    listClientesSemRetornoForColaborador: (...a: unknown[]) => listSemRetornoColaboradorMock(...a),
    getClientesResumo: (...a: unknown[]) => getClientesResumoMock(...a),
    listClientesAniversariantesCalendario: (...a: unknown[]) =>
      listAniversariantesCalendarioMock(...a),
    getClienteAvatarTargetForOwner: (...a: unknown[]) => getClienteAvatarTargetMock(...a),
    getClienteProfileForOwner: (...a: unknown[]) => getClienteOwnerMock(...a),
    getClienteProfileForColaborador: (...a: unknown[]) => getClienteColaboradorMock(...a),
    listClienteHistoricoForOwner: (...a: unknown[]) => listHistoricoOwnerMock(...a),
    listClienteHistoricoForColaborador: (...a: unknown[]) => listHistoricoColaboradorMock(...a),
    updateClienteProfileForOwner: (...a: unknown[]) => updateClienteOwnerMock(...a),
  },
}));
vi.mock('@startap/integrations/waha', () => ({
  getProfilePicture: (...a: unknown[]) => getProfilePictureMock(...a),
}));
vi.mock('../lib/session.js', () => ({ getRedis: () => redisMock }));
vi.mock('../lib/tenant.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/tenant.js')>('../lib/tenant.js');
  return {
    ...actual,
    withTenant: vi.fn(async (req: { tenant?: unknown }) => {
      req.tenant = { slot: 'clone_owner', userId: 7, username: 'owner', sid: 'sid-owner' };
    }),
    withColaborador: vi.fn(async (req: { colaborador?: unknown }) => {
      req.colaborador = {
        slot: 'clone_owner',
        tenantId: 'tid-owner',
        colaboradorId: 9,
        username: 'barbeiro',
        nome: 'Barbeiro',
        sid: 'sid-colab',
      };
    }),
  };
});

import Fastify, { type FastifyInstance } from 'fastify';
import { portalClientesRoutes } from './portal-clientes.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalClientesRoutes);
  await app.ready();
  return app;
}

const OWNER_LIST = {
  clientes: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      nome: 'Joao',
      telefone_masked: '+55 31 •••••-••42',
      aniversario_mmdd: '08-21',
      cidade: 'Belo Horizonte',
      total_atendimentos: 3,
      ultima_interacao_at: '2026-08-20T10:00:00.000Z',
      ultimo_profissional_nome: 'Bene',
    },
  ],
  total: 1,
  limit: 20,
  offset: 0,
};

const OWNER_PROFILE = {
  id: '11111111-1111-4111-8111-111111111111',
  nome: 'Joao',
  telefone: '553199998842',
  aniversario_mmdd: '08-21',
  cidade: 'Belo Horizonte',
  nota_interna: 'Cliente VIP',
  total_atendimentos: 3,
  ultima_interacao_at: '2026-08-20T10:00:00.000Z',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-20T10:00:00.000Z',
};

const COLAB_PROFILE = {
  id: '11111111-1111-4111-8111-111111111111',
  nome: 'Joao',
  telefone: '553199998842',
  aniversario_mmdd: '08-21',
  cidade: 'Belo Horizonte',
  total_atendimentos: 2,
  ultima_interacao_at: '2026-08-20T10:00:00.000Z',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-20T10:00:00.000Z',
};

const SEM_RETORNO_LIST = {
  clientes: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      nome: 'Maria',
      telefone_masked: '+55 31 •••••-••88',
      ultimo_atendimento_at: '2026-08-01T13:00:00.000Z',
      dias_sem_retorno: 20,
      ultimo_profissional_nome: 'Bene',
    },
  ],
  total: 1,
  limit: 20,
  offset: 0,
};

const ANIVERSARIANTES_LIST = {
  clientes: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      nome: 'Ana',
      telefone_masked: '+55 31 •••••-••55',
      aniversario_mmdd: '02-29',
      dias_ate_aniversario: 3,
      proxima_ocorrencia_local_date: '2028-02-29',
      ultimo_profissional_nome: 'Bene',
    },
  ],
  total: 1,
  limit: 20,
  offset: 0,
};

const HISTORICO = [
  {
    atendimento_id: 91,
    data: '2026-08-20',
    inicio_at: '2026-08-20T10:00:00.000Z',
    fim_at: '2026-08-20T10:30:00.000Z',
    cliente_nome: 'Joao',
    servico_nome: 'Corte',
    valor_cents: 5000,
    desconto_cents: 0,
    forma_pagamento: 'pix',
    status: 'realizado',
    origem: 'manual',
    colaborador_id: 9,
    profissional_nome: 'Bene',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  configMock.CRM_CLIENTES_ENABLED = true;
  configMock.COLABORADOR_PORTAL_ENABLED = true;
  configMock.RANKING_SEM_RETORNO_ENABLED = true;
  configMock.CRM_ANIVERSARIANTES_ENABLED = true;
  getScopeBySlotMock.mockResolvedValue({
    product_type: 'estabelecimento',
    seat_cap: 2,
    tenant_id: 'tid-owner',
    timezone: 'America/Sao_Paulo',
  });
  listClientesOwnerMock.mockResolvedValue(OWNER_LIST);
  listClientesColaboradorMock.mockResolvedValue(OWNER_LIST);
  listAniversariantesOwnerMock.mockImplementation(
    ({ limit, offset }: { limit?: number; offset?: number }) =>
      Promise.resolve({
        ...ANIVERSARIANTES_LIST,
        limit: limit ?? ANIVERSARIANTES_LIST.limit,
        offset: offset ?? ANIVERSARIANTES_LIST.offset,
      }),
  );
  listAniversariantesColaboradorMock.mockImplementation(
    ({ limit, offset }: { limit?: number; offset?: number }) =>
      Promise.resolve({
        ...ANIVERSARIANTES_LIST,
        limit: limit ?? ANIVERSARIANTES_LIST.limit,
        offset: offset ?? ANIVERSARIANTES_LIST.offset,
      }),
  );
  listSemRetornoOwnerMock.mockImplementation(
    ({ limit, offset }: { limit?: number; offset?: number }) =>
      Promise.resolve({
        ...SEM_RETORNO_LIST,
        limit: limit ?? SEM_RETORNO_LIST.limit,
        offset: offset ?? SEM_RETORNO_LIST.offset,
      }),
  );
  listSemRetornoColaboradorMock.mockImplementation(
    ({ limit, offset }: { limit?: number; offset?: number }) =>
      Promise.resolve({
        ...SEM_RETORNO_LIST,
        limit: limit ?? SEM_RETORNO_LIST.limit,
        offset: offset ?? SEM_RETORNO_LIST.offset,
      }),
  );
  getClienteOwnerMock.mockResolvedValue(OWNER_PROFILE);
  getClienteColaboradorMock.mockResolvedValue(COLAB_PROFILE);
  listHistoricoOwnerMock.mockResolvedValue(HISTORICO);
  listHistoricoColaboradorMock.mockResolvedValue(HISTORICO);
  updateClienteOwnerMock.mockResolvedValue(OWNER_PROFILE);
  getClientesResumoMock.mockResolvedValue({
    total_clientes: 1,
    aniversariantes_hoje: 0,
    sem_retorno: 1,
  });
  listAniversariantesCalendarioMock.mockResolvedValue({
    ...ANIVERSARIANTES_LIST,
    periodo_inicio: '2026-08-17',
    periodo_fim: '2026-08-23',
  });
  redisMock.get.mockResolvedValue(null);
  redisMock.set.mockResolvedValue('OK');
  getClienteAvatarTargetMock.mockResolvedValue({
    telefoneCanonico: '553199998842',
    wahaSessao: 'sess_owner',
    wahaShardId: 0,
  });
  getProfilePictureMock.mockResolvedValue(null);
});

describe('gating', () => {
  it('404 owner quando CRM_CLIENTES_ENABLED está OFF', async () => {
    configMock.CRM_CLIENTES_ENABLED = false;
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/clientes' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'feature_off' });
    expect(seedClientesMock).not.toHaveBeenCalled();
    expect(listClientesOwnerMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('404 colaborador quando COLABORADOR_PORTAL_ENABLED está OFF', async () => {
    configMock.COLABORADOR_PORTAL_ENABLED = false;
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/colaborador/clientes' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'feature_off' });
    expect(seedClientesMock).not.toHaveBeenCalled();
    expect(listClientesColaboradorMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('404 ranking owner quando RANKING_SEM_RETORNO_ENABLED está OFF', async () => {
    configMock.RANKING_SEM_RETORNO_ENABLED = false;
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/clientes/sem-retorno' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'feature_off' });
    expect(listSemRetornoOwnerMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('404 ranking colaborador quando RANKING_SEM_RETORNO_ENABLED está OFF', async () => {
    configMock.RANKING_SEM_RETORNO_ENABLED = false;
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/colaborador/clientes/sem-retorno',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'feature_off' });
    expect(listSemRetornoColaboradorMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('404 aniversariantes owner quando CRM_ANIVERSARIANTES_ENABLED está OFF', async () => {
    configMock.CRM_ANIVERSARIANTES_ENABLED = false;
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/clientes/aniversariantes?modo=proximos&dias=7',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'feature_off' });
    expect(listAniversariantesOwnerMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('404 aniversariantes colaborador quando CRM_ANIVERSARIANTES_ENABLED está OFF', async () => {
    configMock.CRM_ANIVERSARIANTES_ENABLED = false;
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/colaborador/clientes/aniversariantes?modo=proximos&dias=7',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'feature_off' });
    expect(listAniversariantesColaboradorMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('owner', () => {
  it('lista no escopo da sessão sem expor telefone raw nem semear no GET', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/clientes?q=joao&limit=10&offset=5',
    });

    expect(res.statusCode).toBe(200);
    expect(getScopeBySlotMock).toHaveBeenCalledWith('clone_owner');
    expect(seedClientesMock).not.toHaveBeenCalled();
    expect(listClientesOwnerMock).toHaveBeenCalledWith({
      slot: 'clone_owner',
      tenantId: 'tid-owner',
      timezone: 'America/Sao_Paulo',
      search: 'joao',
      nome: undefined,
      telefone: undefined,
      ultimoAtendimento: undefined,
      periodoInicio: undefined,
      periodoFim: undefined,
      visitas: undefined,
      ordenarPor: undefined,
      ordem: undefined,
      limit: 10,
      offset: 5,
    });
    const body = res.json();
    expect(body).toEqual(OWNER_LIST);
    expect(body.clientes[0]?.telefone_masked).toBe('+55 31 •••••-••42');
    expect(body.clientes[0]?.telefone).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('553199998842');
    await app.close();
  });

  it('aplica filtros de coluna E, período e ordenação somente no servidor', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/clientes?nome=maria&telefone=3199&ultimo_atendimento=periodo&periodo_inicio=2026-08-01&periodo_fim=2026-08-20&visitas=duas_a_cinco&ordenar_por=visitas&ordem=asc',
    });
    expect(res.statusCode).toBe(200);
    expect(listClientesOwnerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        slot: 'clone_owner',
        tenantId: 'tid-owner',
        timezone: 'America/Sao_Paulo',
        nome: 'maria',
        telefone: '3199',
        ultimoAtendimento: 'periodo',
        periodoInicio: '2026-08-01',
        periodoFim: '2026-08-20',
        visitas: 'duas_a_cinco',
        ordenarPor: 'visitas',
        ordem: 'asc',
      }),
    );
    await app.close();
  });

  it('rejeita filtros de período incompletos e escopo forjado', async () => {
    const app = await buildApp();
    const incomplete = await app.inject({
      method: 'GET',
      url: '/portal/clientes?ultimo_atendimento=periodo&periodo_inicio=2026-08-01',
    });
    const forged = await app.inject({ method: 'GET', url: '/portal/clientes?slot=outro' });
    expect(incomplete.statusCode).toBe(400);
    expect(forged.statusCode).toBe(400);
    await app.close();
  });

  it('retorna resumo escopado e calendário navegável ancorado em data', async () => {
    const app = await buildApp();
    const resumo = await app.inject({ method: 'GET', url: '/portal/clientes/resumo' });
    const calendario = await app.inject({
      method: 'GET',
      url: '/portal/clientes/aniversariantes?modo=calendario&visao=semana&ancora=2026-08-21',
    });
    expect(resumo.statusCode).toBe(200);
    expect(getClientesResumoMock).toHaveBeenCalledWith({
      slot: 'clone_owner',
      tenantId: 'tid-owner',
      timezone: 'America/Sao_Paulo',
    });
    expect(calendario.statusCode).toBe(200);
    expect(listAniversariantesCalendarioMock).toHaveBeenCalledWith(
      expect.objectContaining({
        slot: 'clone_owner',
        tenantId: 'tid-owner',
        timezone: 'America/Sao_Paulo',
        anchor: '2026-08-21',
        view: 'semana',
      }),
    );
    await app.close();
  });

  it('proxy de avatar reautoriza owner, não expõe URL e retorna 204 no fallback', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/clientes/11111111-1111-4111-8111-111111111111/avatar',
    });
    expect(res.statusCode).toBe(204);
    expect(getClienteAvatarTargetMock).toHaveBeenCalledWith(
      'clone_owner',
      'tid-owner',
      '11111111-1111-4111-8111-111111111111',
    );
    expect(getProfilePictureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessao: 'sess_owner',
        telefoneCanonico: '553199998842',
        shardId: 0,
      }),
    );
    expect(res.body).not.toContain('http');
    await app.close();
  });

  it('perfil owner inclui nota interna e histórico', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/clientes/11111111-1111-4111-8111-111111111111',
    });

    expect(res.statusCode).toBe(200);
    expect(getClienteOwnerMock).toHaveBeenCalledWith(
      'clone_owner',
      'tid-owner',
      '11111111-1111-4111-8111-111111111111',
    );
    expect(res.json()).toEqual({ cliente: OWNER_PROFILE, historico: HISTORICO });
    await app.close();
  });

  it('ranking sem retorno aceita limit=50 e usa slot+tenant+timezone da sessão', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/clientes/sem-retorno?limit=50&offset=100',
    });

    expect(res.statusCode).toBe(200);
    expect(seedClientesMock).not.toHaveBeenCalled();
    expect(listSemRetornoOwnerMock).toHaveBeenCalledWith({
      slot: 'clone_owner',
      tenantId: 'tid-owner',
      timezone: 'America/Sao_Paulo',
      limit: 50,
      offset: 100,
    });
    const body = res.json();
    expect(body).toEqual({ ...SEM_RETORNO_LIST, limit: 50, offset: 100 });
    expect(body.clientes[0]?.telefone_masked).toBe('+55 31 •••••-••88');
    expect(body.clientes[0]?.telefone).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('553199998842');
    await app.close();
  });

  it('aniversariantes usa slot+tenant+timezone da sessão e mantém PII mascarada', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/clientes/aniversariantes?modo=proximos&dias=7&limit=50&offset=100',
    });

    expect(res.statusCode).toBe(200);
    expect(listAniversariantesOwnerMock).toHaveBeenCalledWith({
      slot: 'clone_owner',
      tenantId: 'tid-owner',
      timezone: 'America/Sao_Paulo',
      mode: 'proximos',
      dias: 7,
      limit: 50,
      offset: 100,
    });
    const body = res.json();
    expect(body).toEqual({ ...ANIVERSARIANTES_LIST, limit: 50, offset: 100 });
    expect(body.clientes[0]?.telefone_masked).toBe('+55 31 •••••-••55');
    expect(body.clientes[0]?.telefone).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('553199998855');
    await app.close();
  });

  it('aniversariantes owner aplica default server-side modo=proximos&dias=30 quando query vem vazia', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/clientes/aniversariantes',
    });

    expect(res.statusCode).toBe(200);
    expect(listAniversariantesOwnerMock).toHaveBeenCalledWith({
      slot: 'clone_owner',
      tenantId: 'tid-owner',
      timezone: 'America/Sao_Paulo',
      mode: 'proximos',
      dias: 30,
      limit: undefined,
      offset: undefined,
    });
    await app.close();
  });

  it('aniversariantes rejeita limit=51 e parâmetros forjados de escopo', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/clientes/aniversariantes?modo=proximos&dias=7&slot=outro&tenant_id=forjado&limit=51',
    });

    expect(res.statusCode).toBe(400);
    expect(listAniversariantesOwnerMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('aniversariantes owner aceita modo=mes com mes 1..12', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/clientes/aniversariantes?modo=mes&mes=2&limit=5&offset=10',
    });

    expect(res.statusCode).toBe(200);
    expect(listAniversariantesOwnerMock).toHaveBeenCalledWith({
      slot: 'clone_owner',
      tenantId: 'tid-owner',
      timezone: 'America/Sao_Paulo',
      mode: 'mes',
      mes: 2,
      limit: 5,
      offset: 10,
    });
    await app.close();
  });

  it('aniversariantes owner rejeita combinações inválidas do schema específico', async () => {
    const app = await buildApp();
    const missingMes = await app.inject({
      method: 'GET',
      url: '/portal/clientes/aniversariantes?modo=mes',
    });
    expect(missingMes.statusCode).toBe(400);

    const defaultDias = await app.inject({
      method: 'GET',
      url: '/portal/clientes/aniversariantes?modo=proximos',
    });
    expect(defaultDias.statusCode).toBe(200);
    listAniversariantesOwnerMock.mockClear();

    const extraMes = await app.inject({
      method: 'GET',
      url: '/portal/clientes/aniversariantes?modo=proximos&dias=7&mes=2',
    });
    expect(extraMes.statusCode).toBe(400);

    const outOfRange = await app.inject({
      method: 'GET',
      url: '/portal/clientes/aniversariantes?modo=mes&mes=13',
    });
    expect(outOfRange.statusCode).toBe(400);

    expect(listAniversariantesOwnerMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('ranking sem retorno rejeita limit=51 e parâmetros forjados de escopo', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/clientes/sem-retorno?slot=outro&tenant_id=forjado&limit=51',
    });

    expect(res.statusCode).toBe(400);
    expect(listSemRetornoOwnerMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('patch owner altera só campos permitidos e segue no escopo da sessão', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/clientes/11111111-1111-4111-8111-111111111111',
      payload: {
        aniversario_mmdd: '02-29',
        cidade: 'Contagem',
        nota_interna: 'Voltou ao plano VIP',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(updateClienteOwnerMock).toHaveBeenCalledWith(
      'clone_owner',
      'tid-owner',
      '11111111-1111-4111-8111-111111111111',
      {
        aniversario_mmdd: '02-29',
        cidade: 'Contagem',
        nota_interna: 'Voltou ao plano VIP',
      },
    );
    await app.close();
  });

  it('patch owner rejeita aniversario_mmdd impossível mesmo no formato MM-DD', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/clientes/11111111-1111-4111-8111-111111111111',
      payload: { aniversario_mmdd: '02-30' },
    });
    expect(res.statusCode).toBe(400);
    expect(updateClienteOwnerMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('400 quando o body tenta enviar campo extra', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/portal/clientes/11111111-1111-4111-8111-111111111111',
      payload: { nota_interna: 'ok', tenant_id: 'forjado' },
    });
    expect(res.statusCode).toBe(400);
    expect(updateClienteOwnerMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('colaborador', () => {
  it('lista só no namespace /portal/colaborador e usando colaboradorId da sessão', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/colaborador/clientes?q=jo',
    });

    expect(res.statusCode).toBe(200);
    expect(seedClientesMock).not.toHaveBeenCalled();
    expect(listClientesColaboradorMock).toHaveBeenCalledWith({
      slot: 'clone_owner',
      tenantId: 'tid-owner',
      colaboradorId: 9,
      timezone: 'America/Sao_Paulo',
      search: 'jo',
      nome: undefined,
      telefone: undefined,
      ultimoAtendimento: undefined,
      periodoInicio: undefined,
      periodoFim: undefined,
      visitas: undefined,
      ordenarPor: undefined,
      ordem: undefined,
      limit: undefined,
      offset: undefined,
    });
    const body = res.json();
    expect(body.clientes[0]?.telefone_masked).toBe('+55 31 •••••-••42');
    expect(body.clientes[0]?.telefone).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('553199998842');
    await app.close();
  });

  it('perfil colaborador não expõe nota interna e traz só o histórico permitido', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/colaborador/clientes/11111111-1111-4111-8111-111111111111',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(getClienteColaboradorMock).toHaveBeenCalledWith(
      'clone_owner',
      'tid-owner',
      9,
      '11111111-1111-4111-8111-111111111111',
    );
    expect(body.cliente.nota_interna).toBeUndefined();
    expect(body.cliente).toEqual(COLAB_PROFILE);
    expect(body.historico).toEqual(HISTORICO);
    await app.close();
  });

  it('404 anti-IDOR quando o cliente não é visível para o colaborador da sessão', async () => {
    getClienteColaboradorMock.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/colaborador/clientes/11111111-1111-4111-8111-111111111111',
    });

    expect(res.statusCode).toBe(404);
    expect(listHistoricoColaboradorMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('ranking sem retorno do colaborador usa colaboradorId da sessão e mascara PII', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/colaborador/clientes/sem-retorno?limit=7&offset=2',
    });

    expect(res.statusCode).toBe(200);
    expect(seedClientesMock).not.toHaveBeenCalled();
    expect(getScopeBySlotMock).toHaveBeenCalledWith('clone_owner');
    expect(listSemRetornoColaboradorMock).toHaveBeenCalledWith({
      slot: 'clone_owner',
      tenantId: 'tid-owner',
      colaboradorId: 9,
      timezone: 'America/Sao_Paulo',
      limit: 7,
      offset: 2,
    });
    const body = res.json();
    expect(body).toEqual({ ...SEM_RETORNO_LIST, limit: 7, offset: 2 });
    expect(body.clientes[0]?.telefone).toBeUndefined();
    await app.close();
  });

  it('aniversariantes do colaborador usa colaboradorId da sessão, timezone server-side e máscara PII', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/colaborador/clientes/aniversariantes?modo=mes&mes=2&limit=7&offset=2',
    });

    expect(res.statusCode).toBe(200);
    expect(getScopeBySlotMock).toHaveBeenCalledWith('clone_owner');
    expect(listAniversariantesColaboradorMock).toHaveBeenCalledWith({
      slot: 'clone_owner',
      tenantId: 'tid-owner',
      colaboradorId: 9,
      timezone: 'America/Sao_Paulo',
      mode: 'mes',
      mes: 2,
      limit: 7,
      offset: 2,
    });
    const body = res.json();
    expect(body).toEqual({ ...ANIVERSARIANTES_LIST, limit: 7, offset: 2 });
    expect(body.clientes[0]?.telefone).toBeUndefined();
    await app.close();
  });

  it('aniversariantes do colaborador também aplica default server-side modo=proximos&dias=30', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/colaborador/clientes/aniversariantes',
    });

    expect(res.statusCode).toBe(200);
    expect(getScopeBySlotMock).toHaveBeenCalledWith('clone_owner');
    expect(listAniversariantesColaboradorMock).toHaveBeenCalledWith({
      slot: 'clone_owner',
      tenantId: 'tid-owner',
      colaboradorId: 9,
      timezone: 'America/Sao_Paulo',
      mode: 'proximos',
      dias: 30,
      limit: undefined,
      offset: undefined,
    });
    await app.close();
  });

  it('aniversariantes do colaborador rejeita tentativa de mini-idor por query', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/colaborador/clientes/aniversariantes?modo=proximos&dias=7&colaborador_id=77',
    });

    expect(res.statusCode).toBe(400);
    expect(listAniversariantesColaboradorMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('ranking sem retorno do colaborador rejeita tentativa de mini-idor por query', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/colaborador/clientes/sem-retorno?colaborador_id=77',
    });

    expect(res.statusCode).toBe(400);
    expect(listSemRetornoColaboradorMock).not.toHaveBeenCalled();
    await app.close();
  });
});
