/**
 * Testes de GET/PUT /portal/tom-assistente (SCRUM-92).
 *
 * Invariantes:
 *  - Anti-IDOR: lê/grava escopado ao slot da SESSÃO (withTenant) — nunca do body.
 *  - CLAMP DURO: temperatura crua fora de [0.2, 0.85] gruda no limite — o bot nunca quebra.
 *  - Mapeamento nível↔temperatura: catálogo é a fonte única; nível resolve pra sua temperatura;
 *    GET mapeia a temperatura crua do banco pro nível mais próximo.
 *  - GET reflete o que foi gravado (via o mock de getConfig).
 *  - strict: campo extra ou nível fora do catálogo → 400.
 *
 * @startap/db e tenant mockados (mesmo padrão de portal-frases-pausa.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getConfigMock, updateConfigMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
  updateConfigMock: vi.fn(),
}));

// tenant.js (importActual) puxa session.ts → config.ts, que valida env no import. withTenant é
// mockado (nunca roda de fato), então um config dummy só evita o crash de import.
vi.mock('../config.js', () => ({ config: {} }));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('@startap/db', () => ({
  botConfig: {
    getConfig: (...a: unknown[]) => getConfigMock(...a),
    updateConfig: (...a: unknown[]) => updateConfigMock(...a),
  },
}));

const injectedSlot = 'clone_barbearia_samuel_uefpqc';
vi.mock('../lib/tenant.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/tenant.js')>('../lib/tenant.js');
  return {
    ...actual,
    withTenant: vi.fn(async (req: { tenant?: unknown }) => {
      req.tenant = { slot: injectedSlot, userId: 7, username: 'samuel', sid: 'sid-1' };
    }),
  };
});

import Fastify, { type FastifyInstance } from 'fastify';
import { NIVEIS_TOM, portalTomRoutes, temperaturaParaNivel } from './portal-tom.js';

function cfg(temperature: number) {
  return {
    slot: injectedSlot,
    display_name: 'Samuel',
    provider: 'openai' as const,
    model: 'gpt-4o',
    temperature,
    updated_at: new Date(),
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalTomRoutes);
  await app.ready();
  return app;
}

describe('/portal/tom-assistente', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfigMock.mockResolvedValue(cfg(0.5));
    // Por padrão, o update ecoa a temperatura recebida no patch.
    updateConfigMock.mockImplementation(async (_slot: string, patch: { temperature: number }) =>
      cfg(patch.temperature),
    );
  });

  describe('mapeamento nível↔temperatura (unidade)', () => {
    it('cada nível do catálogo mapeia pra si mesmo (round-trip)', () => {
      for (const n of NIVEIS_TOM) {
        expect(temperaturaParaNivel(n.temperatura)).toBe(n.nivel);
      }
    });

    it('temperatura intermediária cai no nível mais próximo', () => {
      expect(temperaturaParaNivel(0.62)).toBe('caloroso'); // 0.7 mais perto que 0.5
      expect(temperaturaParaNivel(0.35)).toBe('direto'); // 0.3 mais perto que 0.5
    });

    it('empate → nível mais conservador (menor temperatura)', () => {
      // 0.4 é equidistante de direto(0.3) e equilibrado(0.5) → escolhe o menor.
      expect(temperaturaParaNivel(0.4)).toBe('direto');
    });
  });

  describe('GET', () => {
    it('devolve valor atual + nível mapeado + catálogo + faixa (slot da sessão)', async () => {
      getConfigMock.mockResolvedValue(cfg(0.7));
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/portal/tom-assistente' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.temperatura).toBe(0.7);
      expect(body.nivel).toBe('caloroso');
      expect(body.faixa).toEqual({ min: 0.2, max: 0.85 });
      expect(body.niveis).toHaveLength(NIVEIS_TOM.length);
      expect(getConfigMock).toHaveBeenCalledWith(injectedSlot); // anti-IDOR
      await app.close();
    });

    it('clone sem bot_config → 404 configuracao_indisponivel', async () => {
      getConfigMock.mockResolvedValue(null);
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/portal/tom-assistente' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('configuracao_indisponivel');
      await app.close();
    });
  });

  describe('PUT — por nível', () => {
    it('nível válido grava a temperatura do catálogo (escopado ao slot da sessão)', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/portal/tom-assistente',
        payload: { nivel: 'caloroso' },
      });
      expect(res.statusCode).toBe(200);
      expect(updateConfigMock).toHaveBeenCalledWith(injectedSlot, { temperature: 0.7 });
      const body = res.json();
      expect(body).toMatchObject({ ok: true, temperatura: 0.7, nivel: 'caloroso', clamped: false });
      await app.close();
    });

    it('nível fora do catálogo → 400', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/portal/tom-assistente',
        payload: { nivel: 'ultra_maluco' },
      });
      expect(res.statusCode).toBe(400);
      expect(updateConfigMock).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe('PUT — por temperatura crua + CLAMP', () => {
    it('valor acima do teto → clampa pra 0.85 (não rejeita), clamped=true', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/portal/tom-assistente',
        payload: { temperatura: 0.99 },
      });
      expect(res.statusCode).toBe(200);
      expect(updateConfigMock).toHaveBeenCalledWith(injectedSlot, { temperature: 0.85 });
      expect(res.json()).toMatchObject({ ok: true, temperatura: 0.85, clamped: true });
      await app.close();
    });

    it('valor abaixo do piso (inclusive negativo) → clampa pra 0.2', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/portal/tom-assistente',
        payload: { temperatura: -3 },
      });
      expect(res.statusCode).toBe(200);
      expect(updateConfigMock).toHaveBeenCalledWith(injectedSlot, { temperature: 0.2 });
      expect(res.json()).toMatchObject({ temperatura: 0.2, clamped: true });
      await app.close();
    });

    it('valor dentro da faixa → grava como veio, clamped=false', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/portal/tom-assistente',
        payload: { temperatura: 0.6 },
      });
      expect(res.statusCode).toBe(200);
      expect(updateConfigMock).toHaveBeenCalledWith(injectedSlot, { temperature: 0.6 });
      expect(res.json()).toMatchObject({ temperatura: 0.6, clamped: false });
      await app.close();
    });
  });

  describe('PUT — validação de payload', () => {
    it('nem nível nem temperatura → 400', async () => {
      const app = await buildApp();
      const res = await app.inject({ method: 'PUT', url: '/portal/tom-assistente', payload: {} });
      expect(res.statusCode).toBe(400);
      expect(updateConfigMock).not.toHaveBeenCalled();
      await app.close();
    });

    it('nível E temperatura juntos (ambíguo) → 400', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/portal/tom-assistente',
        payload: { nivel: 'direto', temperatura: 0.5 },
      });
      expect(res.statusCode).toBe(400);
      expect(updateConfigMock).not.toHaveBeenCalled();
      await app.close();
    });

    it('campo extra (strict) → 400', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/portal/tom-assistente',
        payload: { nivel: 'direto', slot: 'outro_clone' },
      });
      expect(res.statusCode).toBe(400);
      expect(updateConfigMock).not.toHaveBeenCalled();
      await app.close();
    });

    it('GET reflete o que o PUT gravou (round-trip via data layer)', async () => {
      // Simula o data layer: o PUT grava e o GET seguinte lê o mesmo valor.
      updateConfigMock.mockImplementation(async (_slot: string, patch: { temperature: number }) => {
        getConfigMock.mockResolvedValue(cfg(patch.temperature));
        return cfg(patch.temperature);
      });
      const app = await buildApp();
      await app.inject({
        method: 'PUT',
        url: '/portal/tom-assistente',
        payload: { nivel: 'bem_descontraido' },
      });
      const res = await app.inject({ method: 'GET', url: '/portal/tom-assistente' });
      expect(res.json().temperatura).toBe(0.85);
      expect(res.json().nivel).toBe('bem_descontraido');
      await app.close();
    });

    it('clone sem bot_config no PUT → 404', async () => {
      updateConfigMock.mockResolvedValue(null);
      const app = await buildApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/portal/tom-assistente',
        payload: { nivel: 'equilibrado' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('configuracao_indisponivel');
      await app.close();
    });
  });
});
