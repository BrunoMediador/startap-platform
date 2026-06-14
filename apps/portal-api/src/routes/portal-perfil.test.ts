/**
 * Testes do GET/PUT /portal/perfil (Missao 023 W13 — perfil do negocio).
 *
 * DB mockado (@startap/db). Invariante anti-IDOR: o slot SEMPRE vem da sessao
 * (withTenant), NUNCA do body — mesmo que o cliente mande `slot`/`tenant` no
 * payload, a data layer e chamada com o slot injetado. Validacao Zod real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// config.js valida process.env no import (cadeia tenant.js -> session.js) — mockamos.
vi.mock('../config.js', () => ({
  config: { NODE_ENV: 'test', REDIS_HOST: 'localhost', REDIS_PORT: 6379, REDIS_PASSWORD: '' },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { getPerfilBySlotMock, updatePerfilBySlotMock } = vi.hoisted(() => ({
  getPerfilBySlotMock: vi.fn(),
  updatePerfilBySlotMock: vi.fn(),
}));
vi.mock('@startap/db', () => ({
  portalConfig: {
    getPerfilBySlot: (...a: unknown[]) => getPerfilBySlotMock(...a),
    updatePerfilBySlot: (...a: unknown[]) => updatePerfilBySlotMock(...a),
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
  formas_pagamento: 'Pix, cartao',
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalPerfilRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
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
});
