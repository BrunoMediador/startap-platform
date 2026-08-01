/**
 * Testes de PUT /portal/servicos — validação cruzada serviço↔persona (ADR 0035).
 *
 * @startap/integrations é MOCKADO (openai.runAgent) — os 9 casos da tabela D4 contra o modelo
 * REAL são provados à parte (relatório da PR), não aqui. Aqui provamos o CONTRATO da rota:
 *  - flag OFF (default) → comportamento antigo byte-a-byte, 0 chamadas de LLM;
 *  - flag ON + gate determinístico barra antes do LLM (ex.: só duracao_min mudou);
 *  - flag ON + conflito real → 409 com trecho/motivo, updateServicosBySlot NUNCA chamado;
 *  - flag ON + validador indisponível → 503 honesto (retriable), NUNCA acusa o dado,
 *    updateServicosBySlot NUNCA chamado;
 *  - GET /portal/servicos inalterado (não passa pelo validador).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  configMock,
  runAgentMock,
  getServicosMock,
  updateServicosMock,
  getCartaoMock,
  getPromptMock,
} = vi.hoisted(() => ({
  configMock: {
    SERVICO_VALIDACAO_CRUZADA_ENABLED: false,
    SERVICO_VALIDATOR_MODEL: 'gpt-5.1-mini',
    SERVICO_VALIDATOR_TEMPERATURE: 0,
    SERVICO_VALIDATOR_TIMEOUT_MS: 8000,
    OPENAI_API_KEY: 'sk-test',
  } as Record<string, unknown>,
  runAgentMock: vi.fn(),
  getServicosMock: vi.fn(),
  updateServicosMock: vi.fn(),
  getCartaoMock: vi.fn(),
  getPromptMock: vi.fn(),
}));

vi.mock('../config.js', () => ({ config: configMock }));
vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('@startap/integrations', () => ({
  openai: { runAgent: (...a: unknown[]) => runAgentMock(...a) },
  metaEntrevistador: { sanitizePersonaAtual: (raw: string) => raw },
}));
vi.mock('@startap/db', () => ({
  portalConfig: {
    getServicosBySlot: (...a: unknown[]) => getServicosMock(...a),
    updateServicosBySlot: (...a: unknown[]) => updateServicosMock(...a),
    getHorariosBySlot: vi.fn(),
    updateHorariosBySlot: vi.fn(),
  },
  cloneColaboradores: {
    getAreaPromptCustomCartao: (...a: unknown[]) => getCartaoMock(...a),
  },
  botPrompt: {
    getPrompt: (...a: unknown[]) => getPromptMock(...a),
  },
}));

const injectedSlot = 'clone_barbearia_x8w2f0';
vi.mock('../lib/tenant.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/tenant.js')>('../lib/tenant.js');
  return {
    ...actual,
    withTenant: vi.fn(async (req: { tenant?: unknown }) => {
      req.tenant = { slot: injectedSlot, userId: 1, username: 'dono', sid: 'sid-1' };
    }),
  };
});

import Fastify, { type FastifyInstance } from 'fastify';
import { portalConfigRoutes } from './portal-config.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalConfigRoutes);
  await app.ready();
  return app;
}

function conflitoToolResult(args: {
  pode_salvar: boolean;
  motivo?: string;
  trecho_conflitante?: string;
}) {
  return {
    reply: '',
    toolCalls: [
      {
        name: 'avaliar_conflito',
        args: {
          pode_salvar: args.pode_salvar,
          motivo: args.motivo ?? '',
          trecho_conflitante: args.trecho_conflitante ?? '',
        },
        result: { ok: true },
      },
    ],
    usage: { prompt: 10, completion: 5, total: 15, cached: 0 },
  };
}

const SERVICOS_ATUAIS = [{ nome: 'Corte', preco_cents: 4000, duracao_min: 30 }];

beforeEach(() => {
  vi.clearAllMocks();
  configMock.SERVICO_VALIDACAO_CRUZADA_ENABLED = false;
  getServicosMock.mockResolvedValue(SERVICOS_ATUAIS);
  updateServicosMock.mockResolvedValue(true);
  getCartaoMock.mockResolvedValue({ promptCustom: false });
  getPromptMock.mockResolvedValue(null);
});

describe('GET /portal/servicos', () => {
  it('não passa pelo validador (rota inalterada)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/servicos' });
    expect(res.statusCode).toBe(200);
    expect(runAgentMock).toHaveBeenCalledTimes(0);
  });
});

describe('PUT /portal/servicos — flag OFF (default de produção)', () => {
  it('salva normal, 0 chamadas ao LLM, byte-a-byte com o comportamento antigo', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/servicos',
      payload: { servicos: [{ nome: 'Corte', preco_cents: 5000, duracao_min: 30 }] },
    });
    expect(res.statusCode).toBe(200);
    expect(runAgentMock).toHaveBeenCalledTimes(0);
    expect(getCartaoMock).toHaveBeenCalledTimes(0);
    expect(updateServicosMock).toHaveBeenCalledTimes(1);
  });
});

describe('PUT /portal/servicos — flag ON', () => {
  beforeEach(() => {
    configMock.SERVICO_VALIDACAO_CRUZADA_ENABLED = true;
  });

  it('gate determinístico: só duracao_min mudou → 0 chamadas ao LLM, salva normal', async () => {
    getCartaoMock.mockResolvedValue({ promptCustom: true });
    getPromptMock.mockResolvedValue('o corte sai quarenta reais');
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/servicos',
      payload: { servicos: [{ nome: 'Corte', preco_cents: 4000, duracao_min: 45 }] },
    });
    expect(res.statusCode).toBe(200);
    expect(runAgentMock).toHaveBeenCalledTimes(0);
    expect(updateServicosMock).toHaveBeenCalledTimes(1);
  });

  it('sem persona custom → 0 chamadas ao LLM, salva normal', async () => {
    getCartaoMock.mockResolvedValue({ promptCustom: false });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/servicos',
      payload: { servicos: [{ nome: 'Luzes', preco_cents: 12000, duracao_min: 60 }] },
    });
    expect(res.statusCode).toBe(200);
    expect(runAgentMock).toHaveBeenCalledTimes(0);
    expect(updateServicosMock).toHaveBeenCalledTimes(1);
  });

  it('conflito real → 409 conflito_persona com trecho/motivo; updateServicosBySlot NUNCA chamado', async () => {
    getCartaoMock.mockResolvedValue({ promptCustom: true });
    getPromptMock.mockResolvedValue('O corte sai quarenta reais aqui.');
    runAgentMock.mockResolvedValue(
      conflitoToolResult({
        pode_salvar: false,
        motivo: 'O texto do seu assistente já fala esse preço.',
        trecho_conflitante: 'O corte sai quarenta reais',
      }),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/servicos',
      payload: { servicos: [{ nome: 'Corte', preco_cents: 4500, duracao_min: 30 }] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'conflito_persona',
      reason: 'preco_duplicado',
      servico: 'Corte',
      trecho: 'O corte sai quarenta reais',
    });
    expect(updateServicosMock).toHaveBeenCalledTimes(0);
  });

  it('validador indisponível (timeout) → 503 honesto, NUNCA acusa o dado; updateServicosBySlot NUNCA chamado', async () => {
    getCartaoMock.mockResolvedValue({ promptCustom: true });
    getPromptMock.mockResolvedValue('o corte sai quarenta reais');
    runAgentMock.mockRejectedValue(new Error('network timeout'));
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/servicos',
      payload: { servicos: [{ nome: 'Corte', preco_cents: 4500, duracao_min: 30 }] },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error).toBe('validacao_indisponivel');
    expect(body.mensagem).not.toMatch(/inválid|invalid/i); // nunca acusa o dado
    expect(updateServicosMock).toHaveBeenCalledTimes(0);
  });

  it('trecho_conflitante alucinado (não existe na persona) → 503, nunca 409', async () => {
    getCartaoMock.mockResolvedValue({ promptCustom: true });
    getPromptMock.mockResolvedValue('atendemos corte e barba, o corte sai quarenta reais');
    runAgentMock.mockResolvedValue(
      conflitoToolResult({
        pode_salvar: false,
        motivo: 'inventado',
        trecho_conflitante: 'frase que não está em lugar nenhum do texto',
      }),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/servicos',
      payload: { servicos: [{ nome: 'Corte', preco_cents: 4500, duracao_min: 30 }] },
    });
    expect(res.statusCode).toBe(503);
    expect(updateServicosMock).toHaveBeenCalledTimes(0);
  });

  it('payload inválido continua 400 ANTES de tocar o validador (safeParse primeiro)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/servicos',
      payload: { servicos: [{ nome: '', preco_cents: -1, duracao_min: 30 }] },
    });
    expect(res.statusCode).toBe(400);
    expect(runAgentMock).toHaveBeenCalledTimes(0);
    expect(getCartaoMock).toHaveBeenCalledTimes(0);
  });
});
