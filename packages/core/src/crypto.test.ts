import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { encryptSecret, decryptSecret } from './crypto.js';

// Helper para limpar/setar a env var entre testes
const VALID_KEY = 'a'.repeat(64); // 32 bytes hex válidos (64 chars 'a')

function setKey(value: string | undefined) {
  if (value === undefined) {
    delete process.env.GCAL_ENCRYPTION_KEY;
  } else {
    process.env.GCAL_ENCRYPTION_KEY = value;
  }
}

describe('encryptSecret / decryptSecret', () => {
  beforeEach(() => setKey(VALID_KEY));
  afterEach(() => setKey(undefined));

  it('round-trip: encrypt → decrypt retorna texto original', () => {
    const plain = '{"type":"service_account","project_id":"meu-projeto","private_key":"-----BEGIN RSA PRIVATE KEY-----\\nABC\\n-----END RSA PRIVATE KEY-----"}';
    const encrypted = encryptSecret(plain);
    expect(encrypted.startsWith('enc:v1:')).toBe(true);
    expect(decryptSecret(encrypted)).toBe(plain);
  });

  it('cada chamada gera ciphertext diferente (IV aleatório)', () => {
    const plain = 'segredo';
    const enc1 = encryptSecret(plain);
    const enc2 = encryptSecret(plain);
    expect(enc1).not.toBe(enc2);
    // mas ambos descriptografam corretamente
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
    // corrompe a parte do authTag (2ª parte após enc:v1:) — 16 bytes (128 bits)
    const parts = enc.split(':');
    // partes: ['enc', 'v1', iv, authTag, ciphertext]
    parts[3] = Buffer.from('tagcorrompida!!!').toString('base64'); // 16 bytes
    const corrupted = parts.join(':');
    expect(() => decryptSecret(corrupted)).toThrow('authTag inválido ou dado corrompido');
  });
});
