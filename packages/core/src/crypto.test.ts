import { createCipheriv, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CURRENT_PREFIX, decryptSecret, encryptSecret } from './crypto.js';

// Helper para limpar/setar as env vars entre testes
const VALID_KEY = 'a'.repeat(64); // 32 bytes hex válidos (64 chars 'a')
const OLD_KEY = 'b'.repeat(64); // chave legada distinta (32 bytes hex)

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function setKey(value: string | undefined) {
  setEnv('GCAL_ENCRYPTION_KEY', value);
}

function setOldKey(value: string | undefined) {
  setEnv('GCAL_ENCRYPTION_KEY_OLD', value);
}

/**
 * Cifra um texto no formato enc:v1 com uma chave hex específica — simula um
 * valor "antigo" já armazenado no banco (encryptSecret hoje grava enc:v2).
 */
function makeV1(plain: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

describe('encryptSecret / decryptSecret', () => {
  beforeEach(() => {
    setKey(VALID_KEY);
    setOldKey(undefined);
  });
  afterEach(() => {
    setKey(undefined);
    setOldKey(undefined);
  });

  it('round-trip enc:v2: encrypt → decrypt retorna texto original', () => {
    const plain =
      '{"type":"service_account","project_id":"meu-projeto","private_key":"-----BEGIN RSA PRIVATE KEY-----\\nABC\\n-----END RSA PRIVATE KEY-----"}';
    const encrypted = encryptSecret(plain);
    expect(encrypted.startsWith(CURRENT_PREFIX)).toBe(true);
    expect(encrypted.startsWith('enc:v2:')).toBe(true);
    expect(decryptSecret(encrypted)).toBe(plain);
  });

  it('cada chamada gera ciphertext diferente (IV aleatório)', () => {
    const plain = 'segredo';
    const enc1 = encryptSecret(plain);
    const enc2 = encryptSecret(plain);
    expect(enc1).not.toBe(enc2);
    expect(decryptSecret(enc1)).toBe(plain);
    expect(decryptSecret(enc2)).toBe(plain);
  });

  it('decrypt de legado (sem prefixo) retorna o próprio valor — fallback texto claro', () => {
    const legacy = '{"type":"service_account","project_id":"legado"}';
    expect(decryptSecret(legacy)).toBe(legacy);
  });

  it('erro quando GCAL_ENCRYPTION_KEY ausente', () => {
    setKey(undefined);
    expect(() => encryptSecret('qualquer')).toThrow('GCAL_ENCRYPTION_KEY ausente');
  });

  it('erro quando GCAL_ENCRYPTION_KEY com tamanho errado', () => {
    setKey('aabb'); // apenas 2 bytes
    expect(() => encryptSecret('qualquer')).toThrow('deve ter 32 bytes');
  });

  it('erro quando authTag corrompido', () => {
    const plain = 'dado sensível';
    const enc = encryptSecret(plain);
    const parts = enc.split(':');
    // partes: ['enc', 'v2', iv, authTag, ciphertext]
    parts[3] = Buffer.from('tagcorrompida!!!').toString('base64'); // 16 bytes
    const corrupted = parts.join(':');
    expect(() => decryptSecret(corrupted)).toThrow('authTag inválido ou dado corrompido');
  });
});

// ── Versionamento de chave / rotação (ADR 0024, AC5) ─────────────────────────
describe('versionamento de chave', () => {
  afterEach(() => {
    setKey(undefined);
    setOldKey(undefined);
  });

  it('REGRESSÃO Cirilo/Samuel: enc:v1 cifrado com a chave atual decifra SEM OLD definida (estado de hoje)', () => {
    // Estado de hoje: tudo é enc:v1, cifrado com GCAL_ENCRYPTION_KEY, sem OLD.
    setKey(VALID_KEY);
    setOldKey(undefined);
    const plain = '{"type":"service_account","project_id":"cirilo-prod"}';
    const storedHoje = makeV1(plain, VALID_KEY); // como está no banco agora
    // Deve decifrar exatamente como antes, com a chave atual.
    expect(decryptSecret(storedHoje)).toBe(plain);
  });

  it('janela de rotação: enc:v1 decifra com OLD e enc:v2 decifra com a chave atual', () => {
    // K_new = VALID_KEY (GCAL_ENCRYPTION_KEY), K_old = OLD_KEY (GCAL_ENCRYPTION_KEY_OLD)
    setKey(VALID_KEY);
    setOldKey(OLD_KEY);

    const plain = '{"type":"service_account","project_id":"em-rotacao"}';

    // valor antigo cifrado com K_old, marcado enc:v1
    const v1ComOld = makeV1(plain, OLD_KEY);
    expect(decryptSecret(v1ComOld)).toBe(plain);

    // valor novo gravado por encryptSecret → enc:v2 com K_new
    const v2 = encryptSecret(plain);
    expect(v2.startsWith('enc:v2:')).toBe(true);
    expect(decryptSecret(v2)).toBe(plain);
  });

  it('enc:v1 cifrado com OLD FALHA se OLD não estiver definida (seleção de chave por prefixo)', () => {
    // Sem OLD, enc:v1 usa a chave atual — se o dado foi cifrado com outra chave,
    // o authTag não bate. Garante que a seleção de chave é mesmo por prefixo.
    setKey(VALID_KEY);
    setOldKey(undefined);
    const v1ComOutraChave = makeV1('segredo', OLD_KEY);
    expect(() => decryptSecret(v1ComOutraChave)).toThrow('authTag inválido ou dado corrompido');
  });
});
