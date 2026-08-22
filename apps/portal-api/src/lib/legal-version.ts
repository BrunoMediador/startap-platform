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
export const PRIVACY_VERSION = 'v3';

/**
 * Hash de prova (SCRUM-31 / ADR 0029): sha256(conteúdo canônico + versão) de cada
 * documento. SERVER-AUTHORITATIVE — gravado em CADA aceite (terms_acceptances) ao lado
 * da versão, como impressão digital imutável do TEXTO aceito (tamper-evidence: detecta
 * edição de texto sem bump de versão; permite verificar a prova contra um texto arquivado).
 *
 * Valor é uma CONSTANTE por versão: o conteúdo de uma versão é fixo, logo o hash também.
 * Estes literais são o sha256 do conteúdo PUBLICADO (apps/portal-web/src/lib/legal.ts) —
 * Termos v1, Política v3 —, computado pela serialização canônica de ../lib/legal-hash.ts
 * (canonicalizeLegalDoc).
 *
 * ⚠️ AO BUMPAR A VERSÃO (v1 -> v2) E/OU MUDAR O TEXTO LEGAL: recompute estes hashes.
 *   Procedimento (a partir do conteúdo canônico de portal-web/src/lib/legal.ts):
 *     computeLegalDocHash(TERMOS_DE_USO)  -> novo TERMS_HASH
 *     computeLegalDocHash(POLITICA_PRIVACIDADE) -> novo PRIVACY_HASH
 *   (canonicalizeLegalDoc inclui a VERSÃO na string, então o hash muda no bump mesmo que
 *   o texto não mude.) MANTER EM SINCRONIA com portal-web — ver legal.ts.
 */
export const TERMS_HASH = '214f5c8e5230edd9a9b483458ec03ce851ae49b24bb1ce57fc5e414f0db9a7bd';
// v3 (21/08/2026): recomputado sobre a Política que adiciona a foto de perfil do
// WhatsApp no CRM, já com version=v3 + updatedAt=21/08/2026.
export const PRIVACY_HASH = '135b542e9e999a8c8f297fe3780dcc93c0a1137b40c2d25db2536f4962e76361';

/** Hashes vigentes (server-authoritative) gravados na prova de aceite. */
export function currentLegalHashes(): { termsHash: string; privacyHash: string } {
  return { termsHash: TERMS_HASH, privacyHash: PRIVACY_HASH };
}

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
