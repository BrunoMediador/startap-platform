/**
 * crypto.ts — criptografia AES-256-GCM para segredos armazenados no banco.
 *
 * Por que existe: gcal_credentials_json (Service Account JSON dos clientes)
 * estava em texto claro no Postgres. Auditoria 2026-05-19 classificou como P0.
 *
 * Formato armazenado:  enc:<ver>:<base64(iv)>:<base64(authTag)>:<base64(ciphertext)>
 *   - enc:v2: cifrado com GCAL_ENCRYPTION_KEY (chave "nova/atual")
 *   - enc:v1: cifrado com a chave legada — decifrado com GCAL_ENCRYPTION_KEY_OLD
 *             se definida, senão com GCAL_ENCRYPTION_KEY (estado de HOJE).
 *   - sem prefixo "enc:": dado legado em texto claro (fallback de migração).
 *
 * ── Rotação de chave (ADR 0024, AC5) ─────────────────────────────────────────
 * Versionamento de chave permite trocar GCAL_ENCRYPTION_KEY sem perder credencial:
 *   1) provisiona K_new como GCAL_ENCRYPTION_KEY e K_old como GCAL_ENCRYPTION_KEY_OLD;
 *   2) deploy: encryptSecret passa a gravar enc:v2 com K_new; decryptSecret ainda
 *      lê enc:v1 com K_old (janela de coexistência);
 *   3) scripts/rotate-gcal-key.ts re-cifra v1→v2;
 *   4) remove GCAL_ENCRYPTION_KEY_OLD após validar zero enc:v1 restante.
 * Runbook: docs/runbooks/rotacao-gcal-encryption-key.md
 *
 * ⚠️ RETROCOMPAT (inegociável): no estado de HOJE — tudo é enc:v1, só
 * GCAL_ENCRYPTION_KEY definida, sem OLD — toda credencial existente continua
 * decifrando com GCAL_ENCRYPTION_KEY, idêntico ao comportamento anterior.
 *
 * Chaves: 32 bytes em hex (64 chars). GCAL_ENCRYPTION_KEY é obrigatória no boot;
 * ausência lança erro imediato (não silencioso). GCAL_ENCRYPTION_KEY_OLD é
 * opcional (só existe durante a janela de rotação). Para gerar:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // recomendado para GCM
const PREFIX_V1 = 'enc:v1:';
const PREFIX_V2 = 'enc:v2:';
/** Versão gravada por encryptSecret a partir do ADR 0024. */
export const CURRENT_PREFIX = PREFIX_V2;

/**
 * Carrega e valida uma chave hex de 32 bytes a partir de uma env var.
 * @param envName nome da variável (ex.: GCAL_ENCRYPTION_KEY)
 * @param required se true, ausência/ vazio lança erro; se false, devolve null.
 */
function loadKey(envName: string, required: boolean): Buffer | null {
  const hex = process.env[envName];
  if (!hex || hex.trim() === '') {
    if (!required) {
      return null;
    }
    throw new Error(`crypto: ${envName} ausente — defina 32 bytes hex no .env antes de iniciar`);
  }
  const buf = Buffer.from(hex.trim(), 'hex');
  if (buf.length !== 32) {
    throw new Error(
      `crypto: ${envName} deve ter 32 bytes (64 chars hex); recebido ${buf.length} bytes`,
    );
  }
  return buf;
}

/** Chave atual (nova). Obrigatória. */
function getCurrentKey(): Buffer {
  return loadKey('GCAL_ENCRYPTION_KEY', true) as Buffer;
}

/** Chave legada para decifrar enc:v1 durante a janela de rotação. Opcional. */
function getOldKey(): Buffer | null {
  return loadKey('GCAL_ENCRYPTION_KEY_OLD', false);
}

/**
 * Seleciona a chave de descriptografia pelo prefixo:
 *   - enc:v2: → GCAL_ENCRYPTION_KEY (atual)
 *   - enc:v1: → GCAL_ENCRYPTION_KEY_OLD se definida, senão GCAL_ENCRYPTION_KEY
 *
 * ⚠️ enc:v1 SEM OLD definida usa GCAL_ENCRYPTION_KEY — comportamento idêntico
 * ao estado atual (retrocompat com as credenciais de hoje).
 */
function getDecryptionKey(prefix: string): Buffer {
  if (prefix === PREFIX_V2) {
    return getCurrentKey();
  }
  // enc:v1
  return getOldKey() ?? getCurrentKey();
}

/**
 * Criptografa um texto plano com AES-256-GCM usando a chave atual.
 * Retorna string no formato enc:v2:<iv>:<authTag>:<ciphertext> (tudo base64).
 */
export function encryptSecret(plain: string): string {
  const key = getCurrentKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${CURRENT_PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Descriptografa um valor armazenado pelo encryptSecret (enc:v1 ou enc:v2).
 * Fallback: se o valor não tem prefixo "enc:", devolve como está
 * (permite migração gradual de dados legados em texto claro).
 */
export function decryptSecret(stored: string): string {
  const prefix = stored.startsWith(PREFIX_V2)
    ? PREFIX_V2
    : stored.startsWith(PREFIX_V1)
      ? PREFIX_V1
      : null;

  if (prefix === null) {
    // Dado legado — texto claro. Aceitar durante janela de migração.
    return stored;
  }

  const rest = stored.slice(prefix.length);
  const parts = rest.split(':');
  if (parts.length !== 3) {
    throw new Error(
      `crypto: formato ${prefix.replace(/:$/, '')} inválido — esperado 3 partes após prefixo`,
    );
  }

  const [ivB64, authTagB64, ciphertextB64] = parts;
  const key = getDecryptionKey(prefix);
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
