/**
 * Testes das rotas de suspeita de bot do portal (SCRUM-4 PR-E).
 *
 * DB e logger MOCKADOS — nada bate em serviço real. `withTenant` é um stub que injeta um tenant
 * fixo (auth real vive em tenant.test.ts). Foco:
 *  - GET lista escopada pelo slot DA SESSÃO (anti-IDOR: o slot vem do tenant, nunca de input);
 *  - DELETE despausa (removePausaBySlot) escopado pelo slot da sessão; 404 quando não havia pausa;
 *  - validação de telefone (400);
 *  - cliente A NUNCA alcança o slot de B (toda query usa o slot injetado pela sessão).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listBotDetectPausasBySlot, removePausaBySlot } = vi.hoisted(() => ({
  listBotDetectPausasBySlot: vi.fn(),
  removePausaBySlot: vi.fn(),
}));

vi.mock('@startap/db', () => ({
  portalConfig: { listBotDetectPausasBySlot, removePausaBySlot },
}));
vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

// Mock COMPLETO de ../lib/tenant.js (sem importActual): injeta um tenant fixo (slot DA SESSÃO) e
// um requireTenant que lê req.tenant. Evita carregar config.js/session.js reais (env não setado).
const { injected } = vi.hoisted(() => ({ injected: { slot: 'clone_x' } }));
vi.mock('../lib/tenant.js', () => ({
  withTenant: vi.fn(async (req: { tenant?: unknown }) => {
    req.tenant = { slot: injected.slot, userId: 7, username: 'cirilo', sid: 'sid-atual' };
  }),
  requireTenant: (req: { tenant?: { slot: string; userId: number } }) => {
    if (!req.tenant) throw new Error('withTenant nao executado');
    return req.tenant;
  },
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { portalBotDetectRoutes } from './portal-bot-detect.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalBotDetectRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  injected.slot = 'clone_x';
});

describe('GET /portal/bot-detect/pausas', () => {
  it('lista escopada pelo slot DA SESSÃO', async () => {
    listBotDetectPausasBySlot.mockResolvedValue([
      {
        telefone: '5511999990123',
        source: 'bot_detected',
        reason: 'Auto-pausado por suspeita de bot (carência expirada)',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/bot-detect/pausas' });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(1);
    expect(listBotDetectPausasBySlot).toHaveBeenCalledWith('clone_x');
  });

  it('anti-IDOR: usa o slot DA SESSÃO (B), nunca um slot de input', async () => {
    injected.slot = 'clone_outro';
    listBotDetectPausasBySlot.mockResolvedValue([]);
    const app = await buildApp();
    await app.inject({ method: 'GET', url: '/portal/bot-detect/pausas' });
    expect(listBotDetectPausasBySlot).toHaveBeenCalledWith('clone_outro');
    expect(listBotDetectPausasBySlot).not.toHaveBeenCalledWith('clone_x');
  });
});

describe('DELETE /portal/bot-detect/pausas/:telefone', () => {
  it('despausa (removePausaBySlot) escopado pelo slot da sessão -> 200', async () => {
    removePausaBySlot.mockResolvedValue(true);
    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/portal/bot-detect/pausas/5511999990123',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(removePausaBySlot).toHaveBeenCalledWith({ slot: 'clone_x', telefone: '5511999990123' });
  });

  it('404 quando não havia pausa ativa', async () => {
    removePausaBySlot.mockResolvedValue(false);
    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/portal/bot-detect/pausas/5511999990123',
    });
    expect(res.statusCode).toBe(404);
  });

  it('400 telefone invalido (curto)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/portal/bot-detect/pausas/123' });
    expect(res.statusCode).toBe(400);
    expect(removePausaBySlot).not.toHaveBeenCalled();
  });

  it('anti-IDOR: despausa SEMPRE no slot da sessão (cliente A não despausa de B)', async () => {
    injected.slot = 'clone_a';
    removePausaBySlot.mockResolvedValue(true);
    const app = await buildApp();
    await app.inject({ method: 'DELETE', url: '/portal/bot-detect/pausas/5511999990123' });
    expect(removePausaBySlot).toHaveBeenCalledWith({
      slot: 'clone_a',
      telefone: '5511999990123',
    });
  });
});
