/**
 * Testes de GET/PUT /portal/frases-pausa (SCRUM-59, ENTREGA 2).
 *
 * Invariantes:
 *  - GATE: modo atendente OFF pro slot -> 404 (feature dormente; não toca o data layer).
 *  - Anti-IDOR: replace-set escopado ao slot da SESSÃO (withTenant) — nunca do body.
 *  - Validação: max 10; keyword normalizada >= 4 chars; duplicata (command,norm); substring
 *    (ambiguidade no match do bot); strict (campo extra -> 400).
 *  - keyword_norm gravado = normalização canônica (@startap/core).
 *
 * config, @startap/db e tenant mockados (mesmo padrão de portal-atendimentos.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { configMock, listMock, replaceMock } = vi.hoisted(() => ({
  configMock: { MODO_ATENDENTE_SLOTS: '' } as { MODO_ATENDENTE_SLOTS: string },
  listMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock('../config.js', () => ({ config: configMock }));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('@startap/db', () => ({
  pausa: {
    listFlowPauseKeywords: (...a: unknown[]) => listMock(...a),
    replaceFlowPauseKeywords: (...a: unknown[]) => replaceMock(...a),
  },
}));

const injectedSlot = 'clone_meduzza_barbearia_q23psc';
vi.mock('../lib/tenant.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/tenant.js')>('../lib/tenant.js');
  return {
    ...actual,
    withTenant: vi.fn(async (req: { tenant?: unknown }) => {
      req.tenant = { slot: injectedSlot, userId: 3, username: 'meduzza', sid: 'sid-1' };
    }),
  };
});

import Fastify, { type FastifyInstance } from 'fastify';
import { portalFrasesPausaRoutes } from './portal-frases-pausa.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalFrasesPausaRoutes);
  await app.ready();
  return app;
}

function enableGate() {
  configMock.MODO_ATENDENTE_SLOTS = injectedSlot;
}

describe('/portal/frases-pausa', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMock.MODO_ATENDENTE_SLOTS = '';
    listMock.mockResolvedValue([]);
    replaceMock.mockResolvedValue(undefined);
  });

  describe('gate do modo atendente', () => {
    it('GET 404 quando o clone não está no gate (feature dormente)', async () => {
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/portal/frases-pausa' });
      expect(res.statusCode).toBe(404);
      expect(listMock).not.toHaveBeenCalled();
      await app.close();
    });

    it('PUT 404 quando o clone não está no gate (não toca o data layer)', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/portal/frases-pausa',
        payload: { frases: [] },
      });
      expect(res.statusCode).toBe(404);
      expect(replaceMock).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe('GET', () => {
    it('devolve as frases do slot da sessão', async () => {
      enableGate();
      listMock.mockResolvedValue([
        {
          flow_id: injectedSlot,
          command: 'pause',
          keyword: 'atendente aqui!!',
          keyword_norm: 'atendenteaqui!!',
          enabled: true,
          updated_at: new Date(),
        },
      ]);
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/portal/frases-pausa' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        frases: [{ command: 'pause', keyword: 'atendente aqui!!', enabled: true }],
      });
      // Anti-IDOR: consulta pelo slot da SESSÃO.
      expect(listMock).toHaveBeenCalledWith(injectedSlot);
      await app.close();
    });
  });

  describe('PUT — replace-set', () => {
    it('lista válida → grava com keyword_norm canônico, escopado ao slot da sessão, 200', async () => {
      enableGate();
      const app = await buildApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/portal/frases-pausa',
        payload: {
          frases: [
            { command: 'pause', keyword: 'Atendente Aqui!!', enabled: true },
            { command: 'resume', keyword: 'assistente voltar!!', enabled: false },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(replaceMock).toHaveBeenCalledTimes(1);
      const [slotArg, rowsArg] = replaceMock.mock.calls[0] as [string, unknown[]];
      expect(slotArg).toBe(injectedSlot); // nunca do body
      expect(rowsArg).toEqual([
        {
          command: 'pause',
          keyword: 'Atendente Aqui!!',
          keyword_norm: 'atendenteaqui!!',
          enabled: true,
        },
        {
          command: 'resume',
          keyword: 'assistente voltar!!',
          keyword_norm: 'assistentevoltar!!',
          enabled: false,
        },
      ]);
      await app.close();
    });

    it('enabled omitido → default true', async () => {
      enableGate();
      const app = await buildApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/portal/frases-pausa',
        payload: { frases: [{ command: 'pause', keyword: 'recepcao assumiu' }] },
      });
      expect(res.statusCode).toBe(200);
      const rows = (replaceMock.mock.calls[0] as [string, Array<{ enabled: boolean }>])[1];
      expect(rows[0]!.enabled).toBe(true);
      await app.close();
    });

    it('lista vazia → zera as frases (replace-set com [])', async () => {
      enableGate();
      const app = await buildApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/portal/frases-pausa',
        payload: { frases: [] },
      });
      expect(res.statusCode).toBe(200);
      expect(replaceMock).toHaveBeenCalledWith(injectedSlot, []);
      await app.close();
    });

    it('mais de 10 frases → 400 frases_demais', async () => {
      enableGate();
      const frases = Array.from({ length: 11 }, (_, i) => ({
        command: 'pause' as const,
        keyword: `frase numero ${i}`,
        enabled: true,
      }));
      const app = await buildApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/portal/frases-pausa',
        payload: { frases },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('frases_demais');
      expect(replaceMock).not.toHaveBeenCalled();
      await app.close();
    });

    it('keyword curta (< 4 chars normalizados) → 400 frase_muito_curta', async () => {
      enableGate();
      const app = await buildApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/portal/frases-pausa',
        payload: { frases: [{ command: 'pause', keyword: 'a b', enabled: true }] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('frase_muito_curta');
      expect(replaceMock).not.toHaveBeenCalled();
      await app.close();
    });

    it('duplicata por (command, keyword_norm) → 400 frase_duplicada', async () => {
      enableGate();
      const app = await buildApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/portal/frases-pausa',
        payload: {
          frases: [
            { command: 'pause', keyword: 'Atendente Aqui', enabled: true },
            { command: 'pause', keyword: 'atendente aqui', enabled: true },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('frase_duplicada');
      expect(replaceMock).not.toHaveBeenCalled();
      await app.close();
    });

    it('substring de outra frase → 400 frase_ambigua', async () => {
      enableGate();
      const app = await buildApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/portal/frases-pausa',
        payload: {
          frases: [
            { command: 'pause', keyword: 'atendente aqui agora', enabled: true },
            { command: 'resume', keyword: 'atendente', enabled: true },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('frase_ambigua');
      expect(replaceMock).not.toHaveBeenCalled();
      await app.close();
    });

    it('campo extra (strict) → 400', async () => {
      enableGate();
      const app = await buildApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/portal/frases-pausa',
        payload: {
          frases: [{ command: 'pause', keyword: 'atendente aqui', enabled: true, slot: 'x' }],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(replaceMock).not.toHaveBeenCalled();
      await app.close();
    });
  });
});
