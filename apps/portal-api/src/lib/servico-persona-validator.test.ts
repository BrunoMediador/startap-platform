/**
 * Testes do validador cruzado serviço↔persona (ADR 0035).
 *
 * Cobre os DOIS usos da mesma infra:
 *  - validarConflitoServicoPersona (PUT /portal/servicos): gate determinístico (critério de
 *    aceitação 1 do ADR — 0 chamadas de LLM quando não há material pra conflito), guarda
 *    anti-alucinação do trecho_conflitante (503, nunca 409 com trecho inventado), retry em erro
 *    transitório × sem retry em erro determinístico.
 *  - classificarLinhasDeMoeda (builder): fail-closed em erro do LLM, filtro anti-alucinação
 *    (linha "legítima" que não é substring do original é descartada).
 *
 * openai.runAgent é MOCKADO — os 9 casos da tabela D4 contra o MODELO REAL são provados à parte
 * (relatório da PR), não aqui; aqui provamos a MECÂNICA (gate, contrato, guardas), não o
 * julgamento do modelo.
 */
import { logger } from '@startap/core/logger';
import type { Servicos } from '@startap/core/schemas';
import { openai } from '@startap/integrations';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('@startap/integrations', () => ({
  openai: { runAgent: vi.fn() },
  metaEntrevistador: { sanitizePersonaAtual: (raw: string) => raw },
}));

import {
  classificarLinhasDeMoeda,
  diffServicosParaChecar,
  isTrechoAlucinado,
  temIndicioDeMoeda,
  validarConflitoServicoPersona,
} from './servico-persona-validator.js';

const runAgent = vi.mocked(openai.runAgent);

const OPTS = { model: 'gpt-5.1-mini', temperature: 0, timeoutMs: 8000, apiKey: 'sk-test' };

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

function classificarToolResult(linhas: string[]) {
  return {
    reply: '',
    toolCalls: [
      {
        name: 'classificar_linhas_preco',
        args: { linhas_legitimas: linhas },
        result: { ok: true },
      },
    ],
    usage: { prompt: 5, completion: 2, total: 7, cached: 0 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('diffServicosParaChecar', () => {
  it('inclui serviço novo (não existia antes)', () => {
    const atual: Servicos = [];
    const novo: Servicos = [{ nome: 'Luzes', preco_cents: 12000, duracao_min: 60 }];
    expect(diffServicosParaChecar(atual, novo)).toEqual([{ nome: 'Luzes', preco_cents: 12000 }]);
  });

  it('inclui serviço com preco_cents alterado', () => {
    const atual: Servicos = [{ nome: 'Corte', preco_cents: 4000, duracao_min: 30 }];
    const novo: Servicos = [{ nome: 'Corte', preco_cents: 4500, duracao_min: 30 }];
    expect(diffServicosParaChecar(atual, novo)).toEqual([{ nome: 'Corte', preco_cents: 4500 }]);
  });

  it('NÃO inclui mudança só de duracao_min (critério de aceitação 1 do ADR)', () => {
    const atual: Servicos = [{ nome: 'Corte', preco_cents: 4000, duracao_min: 30 }];
    const novo: Servicos = [{ nome: 'Corte', preco_cents: 4000, duracao_min: 45 }];
    expect(diffServicosParaChecar(atual, novo)).toEqual([]);
  });

  it('NÃO inclui remoção nem reordenação', () => {
    const atual: Servicos = [
      { nome: 'Corte', preco_cents: 4000, duracao_min: 30 },
      { nome: 'Barba', preco_cents: 2500, duracao_min: 20 },
    ];
    const novo: Servicos = [{ nome: 'Corte', preco_cents: 4000, duracao_min: 30 }];
    expect(diffServicosParaChecar(atual, novo)).toEqual([]);
  });

  it('casa por nome normalizado (trim + lowercase)', () => {
    const atual: Servicos = [{ nome: '  Corte  ', preco_cents: 4000, duracao_min: 30 }];
    const novo: Servicos = [{ nome: 'corte', preco_cents: 4000, duracao_min: 30 }];
    expect(diffServicosParaChecar(atual, novo)).toEqual([]);
  });
});

describe('temIndicioDeMoeda', () => {
  it('pega R$ formal', () => expect(temIndicioDeMoeda('Corte R$ 40')).toBe(true));
  it('pega por extenso', () => expect(temIndicioDeMoeda('o corte sai quarenta reais')).toBe(true));
  it('pega "reais" solto com número', () =>
    expect(temIndicioDeMoeda('40 reais o corte')).toBe(true));
  it('não pega frase sem indício monetário', () =>
    expect(temIndicioDeMoeda('atendemos corte e barba')).toBe(false));
});

describe('isTrechoAlucinado', () => {
  it('false quando o trecho é substring literal (tolerante a espaço)', () => {
    expect(isTrechoAlucinado('O corte sai   R$ 40.', 'o corte sai r$ 40.')).toBe(false);
  });
  it('true quando o trecho não existe no texto', () => {
    expect(isTrechoAlucinado('atendemos corte e barba', 'o corte sai R$ 40')).toBe(true);
  });
  it('true quando o trecho é vazio', () => {
    expect(isTrechoAlucinado('qualquer coisa', '')).toBe(true);
  });
});

describe('validarConflitoServicoPersona — gate determinístico (0 chamadas de LLM)', () => {
  it('sem diff (só duracao_min mudou) → ok, 0 chamadas ao LLM', async () => {
    const r = await validarConflitoServicoPersona({
      servicosAtuais: [{ nome: 'Corte', preco_cents: 4000, duracao_min: 30 }],
      servicosNovos: [{ nome: 'Corte', preco_cents: 4000, duracao_min: 45 }],
      promptCustom: true,
      personaAtual: 'o corte sai quarenta reais',
      opts: OPTS,
    });
    expect(r).toEqual({ status: 'ok' });
    expect(runAgent).toHaveBeenCalledTimes(0);
  });

  it('sem persona custom → ok, 0 chamadas ao LLM', async () => {
    const r = await validarConflitoServicoPersona({
      servicosAtuais: [],
      servicosNovos: [{ nome: 'Luzes', preco_cents: 12000, duracao_min: 60 }],
      promptCustom: false,
      personaAtual: null,
      opts: OPTS,
    });
    expect(r).toEqual({ status: 'ok' });
    expect(runAgent).toHaveBeenCalledTimes(0);
  });

  it('persona sem indício de moeda → ok, 0 chamadas ao LLM', async () => {
    const r = await validarConflitoServicoPersona({
      servicosAtuais: [],
      servicosNovos: [{ nome: 'Luzes', preco_cents: 12000, duracao_min: 60 }],
      promptCustom: true,
      personaAtual: 'atendemos corte e barba, somos os mais rápidos da região',
      opts: OPTS,
    });
    expect(r).toEqual({ status: 'ok' });
    expect(runAgent).toHaveBeenCalledTimes(0);
  });

  it('diff + persona custom + indício de moeda → chama o LLM', async () => {
    runAgent.mockResolvedValue(conflitoToolResult({ pode_salvar: true }));
    const r = await validarConflitoServicoPersona({
      servicosAtuais: [],
      servicosNovos: [{ nome: 'Corte', preco_cents: 4000, duracao_min: 30 }],
      promptCustom: true,
      personaAtual: 'o corte sai quarenta reais',
      opts: OPTS,
    });
    expect(r).toEqual({ status: 'ok' });
    expect(runAgent).toHaveBeenCalledTimes(1);
  });
});

describe('validarConflitoServicoPersona — contrato conflito/indisponível', () => {
  it('LLM aponta conflito com trecho literal na persona → conflito', async () => {
    const persona = 'O corte sai quarenta reais aqui na barbearia.';
    runAgent.mockResolvedValue(
      conflitoToolResult({
        pode_salvar: false,
        motivo: 'O texto já fala o preço do corte.',
        trecho_conflitante: 'O corte sai quarenta reais',
      }),
    );
    const r = await validarConflitoServicoPersona({
      servicosAtuais: [],
      servicosNovos: [{ nome: 'Corte', preco_cents: 4000, duracao_min: 30 }],
      promptCustom: true,
      personaAtual: persona,
      opts: OPTS,
    });
    expect(r.status).toBe('conflito');
    if (r.status === 'conflito') {
      expect(r.trecho).toBe('O corte sai quarenta reais');
      expect(r.motivo).toContain('preço');
    }
  });

  it('GUARDA ANTI-ALUCINAÇÃO: trecho_conflitante que NÃO existe na persona → 503, nunca conflito', async () => {
    runAgent.mockResolvedValue(
      conflitoToolResult({
        pode_salvar: false,
        motivo: 'inventado',
        trecho_conflitante: 'frase que não está em lugar nenhum do texto',
      }),
    );
    const r = await validarConflitoServicoPersona({
      servicosAtuais: [],
      servicosNovos: [{ nome: 'Corte', preco_cents: 4000, duracao_min: 30 }],
      promptCustom: true,
      personaAtual: 'o corte sai quarenta reais',
      opts: OPTS,
    });
    expect(r).toEqual({ status: 'indisponivel', motivo: 'trecho_nao_verificavel' });
  });

  it('erro TRANSITÓRIO: falha 1x, sucesso no retry → resultado do retry', async () => {
    runAgent
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce(conflitoToolResult({ pode_salvar: true }));
    const r = await validarConflitoServicoPersona({
      servicosAtuais: [],
      servicosNovos: [{ nome: 'Corte', preco_cents: 4000, duracao_min: 30 }],
      promptCustom: true,
      personaAtual: 'o corte sai quarenta reais',
      opts: OPTS,
    });
    expect(r).toEqual({ status: 'ok' });
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it('erro DETERMINÍSTICO (401): 503 sem retry (updateServicosBySlot nunca seria chamado)', async () => {
    runAgent.mockRejectedValue(new Error('401 invalid_api_key'));
    const r = await validarConflitoServicoPersona({
      servicosAtuais: [],
      servicosNovos: [{ nome: 'Corte', preco_cents: 4000, duracao_min: 30 }],
      promptCustom: true,
      personaAtual: 'o corte sai quarenta reais',
      opts: OPTS,
    });
    expect(r).toEqual({ status: 'indisponivel', motivo: 'erro_config' });
    expect(runAgent).toHaveBeenCalledTimes(1); // sem retry
  });

  it('timeout persiste nas 2 tentativas → 503', async () => {
    runAgent.mockRejectedValue(new Error('network timeout'));
    const r = await validarConflitoServicoPersona({
      servicosAtuais: [],
      servicosNovos: [{ nome: 'Corte', preco_cents: 4000, duracao_min: 30 }],
      promptCustom: true,
      personaAtual: 'o corte sai quarenta reais',
      opts: OPTS,
    });
    expect(r).toEqual({ status: 'indisponivel', motivo: 'timeout_apos_retry' });
    expect(runAgent).toHaveBeenCalledTimes(2);
  });
});

describe('classificarLinhasDeMoeda', () => {
  it('0 linhas → ok vazio, 0 chamadas ao LLM', async () => {
    const r = await classificarLinhasDeMoeda([], OPTS);
    expect(r).toEqual({ linhasLegitimas: [] });
    expect(runAgent).toHaveBeenCalledTimes(0);
  });

  it('devolve as linhas que o modelo marcou como legítimas (substring válida)', async () => {
    const linha = 'Pacote Mensal com 4 sessões: R$ 396,00 (99,00 por sessão)';
    runAgent.mockResolvedValue(classificarToolResult([linha]));
    const r = await classificarLinhasDeMoeda([linha, 'O corte sai R$ 40.'], OPTS);
    expect(r.linhasLegitimas).toEqual([linha]);
  });

  it('descarta linha "legítima" alucinada (não é substring de nenhuma linha original)', async () => {
    runAgent.mockResolvedValue(classificarToolResult(['frase que o modelo inventou']));
    const r = await classificarLinhasDeMoeda(['O corte sai R$ 40.'], OPTS);
    expect(r.linhasLegitimas).toEqual([]);
  });

  it('fail-closed: erro do LLM (2 tentativas) devolve lista vazia, nunca lança', async () => {
    runAgent.mockRejectedValue(new Error('network timeout'));
    const r = await classificarLinhasDeMoeda(['O plano mensal sai R$ 150.'], OPTS);
    expect(r).toEqual({ linhasLegitimas: [] });
  });
});
