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

  it('VALIDA OK sem nenhuma env do cron de trials orfaos — defaults seguros (licao #247)', () => {
    const result = WorkerConfigSchema.parse({});
    expect(result.TRIAL_ORPHAN_CLEANUP_ENABLED).toBe(true); // ausente = ligado (no-op sem candidatos)
    expect(result.TRIAL_ORPHAN_MAX_AGE_HOURS).toBe(72);
    expect(result.TRIAL_ORPHAN_CRON).toBe('30 * * * *');
    expect(result.WAHA_URL).toBe('http://waha:3000');
    expect(result.WAHA_API_KEY).toBe('');
  });

  it('kill switch TRIAL_ORPHAN_CLEANUP_ENABLED=false desliga o cron sem deploy', () => {
    const result = WorkerConfigSchema.parse({ TRIAL_ORPHAN_CLEANUP_ENABLED: 'false' });
    expect(result.TRIAL_ORPHAN_CLEANUP_ENABLED).toBe(false);
  });

  it('bot-detect (SCRUM-4) nasce OFF e sem slots — gate macro + por-clone default seguro', () => {
    const result = WorkerConfigSchema.parse({});
    expect(result.BOT_DETECT_ENABLED).toBe(false); // ausente = OFF (cron nem registra)
    expect(result.BOT_DETECT_SLOTS).toBe(''); // vazio = OFF pra todos os clones
    expect(result.BOT_DETECT_CRON).toBe('17 * * * *');
    expect(result.BOT_DETECT_MAX_PER_RUN).toBe(50);
    expect(result.BOT_DETECT_MAX_ALERTS_PER_RUN).toBe(3);
  });

  it('bot-detect ON + slots explícitos liga o gate por-clone', () => {
    const result = WorkerConfigSchema.parse({
      BOT_DETECT_ENABLED: 'true',
      BOT_DETECT_SLOTS: 'clone_barber_dragon_caly8b',
    });
    expect(result.BOT_DETECT_ENABLED).toBe(true);
    expect(result.BOT_DETECT_SLOTS).toBe('clone_barber_dragon_caly8b');
  });
});
