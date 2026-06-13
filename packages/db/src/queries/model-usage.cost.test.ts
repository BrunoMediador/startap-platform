import { describe, expect, it } from 'vitest';
import { estimateCost } from './model-usage.js';

/**
 * Fix do model_usage.cost_usd (ADR 0021): o cálculo antigo superestimava ~70x
 * a conta REAL da OpenAI. Estes testes travam os preços oficiais (2026-06-13) e
 * o efeito do prompt caching no nosso uso input-dominado (agenda GCal re-injetada).
 */
describe('estimateCost — preços oficiais OpenAI (2026-06-13)', () => {
  it('gpt-5.4: input $2.50 / output $15.00 por 1M (sem cache)', () => {
    // 1M input + 1M output = $2.50 + $15.00 = $17.50
    expect(estimateCost('gpt-5.4', 1_000_000, 1_000_000, 0)).toBeCloseTo(17.5, 6);
  });

  it('gpt-5.4: input cacheado custa $0.25/1M (10x mais barato que uncached)', () => {
    // 1M input TODO cacheado -> $0.25 (vs $2.50 sem cache)
    expect(estimateCost('gpt-5.4', 1_000_000, 0, 1_000_000)).toBeCloseTo(0.25, 6);
  });

  it('cached é subconjunto de prompt: parte cacheada barata + resto cheio', () => {
    // 1M prompt, 900k cacheado, 100k cheio, 0 output:
    // 100k*2.50 + 900k*0.25 = 0.25 + 0.225 = 0.475
    expect(estimateCost('gpt-5.4', 1_000_000, 0, 900_000)).toBeCloseTo(0.475, 6);
  });

  it('cached clampa em prompt (nunca cobra cache > prompt)', () => {
    // cached=2M mas prompt=1M -> trata cached como 1M
    expect(estimateCost('gpt-5.4', 1_000_000, 0, 2_000_000)).toBeCloseTo(0.25, 6);
  });

  it('CORREÇÃO ~70x: a inflação cresce com o cache-hit do prefixo GCal estável', () => {
    // Perfil real (medido): input-dominado, output pequeno, maioria do input em
    // cache (a agenda GCal re-injetada por turno é um prefixo estável).
    const prompt = 4_232_375; // ~1 mês de Cirilo (2 clones somados)
    const completion = 39_593;
    // Cálculo ANTIGO (bug): in=$5.00, out=$20.00, sem cache nenhum.
    const buggy = (prompt * 5.0 + completion * 20.0) / 1_000_000;

    // Decomposição: só o preço errado (in 5->2.5, out 20->15) sem cache = ~2x.
    const priceOnly = estimateCost('gpt-5.4', prompt, completion, 0);
    expect(buggy / priceOnly).toBeGreaterThan(1.9);
    expect(buggy / priceOnly).toBeLessThan(2.1);

    // O grosso da inflação é o caching. Quanto mais alto o cache-hit, maior o gap:
    // 90% -> ~8x, 95% -> ~10x sobre o valor BUGADO. O ~70x da conta real do Bruno
    // combina os 3 fatores + o fato de o billing real (tokens efetivamente cobrados)
    // ser ainda menor que o nosso log de prompt_tokens — aqui travamos só o que o
    // cálculo prova, sem fixar um número frágil.
    const fixed90 = estimateCost('gpt-5.4', prompt, completion, Math.round(prompt * 0.9));
    const fixed95 = estimateCost('gpt-5.4', prompt, completion, Math.round(prompt * 0.95));
    expect(buggy / fixed90).toBeGreaterThan(7);
    expect(buggy / fixed95).toBeGreaterThan(9);
    // E o absoluto cai pra faixa de poucos dólares/mês (vs ~$22 antigo bugado).
    expect(fixed90).toBeLessThan(3);
  });

  it('modelo desconhecido -> custo 0 (sem crash)', () => {
    expect(estimateCost('modelo-inexistente', 1000, 1000, 0)).toBe(0);
  });

  it('deepseek-chat sem caching: cache-hit cai pra tarifa in normal', () => {
    // deepseek não tem campo cached -> cached usa p.in ($0.27)
    expect(estimateCost('deepseek-chat', 1_000_000, 0, 1_000_000)).toBeCloseTo(0.27, 6);
  });
});
