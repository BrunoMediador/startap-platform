/**
 * Testes do GET/PUT /portal/perfil (Missao 023 W13 — perfil do negocio).
 *
 * DB mockado (@startap/db). Invariante anti-IDOR: o slot SEMPRE vem da sessao
 * (withTenant), NUNCA do body — mesmo que o cliente mande `slot`/`tenant` no
 * payload, a data layer e chamada com o slot injetado. Validacao Zod real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// config.js valida process.env no import (cadeia tenant.js -> session.js) — mockamos.
// MUTÁVEL (vi.hoisted) pra testar o gate POR-CLONE de features.modo_atendente (SCRUM-59).
const cfgMock = vi.hoisted(() => ({
  NODE_ENV: 'test',
  REDIS_HOST: 'localhost',
  REDIS_PORT: 6379,
  REDIS_PASSWORD: '',
  MODO_ATENDENTE_SLOTS: '',
}));
vi.mock('../config.js', () => ({ config: cfgMock }));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const {
  getPerfilBySlotMock,
  updatePerfilBySlotMock,
  getTimezoneBySlotMock,
  updateTimezoneBySlotMock,
} = vi.hoisted(() => ({
  getPerfilBySlotMock: vi.fn(),
  updatePerfilBySlotMock: vi.fn(),
  getTimezoneBySlotMock: vi.fn(),
  updateTimezoneBySlotMock: vi.fn(),
}));
vi.mock('@startap/db', () => ({
  portalConfig: {
    getPerfilBySlot: (...a: unknown[]) => getPerfilBySlotMock(...a),
    updatePerfilBySlot: (...a: unknown[]) => updatePerfilBySlotMock(...a),
  },
  flowClones: {
    getTimezoneBySlot: (...a: unknown[]) => getTimezoneBySlotMock(...a),
    updateTimezoneBySlot: (...a: unknown[]) => updateTimezoneBySlotMock(...a),
  },
  portalUsers: { getSlotForActivePortalUser: vi.fn() },
}));

// withTenant stub: injeta tenant fixo (slot da sessao). Auth real em tenant.test.ts.
const injectedSlot = 'clone_edu_a1b2c3';
vi.mock('../lib/tenant.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/tenant.js')>('../lib/tenant.js');
  return {
    ...actual,
    withTenant: vi.fn(async (req: { tenant?: unknown }) => {
      req.tenant = { slot: injectedSlot, userId: 7, username: 'dono', sid: 'sid-atual' };
    }),
  };
});

import Fastify, { type FastifyInstance } from 'fastify';
import { portalPerfilRoutes } from './portal-perfil.js';

const PERFIL_OK = {
  nome_negocio: 'Barbearia do Edu',
  nome_prestador: 'Edu',
  telefone_contato: '11999990000',
  endereco: 'Rua X, 1',
  instagram: 'edubarber',
  formas_pagamento: ['Dinheiro', 'PIX'],
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalPerfilRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults: fuso vigente do clone (SP) e escrita OK — testes específicos sobrescrevem.
  getTimezoneBySlotMock.mockResolvedValue('America/Sao_Paulo');
  updateTimezoneBySlotMock.mockResolvedValue(true);
  // Default: modo atendente OFF pra todos (byte-a-byte). Testes específicos ligam.
  cfgMock.MODO_ATENDENTE_SLOTS = '';
});

describe('GET /portal/perfil', () => {
  it('200: devolve o perfil do slot da sessao', async () => {
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.statusCode).toBe(200);
    expect(res.json().perfil).toEqual(PERFIL_OK);
    // Anti-IDOR: leitura escopada pelo slot da sessao.
    expect(getPerfilBySlotMock).toHaveBeenCalledWith(injectedSlot);
    await app.close();
  });

  it('404: fluxo nao encontrado', async () => {
    getPerfilBySlotMock.mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('200: devolve o timezone (COLUNA) junto do perfil, escopado pelo slot da sessao', async () => {
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    getTimezoneBySlotMock.mockResolvedValue('America/Cuiaba');
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.statusCode).toBe(200);
    expect(res.json().timezone).toBe('America/Cuiaba');
    expect(getTimezoneBySlotMock).toHaveBeenCalledWith(injectedSlot);
    await app.close();
  });

  it('SCRUM-59: features.modo_atendente=false por default (clientes atuais nao veem a secao)', async () => {
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.statusCode).toBe(200);
    expect(res.json().features).toEqual({ modo_atendente: false });
    await app.close();
  });

  it('SCRUM-59: features.modo_atendente=true SO quando o slot da sessao esta no gate', async () => {
    // gate POR-CLONE: liga so pro slot injetado (o do piloto).
    cfgMock.MODO_ATENDENTE_SLOTS = injectedSlot;
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.statusCode).toBe(200);
    expect(res.json().features.modo_atendente).toBe(true);
    await app.close();
  });

  it('SCRUM-59: outro slot no gate NAO liga a feature pro slot da sessao (isolado por-clone)', async () => {
    cfgMock.MODO_ATENDENTE_SLOTS = 'clone_de_OUTRO_cliente';
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.json().features.modo_atendente).toBe(false);
    await app.close();
  });
});

describe('PUT /portal/perfil', () => {
  it('200: grava perfil valido com o slot da sessao e devolve o canonico', async () => {
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { nome_negocio: 'Barbearia do Edu', nome_prestador: 'Edu' } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().perfil).toEqual(PERFIL_OK);
    // slot da SESSAO, nunca do body.
    expect(updatePerfilBySlotMock).toHaveBeenCalledWith(
      injectedSlot,
      expect.objectContaining({ nome_negocio: 'Barbearia do Edu', nome_prestador: 'Edu' }),
    );
    await app.close();
  });

  it('anti-IDOR: ignora slot/tenant no body — usa o slot da sessao', async () => {
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      // `slot` no body deve ser ignorado pelo strict schema (e nunca usado de qq forma).
      payload: { slot: 'clone_de_OUTRO_cliente', perfil: { nome_negocio: 'X' } },
    });

    expect(res.statusCode).toBe(200);
    expect(updatePerfilBySlotMock).toHaveBeenCalledTimes(1);
    expect(updatePerfilBySlotMock.mock.calls[0][0]).toBe(injectedSlot);
    await app.close();
  });

  it('400: payload invalido (campo extra dentro de perfil — strict)', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { nome_negocio: 'X', campo_desconhecido: 'y' } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('perfil invalido');
    expect(updatePerfilBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('400: tipo invalido (numero em vez de string)', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { nome_negocio: 123 } },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400: forma de pagamento fora da lista permitida (selecionar, nao digitar)', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { formas_pagamento: ['Boleto'] } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('perfil invalido');
    expect(updatePerfilBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('404: update em fluxo inexistente', async () => {
    updatePerfilBySlotMock.mockResolvedValue(false);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { nome_negocio: 'X' } },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('SCRUM-59: aceita agenda_automatica=false SEM link (link OPCIONAL sempre)', async () => {
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    // sem link_agendamento no payload -> NAO ha 400 (decisao Bruno 03/07).
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { agenda_automatica: false } },
    });

    expect(res.statusCode).toBe(200);
    expect(updatePerfilBySlotMock).toHaveBeenCalledWith(
      injectedSlot,
      expect.objectContaining({ agenda_automatica: false }),
    );
    await app.close();
  });

  it('SCRUM-59: aceita link_agendamento URL valida; rejeita string nao-URL (400)', async () => {
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const ok = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { agenda_automatica: false, link_agendamento: 'https://booksy.com/x' } },
    });
    expect(ok.statusCode).toBe(200);

    const bad = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { link_agendamento: 'nao-e-url' } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('perfil invalido');
    await app.close();
  });

  it('200: timezone valido grava a COLUNA (updateTimezoneBySlot) escopado ao slot da sessao', async () => {
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    getTimezoneBySlotMock.mockResolvedValue('America/Cuiaba');
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { nome_negocio: 'X' }, timezone: 'America/Cuiaba' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().timezone).toBe('America/Cuiaba');
    // COLUNA gravada por caminho separado, slot da SESSAO (nunca do body).
    expect(updateTimezoneBySlotMock).toHaveBeenCalledWith(injectedSlot, 'America/Cuiaba');
    // timezone NUNCA vai no personalizacao (perfilSchema) — perfil gravado sem ele.
    expect(updatePerfilBySlotMock).toHaveBeenCalledWith(
      injectedSlot,
      expect.not.objectContaining({ timezone: expect.anything() }),
    );
    await app.close();
  });

  it('400: timezone invalido => timezone_invalido, NAO grava perfil nem coluna', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { nome_negocio: 'X' }, timezone: 'Marte/Olympus' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('timezone_invalido');
    expect(updatePerfilBySlotMock).not.toHaveBeenCalled();
    expect(updateTimezoneBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('timezone omitido => NAO toca a coluna (byte-identico: mantem o fuso atual)', async () => {
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { nome_negocio: 'X' } },
    });

    expect(res.statusCode).toBe(200);
    expect(updateTimezoneBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('anti-IDOR: timezone gravado no slot da SESSAO mesmo com slot no body', async () => {
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: {
        slot: 'clone_de_OUTRO_cliente',
        perfil: { nome_negocio: 'X' },
        timezone: 'America/Cuiaba',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(updateTimezoneBySlotMock).toHaveBeenCalledTimes(1);
    expect(updateTimezoneBySlotMock.mock.calls[0][0]).toBe(injectedSlot);
    await app.close();
  });
});
