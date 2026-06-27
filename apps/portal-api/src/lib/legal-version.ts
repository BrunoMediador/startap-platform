/**
 * Versões vigentes dos documentos legais + helper do gate de aceite (SCRUM-1 / LGPD).
 *
 * SERVER-AUTHORITATIVE: as versões gravadas como prova de aceite (terms_acceptances)
 * saem DAQUI, nunca do cliente. Usadas no signup (fluxo 1: novo cliente) E no gate
 * pós-login (fluxo 2: cliente atual). MANTER EM SINCRONIA com o conteúdo legal do
 * portal-web (apps/portal-web/src/lib/legal.ts: TERMS_VERSION / PRIVACY_VERSION).
 *
 * Ao mudar o texto legal: bumpar a versão (v1 -> v2). O gate pós-login compara a
 * última versão aceita pelo tenant com estas — versão diferente => re-pede o aceite.
 */

export const TERMS_VERSION = 'v1';
export const PRIVACY_VERSION = 'v1';

/** Teto do user_agent persistido na prova (header é livre; evita linha gigante). */
export const USER_AGENT_MAX = 512;

/**
 * Decide se o tenant precisa (re)aceitar. true quando NUNCA aceitou (row null) ou
 * quando a versão aceita não é a vigente (texto legal mudou desde o último aceite).
 */
export function needsAcceptance(
  last: { terms_version: string; privacy_version: string } | null,
): boolean {
  if (!last) return true;
  return last.terms_version !== TERMS_VERSION || last.privacy_version !== PRIVACY_VERSION;
}
