/**
 * gcal-key-rotation — transformação pura de re-cifragem enc:v1 → enc:v2.
 *
 * Separado de rotate-gcal-key.ts (que orquestra o acesso ao banco) para ser
 * testável SEM tocar em @startap/db: depende apenas de @startap/core.
 * Parte do mecanismo de rotação da GCAL_ENCRYPTION_KEY (ADR 0024, AC5).
 */
import { CURRENT_PREFIX, decryptSecret, encryptSecret } from '@startap/core';

export const V1_PREFIX = 'enc:v1:';

export interface RotateResult {
  /** Valor re-cifrado em enc:v2 (ou null se a entrada não é enc:v1 — no-op). */
  reciphered: string | null;
  /** true se houve transformação; false se a entrada foi pulada (idempotência). */
  changed: boolean;
}

/**
 * Dado um valor armazenado, devolve a versão re-cifrada em enc:v2 SE for
 * enc:v1; caso contrário, no-op (changed=false).
 *
 * Usa decryptSecret/encryptSecret do core, então herda a seleção de chave por
 * prefixo (enc:v1 → GCAL_ENCRYPTION_KEY_OLD/atual) e a verificação de authTag
 * (falha de integridade propaga como erro — nunca grava lixo).
 */
export function reencryptV1ToV2(stored: string): RotateResult {
  if (!stored.startsWith(V1_PREFIX)) {
    // Já é enc:v2, texto claro ou outro — nada a fazer (idempotência).
    return { reciphered: null, changed: false };
  }
  const plain = decryptSecret(stored); // decifra enc:v1 com a chave correta
  const reciphered = encryptSecret(plain); // re-cifra como enc:v2 com a chave atual
  if (!reciphered.startsWith(CURRENT_PREFIX)) {
    // Salvaguarda: encryptSecret deve sempre gravar a versão atual.
    throw new Error(
      `gcal-key-rotation: encryptSecret não gerou ${CURRENT_PREFIX} — abortando para não corromper`,
    );
  }
  return { reciphered, changed: true };
}
