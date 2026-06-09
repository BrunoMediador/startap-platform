/**
 * Testa o WorkerConfigSchema em isolamento, sem depender de process.env real.
 *
 * Foco: regressao do incidente P0 2026-06-09 — ABACATEPAY_API_KEY era obrigatoria no
 * boot e derrubou o worker em loop de restart. Agora a feature dormente NAO acopla o
 * uptime do worker: o schema valida OK sem a chave.
 */
import { describe, expect, it } from 'vitest';
import { WorkerConfigSchema } from './config.js';

describe('WorkerConfigSchema', () => {
  it('VALIDA OK sem ABACATEPAY_API_KEY — boot do worker nao falha (corretiva postmortem P0)', () => {
    const result = WorkerConfigSchema.parse({});
    expect(result.ABACATEPAY_API_KEY).toBeUndefined();
    // defaults preservados
    expect(result.ABACATEPAY_BASE_URL).toBe('https://api.abacatepay.com');
    expect(result.CHAT_MEMORY_RETENTION).toBe(30);
  });

  it('aceita ABACATEPAY_API_KEY quando presente (feature ativa)', () => {
    const result = WorkerConfigSchema.parse({ ABACATEPAY_API_KEY: 'abacate-dev-key' });
    expect(result.ABACATEPAY_API_KEY).toBe('abacate-dev-key');
  });
});
