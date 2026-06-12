/**
 * Unit do helper de auth do webhook WAHA (P0 security — review do PR #268 +
 * HMAC nativo do spike 2026-06-11). Lógica pura — sem Fastify, sem env real.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  WAHA_WEBHOOK_SECRET_HEADER,
  isWahaWebhookAuthorized,
  resolveWahaWebhookAuthMode,
  safeEqual,
  verifyWahaHmacSignature,
} from './webhook-auth.js';

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

describe('resolveWahaWebhookAuthMode', () => {
  it('HMAC key presente -> hmac, MESMO com o secret estático também presente (plano A governa)', () => {
    expect(resolveWahaWebhookAuthMode('k', undefined)).toBe('hmac');
    expect(resolveWahaWebhookAuthMode('k', 's')).toBe('hmac');
  });

  it('só secret estático -> static-header', () => {
    expect(resolveWahaWebhookAuthMode(undefined, 's')).toBe('static-header');
    expect(resolveWahaWebhookAuthMode('', 's')).toBe('static-header');
  });

  it('nenhum -> open (retrocompat #247)', () => {
    expect(resolveWahaWebhookAuthMode(undefined, undefined)).toBe('open');
    expect(resolveWahaWebhookAuthMode('', '')).toBe('open');
  });
});

describe('verifyWahaHmacSignature', () => {
  const KEY = 'hmac_key_unit_test';
  const sign = (body: Buffer | string, key = KEY, alg: 'sha256' | 'sha512' = 'sha512') =>
    createHmac(alg, key).update(body).digest('hex');

  it('assinatura sha512 correta sobre o raw body -> true', () => {
    const body = Buffer.from('{"event":"message"}', 'utf8');
    expect(verifyWahaHmacSignature(body, sign(body), KEY, 'sha512')).toBe(true);
  });

  it('hex é case-insensitive (digest em UPPERCASE valida)', () => {
    const body = Buffer.from('{"a":1}', 'utf8');
    expect(verifyWahaHmacSignature(body, sign(body).toUpperCase(), KEY, 'sha512')).toBe(true);
  });

  it('body com acentos/emoji: assinatura sobre os BYTES exatos valida; 1 byte alterado invalida', () => {
    const original = Buffer.from('{"body":"Olá, agendamento às 14h ✅💈"}', 'utf8');
    const signature = sign(original);
    expect(verifyWahaHmacSignature(original, signature, KEY, 'sha512')).toBe(true);
    // Integridade: mesmo payload com 1 byte trocado não valida com a mesma assinatura.
    const tampered = Buffer.from(original);
    tampered[tampered.length - 3] = 0x21; // troca 1 byte dentro do conteúdo
    expect(verifyWahaHmacSignature(tampered, signature, KEY, 'sha512')).toBe(false);
  });

  it('assinatura ausente/vazia -> false', () => {
    const body = Buffer.from('{}', 'utf8');
    expect(verifyWahaHmacSignature(body, undefined, KEY, 'sha512')).toBe(false);
    expect(verifyWahaHmacSignature(body, '', KEY, 'sha512')).toBe(false);
    expect(verifyWahaHmacSignature(body, [], KEY, 'sha512')).toBe(false);
  });

  it('key errada ou algoritmo errado -> false', () => {
    const body = Buffer.from('{"a":1}', 'utf8');
    expect(verifyWahaHmacSignature(body, sign(body, 'outra-key'), KEY, 'sha512')).toBe(false);
    expect(verifyWahaHmacSignature(body, sign(body, KEY, 'sha256'), KEY, 'sha512')).toBe(false);
    // Mas com o algoritmo CONFIGURADO pra sha256 (contingência), valida.
    expect(verifyWahaHmacSignature(body, sign(body, KEY, 'sha256'), KEY, 'sha256')).toBe(true);
  });

  it('header repetido (array) usa o primeiro valor', () => {
    const body = Buffer.from('{"a":1}', 'utf8');
    expect(verifyWahaHmacSignature(body, [sign(body), 'lixo'], KEY, 'sha512')).toBe(true);
    expect(verifyWahaHmacSignature(body, ['lixo', sign(body)], KEY, 'sha512')).toBe(false);
  });

  it('assinatura de tamanho diferente não lança (safeEqual cobre length mismatch)', () => {
    const body = Buffer.from('{"a":1}', 'utf8');
    expect(() => verifyWahaHmacSignature(body, 'curto', KEY, 'sha512')).not.toThrow();
    expect(verifyWahaHmacSignature(body, 'curto', KEY, 'sha512')).toBe(false);
  });
});
