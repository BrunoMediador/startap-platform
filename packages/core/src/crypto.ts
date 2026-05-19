/**
 * crypto.ts — criptografia AES-256-GCM para segredos armazenados no banco.
 *
 * Por que existe: gcal_credentials_json (Service Account JSON dos clientes)
 * estava em texto claro no Postgres. Auditoria 2026-05-19 classificou como P0.
 *
 * Formato armazenado:  enc:v1:<base64(iv)>:<base64(authTag)>:<base64(ciphertext)>
 * O prefixo "enc:v1:" permite detectar dados legados (sem prefixo = texto claro)
 * e fazer fallback durante a janela de migração.
 *
 * Chave: GCAL_ENCRYPTION_KEY — 32 bytes em hex (64 chars). Obrigatória no boot;
 * ausência lança erro imediato (não silencioso). Para gerar:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // recomendado para GCM
const PREFIX = 'enc:v1:';

function getKey(): Buffer {
  const hex = process.env.GCAL_ENCRYPTION_KEY;
  if (!hex || hex.trim() === '') {
    throw new Error(
      'crypto: GCAL_ENCRYPTION_KEY ausente — defina 32 bytes hex no .env antes de iniciar',
    );
  }
  const buf = Buffer.from(hex.trim(), 'hex');
  if (buf.length !== 32) {
    throw new Error(
      `crypto: GCAL_ENCRYPTION_KEY deve ter 32 bytes (64 chars hex); recebido ${buf.length} bytes`,
    );
  }
  return buf;
}

/**
 * Criptografa um texto plano com AES-256-GCM.
 * Retorna string no formato enc:v1:<iv>:<authTag>:<ciphertext> (tudo base64).
 */
export function encryptSecret(plain: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return (
    PREFIX +
    iv.toString('base64') +
    ':' +
    authTag.toString('base64') +
    ':' +
    encrypted.toString('base64')
  );
}

/**
 * Descriptografa um valor armazenado pelo encryptSecret.
 * Fallback: se o valor não começa com "enc:v1:", devolve como está
 * (permite migração gradual de dados legados em texto claro).
 */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) {
    // Dado legado — texto claro. Aceitar durante janela de migração.
    return stored;
  }

  const rest = stored.slice(PREFIX.length);
  const parts = rest.split(':');
  if (parts.length !== 3) {
    throw new Error('crypto: formato enc:v1 inválido — esperado 3 partes após prefixo');
  }

  const [ivB64, authTagB64, ciphertextB64] = parts;
  const key = getKey();
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: 16 });
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error('crypto: falha na descriptografia — authTag inválido ou dado corrompido');
  }
}
