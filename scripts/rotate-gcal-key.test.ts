import { createCipheriv, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reencryptV1ToV2 } from './gcal-key-rotation.js';

const NEW_KEY = 'a'.repeat(64); // GCAL_ENCRYPTION_KEY (chave atual)
const OLD_KEY = 'b'.repeat(64); // GCAL_ENCRYPTION_KEY_OLD (chave legada)

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function makeV1(plain: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

describe('reencryptV1ToV2 (transformação do rotate-gcal-key)', () => {
  beforeEach(() => {
    setEnv('GCAL_ENCRYPTION_KEY', NEW_KEY);
    setEnv('GCAL_ENCRYPTION_KEY_OLD', OLD_KEY);
  });
  afterEach(() => {
    setEnv('GCAL_ENCRYPTION_KEY', undefined);
    setEnv('GCAL_ENCRYPTION_KEY_OLD', undefined);
  });

  it('re-cifra enc:v1(OLD) → enc:v2(NEW) preservando o plaintext', () => {
    const plain = '{"type":"service_account","project_id":"rotacao"}';
    const v1 = makeV1(plain, OLD_KEY);

    const result = reencryptV1ToV2(v1);
    expect(result.changed).toBe(true);
    expect(result.reciphered).not.toBeNull();
    expect(result.reciphered?.startsWith('enc:v2:')).toBe(true);
    expect(result.reciphered).not.toBe(v1);
  });

  it('idempotente: enc:v2 é no-op (não re-cifra o que já está na versão atual)', () => {
    // Um valor enc:v2 qualquer não deve ser tocado.
    const v2 = makeV1('x', NEW_KEY).replace('enc:v1:', 'enc:v2:');
    const result = reencryptV1ToV2(v2);
    expect(result.changed).toBe(false);
    expect(result.reciphered).toBeNull();
  });

  it('idempotente: texto claro legado é no-op', () => {
    const result = reencryptV1ToV2('{"type":"service_account"}');
    expect(result.changed).toBe(false);
    expect(result.reciphered).toBeNull();
  });

  it('REGRESSÃO estado de hoje: enc:v1 cifrado com a chave ATUAL re-cifra mesmo sem OLD', () => {
    // Hoje tudo é enc:v1 cifrado com GCAL_ENCRYPTION_KEY e não há OLD.
    setEnv('GCAL_ENCRYPTION_KEY_OLD', undefined);
    const plain = '{"type":"service_account","project_id":"cirilo-prod"}';
    const v1ComAtual = makeV1(plain, NEW_KEY);

    const result = reencryptV1ToV2(v1ComAtual);
    expect(result.changed).toBe(true);
    expect(result.reciphered?.startsWith('enc:v2:')).toBe(true);
  });
});
