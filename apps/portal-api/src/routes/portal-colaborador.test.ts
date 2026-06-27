/**
 * Rotas READ-ONLY do painel do colaborador (SCRUM-32). withColaborador é STUBADO pra
 * injetar uma sessão fixa de colaborador (colaboradorId=7, slot 'clone_seven') — a unidade
 * do preHandler vive em tenant-colaborador.test.ts.
 *
 * CONTRATO DE NAMESPACE (fix SCRUM-32 — agenda/comissão vazias em prod): as rotas de DADOS
 * do colaborador vivem sob o prefixo PROXIADO `/portal/*` (o portal-web só encaminha
 * /auth, /portal e /demo pro portal-api). O caminho ANTIGO `/colaborador/*` COLIDIA com as
 * PÁGINAS Next em /colaborador/agenda|comissao, então o `apiFetch` caía no HTML da página e
 * nunca chegava ao portal-api -> agenda/comissão sempre vazias. Estes testes fixam o
 * namespace certo e garantem que o caminho colidente não é mais servido.
 *
 * Prova o ISOLAMENTO no nível da ROTA:
 *  - flag OFF -> 404 (feature dormente).
 *  - /portal/colaborador/agenda: devolve SÓ os eventos da agenda DO colaborador da sessão (a
 *    agenda de OUTRO colaborador do mesmo estabelecimento NÃO aparece).
 *  - /portal/colaborador/comissao: chama getComissaoColaborador com o colaboradorId DA SESSÃO
 *    (não há id no request — anti-IDOR por construção).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { configMock } = vi.hoisted(() => ({
  configMock: { COLABORADOR_PORTAL_ENABLED: false } as Record<string, unknown>,
}));

vi.mock('../config.js', () => ({ config: configMock }));
vi.mock('@startap/db', () => ({
  atendimentos: { getComissaoColaborador: vi.fn() },
}));
vi.mock('@startap/integrations', () => ({
  gcal: { getGcalsForSlot: vi.fn(), invalidateGcalCache: vi.fn() },
}));
vi.mock('../lib/tenant.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/tenant.js')>('../lib/tenant.js');
  return {
    ...actual,
    // Stub: injeta a sessão fixa do colaborador 7 (slot/tenant da "sessão").
    withColaborador: vi.fn(async (req: { colaborador?: unknown }) => {
      req.colaborador = {
        slot: 'clone_seven',
        tenantId: 'tid-7',
        colaboradorId: 7,
        username: 'bene-silva',
        nome: 'Bene Silva',
        sid: 'sid-1',
      };
    }),
  };
});

import { atendimentos } from '@startap/db';
import { gcal } from '@startap/integrations';
import Fastify, { type FastifyInstance } from 'fastify';
import { portalColaboradorRoutes } from './portal-colaborador.js';

const getGcalsMock = vi.mocked(gcal.getGcalsForSlot);
const getComissaoColabMock = vi.mocked(atendimentos.getComissaoColaborador);

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalColaboradorRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  configMock.COLABORADOR_PORTAL_ENABLED = true;
});

describe('gating COLABORADOR_PORTAL_ENABLED', () => {
  it('OFF -> 404 em /portal/colaborador/agenda e /portal/colaborador/comissao', async () => {
    configMock.COLABORADOR_PORTAL_ENABLED = false;
    const app = await buildApp();
    const a = await app.inject({ method: 'GET', url: '/portal/colaborador/agenda' });
    const c = await app.inject({
      method: 'GET',
      url: '/portal/colaborador/comissao?de=2026-06-01&ate=2026-06-30',
    });
    expect(a.statusCode).toBe(404);
    expect(c.statusCode).toBe(404);
    await app.close();
  });
});

// REGRESSÃO do bug "agenda/comissão vazias": as rotas NÃO podem viver no namespace
// /colaborador/* (colidia com as páginas Next + não era proxiado). Têm de estar sob
// /portal/*. Se alguém reverter o prefixo, estes 404 quebram o build.
describe('namespace proxiado /portal/* (não o /colaborador/* colidente)', () => {
  it('o caminho ANTIGO /colaborador/agenda NÃO é mais servido (404)', async () => {
    getGcalsMock.mockResolvedValue([]);
    const app = await buildApp();
    const old = await app.inject({ method: 'GET', url: '/colaborador/agenda' });
    expect(old.statusCode).toBe(404);
    await app.close();
  });

  it('o caminho ANTIGO /colaborador/comissao NÃO é mais servido (404)', async () => {
    const app = await buildApp();
    const old = await app.inject({
      method: 'GET',
      url: '/colaborador/comissao?de=2026-06-01&ate=2026-06-30',
    });
    expect(old.statusCode).toBe(404);
    await app.close();
  });
});

describe('GET /portal/colaborador/agenda — só a agenda DELE', () => {
  it('devolve eventos do colaborador da sessão e IGNORA os de outro colaborador', async () => {
    const eventosBene = [
      {
        id: 'ev-bene-1',
        summary: 'Cliente A - Corte',
        start: { dateTime: '2026-06-27T13:00:00Z' },
        end: { dateTime: '2026-06-27T13:30:00Z' },
      },
    ];
    const listEventsBene = vi.fn().mockResolvedValue(eventosBene);
    const listEventsOutro = vi.fn().mockResolvedValue([
      {
        id: 'ev-outro-1',
        summary: 'SEGREDO de outro barbeiro',
        start: { dateTime: '2026-06-27T14:00:00Z' },
        end: { dateTime: '2026-06-27T14:30:00Z' },
      },
    ]);
    getGcalsMock.mockResolvedValue([
      // colaborador 8 (outro) — NÃO deve ser consultado nem vazar.
      {
        colaboradorId: 8,
        nome: 'Outro',
        calendarId: 'cal8',
        client: { listEvents: listEventsOutro } as never,
        servicos: [],
      },
      // colaborador 7 (o da sessão).
      {
        colaboradorId: 7,
        nome: 'Bene Silva',
        calendarId: 'cal7',
        client: { listEvents: listEventsBene } as never,
        servicos: [],
      },
    ]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/colaborador/agenda' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gcal_configured).toBe(true);
    expect(body.count).toBe(1);
    expect(body.agendamentos[0].id).toBe('ev-bene-1');
    // A agenda do OUTRO colaborador NUNCA foi listada.
    expect(listEventsOutro).not.toHaveBeenCalled();
    expect(listEventsBene).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('colaborador sem agenda ativa -> gcal_configured:false (vazio, sem erro)', async () => {
    getGcalsMock.mockResolvedValue([
      {
        colaboradorId: 8,
        nome: 'Outro',
        calendarId: 'cal8',
        client: { listEvents: vi.fn() } as never,
        servicos: [],
      },
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/colaborador/agenda' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ gcal_configured: false, count: 0, agendamentos: [] });
    await app.close();
  });
});

describe('GET /portal/colaborador/comissao — escopo pela sessão (anti-IDOR)', () => {
  it('chama getComissaoColaborador com o colaboradorId DA SESSÃO (7), nunca de input', async () => {
    getComissaoColabMock.mockImplementation(async (_slot, _t, _id, de, ate, balde) => ({
      de,
      ate,
      balde: balde ?? 'faturado',
      colaborador_id: 7,
      profissional_nome: 'Bene Silva',
      total_bruto_cents: balde === 'previsao' ? 8000 : 12000,
      comissao_pct: 50,
      comissao_cents: balde === 'previsao' ? 4000 : 6000,
      count: 2,
    }));

    const app = await buildApp();
    // Mesmo se o cliente "injetar" um colaborador_id na query, ele é IGNORADO (não há
    // parâmetro de id na rota — a identidade vem da sessão).
    const res = await app.inject({
      method: 'GET',
      url: '/portal/colaborador/comissao?de=2026-06-01&ate=2026-06-30&colaborador_id=8',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.colaborador_id).toBe(7);
    expect(body.faturado.comissao_cents).toBe(6000);
    expect(body.previsao.comissao_cents).toBe(4000);
    // Ambas as chamadas usaram o colaboradorId=7 da sessão (3º argumento).
    for (const call of getComissaoColabMock.mock.calls) {
      expect(call[0]).toBe('clone_seven');
      expect(call[1]).toBe('tid-7');
      expect(call[2]).toBe(7);
    }
    await app.close();
  });

  it('400 quando período inválido', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/colaborador/comissao?de=xx&ate=2026-06-30',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
