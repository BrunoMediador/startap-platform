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

  it('billing-silence-alert (SCRUM-67) nasce OFF com defaults seguros', () => {
    const result = WorkerConfigSchema.parse({});
    expect(result.BILLING_SILENCE_ALERT_ENABLED).toBe(false); // ausente = OFF (cron nem registra)
    expect(result.BILLING_SILENCE_ALERT_CRON).toBe('43 * * * *');
    expect(result.BILLING_SILENCE_ALERT_COOLDOWN_MIN).toBe(1_440); // 24h
  });

  it('billing-silence-alert ON via env, cooldown ajustável sem deploy', () => {
    const result = WorkerConfigSchema.parse({
      BILLING_SILENCE_ALERT_ENABLED: 'true',
      BILLING_SILENCE_ALERT_COOLDOWN_MIN: '720',
    });
    expect(result.BILLING_SILENCE_ALERT_ENABLED).toBe(true);
    expect(result.BILLING_SILENCE_ALERT_COOLDOWN_MIN).toBe(720);
  });

  it('gcal-atend-sync (SCRUM-89) nasce OFF com defaults seguros (lição #247)', () => {
    const result = WorkerConfigSchema.parse({});
    expect(result.GCAL_ATEND_SYNC_ENABLED).toBe(false); // ausente = OFF (cron nem registra)
    expect(result.GCAL_ATEND_SYNC_CRON).toBe('37 * * * *');
    expect(result.GCAL_ATEND_SYNC_LOOKBACK_DAYS).toBe(62);
    expect(result.GCAL_ATEND_SYNC_LOOKAHEAD_DAYS).toBe(365); // horizonte 365 (era 60, Bruno 31/07)
    expect(result.GCAL_ATEND_SYNC_LIST_PAD_DAYS).toBe(7);
    expect(result.GCAL_ATEND_SYNC_MAX_PAGES).toBe(60); // subiu proporcional ao lookahead (era 20)
    expect(result.GCAL_ATEND_SYNC_TIMEOUT_MS).toBe(15_000);
    expect(result.GCAL_ATEND_SYNC_DELETE_GRACE_SEC).toBe(120);
    expect(result.GCAL_ATEND_SYNC_MAX_SLOTS_PER_RUN).toBe(50);
    // ATEND_FROM_AGENDA_SLOTS reusado no worker: ausente = '' (só a coluna decide).
    expect(result.ATEND_FROM_AGENDA_SLOTS).toBe('');
    expect(result.MODO_ATENDENTE_SLOTS).toBe('');
  });

  it('gcal-atend-sync ON + ATEND_FROM_AGENDA_SLOTS explícito (reuso do gate por-env)', () => {
    const result = WorkerConfigSchema.parse({
      GCAL_ATEND_SYNC_ENABLED: 'true',
      ATEND_FROM_AGENDA_SLOTS: 'clone_a,clone_b',
      MODO_ATENDENTE_SLOTS: 'clone_atendente',
      GCAL_ATEND_SYNC_MAX_PAGES: '5',
    });
    expect(result.GCAL_ATEND_SYNC_ENABLED).toBe(true);
    expect(result.ATEND_FROM_AGENDA_SLOTS).toBe('clone_a,clone_b');
    expect(result.MODO_ATENDENTE_SLOTS).toBe('clone_atendente');
    expect(result.GCAL_ATEND_SYNC_MAX_PAGES).toBe(5);
  });
});
