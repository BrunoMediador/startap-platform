/**
 * Unit do helper de auth do webhook WAHA (P0 security — review do PR #268).
 * Lógica pura — sem Fastify, sem env real.
 */
import { describe, expect, it } from 'vitest';
import { WAHA_WEBHOOK_SECRET_HEADER, isWahaWebhookAuthorized, safeEqual } from './webhook-auth.js';

describe('safeEqual', () => {
  it('true para strings idênticas', () => {
    expect(safeEqual('s3cr3t', 's3cr3t')).toBe(true);
  });

  it('false para conteúdo diferente de mesmo tamanho', () => {
    expect(safeEqual('aaaaaa', 'aaaaab')).toBe(false);
  });

  it('false para tamanhos diferentes SEM lançar (timingSafeEqual lança em buffers distintos)', () => {
    expect(() => safeEqual('curto', 'muito-mais-longo')).not.toThrow();
    expect(safeEqual('curto', 'muito-mais-longo')).toBe(false);
  });

  it('lida com unicode multi-byte sem lançar', () => {
    expect(safeEqual('chave-ç€', 'chave-ç€')).toBe(true);
    expect(safeEqual('chave-ç€', 'chave-c€')).toBe(false);
  });
});

describe('isWahaWebhookAuthorized', () => {
  const SECRET = 'whsec_waha_test';

  it('expected ausente (env não configurada) -> autoriza TUDO (retrocompat #247)', () => {
    expect(isWahaWebhookAuthorized(undefined, undefined)).toBe(true);
    expect(isWahaWebhookAuthorized('qualquer-coisa', undefined)).toBe(true);
    expect(isWahaWebhookAuthorized(undefined, '')).toBe(true);
  });

  it('expected presente + header ausente -> nega', () => {
    expect(isWahaWebhookAuthorized(undefined, SECRET)).toBe(false);
  });

  it('expected presente + header vazio -> nega', () => {
    expect(isWahaWebhookAuthorized('', SECRET)).toBe(false);
  });

  it('expected presente + header errado -> nega (mesmo tamanho e tamanho diferente)', () => {
    expect(isWahaWebhookAuthorized('whsec_waha_tesT', SECRET)).toBe(false);
    expect(isWahaWebhookAuthorized('errado', SECRET)).toBe(false);
  });

  it('expected presente + header certo -> autoriza', () => {
    expect(isWahaWebhookAuthorized(SECRET, SECRET)).toBe(true);
  });

  it('header como array (HTTP permite repetição) usa o primeiro valor', () => {
    expect(isWahaWebhookAuthorized([SECRET, 'lixo'], SECRET)).toBe(true);
    expect(isWahaWebhookAuthorized(['lixo', SECRET], SECRET)).toBe(false);
    expect(isWahaWebhookAuthorized([], SECRET)).toBe(false);
  });

  it('nome do header é o contrato esperado pelo runbook/painel-admin', () => {
    // Mudar isso quebra TODA sessão WAHA configurada — runbook + painel-admin
    // usam X-Webhook-Secret. Teste trava o contrato.
    expect(WAHA_WEBHOOK_SECRET_HEADER).toBe('x-webhook-secret');
  });
});
