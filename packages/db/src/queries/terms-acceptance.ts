/**
 * terms-acceptance — PROVA DE ACEITE (append-only) dos Termos de Uso + Política de
 * Privacidade no cadastro self-service (SCRUM-1 / LGPD consentimento demonstrável).
 *
 * Tabela `terms_acceptances` (migration 063). Esta camada SÓ persiste/lê o fato; as
 * versões aceitas são SERVER-AUTHORITATIVE (vêm de constantes do portal-api, nunca do
 * cliente). Cada aceite é imutável: reaceite (nova versão) é uma NOVA linha — nunca
 * UPDATE/DELETE.
 *
 * ISOLAMENTO (regra de ouro 5, ADR 0018): a escrita carimba slot (sempre) + tenant_id
 * (caminho RLS). O tenant_id é resolvido do clone pelo CALLER (tenant.resolveTenantId),
 * que é fail-safe — pode chegar null sem derrubar o aceite (coluna NULLABLE).
 *
 * LGPD: ip/user_agent são dado pessoal — ficam só aqui (prova), NUNCA em log claro.
 */
import { query } from '../client.js';

export interface TermsAcceptanceRow {
  id: number;
  slot: string;
  tenant_id: string | null;
  portal_user_id: number | null;
  terms_version: string;
  privacy_version: string;
  ip: string | null;
  user_agent: string | null;
  accepted_at: Date;
  created_at: Date;
}

export interface RecordTermsAcceptanceInput {
  /** Tenant dono do aceite — SEMPRE da sessão/provisionamento, nunca de input livre. */
  slot: string;
  /** tenant_id resolvido do clone pelo CALLER (resolveTenantId, fail-safe -> pode ser null). */
  tenantId: string | null;
  /** Usuário que aceitou (id de portal_users); null tolerado (ON DELETE SET NULL). */
  portalUserId: number | null;
  /** Versão dos Termos aceita — server-authoritative (ex.: 'v1'). */
  termsVersion: string;
  /** Versão da Política de Privacidade aceita — server-authoritative (ex.: 'v1'). */
  privacyVersion: string;
  /** IP de origem (LGPD: dado pessoal; nunca logar em claro). */
  ip: string | null;
  /** User-agent do navegador no ato do aceite (trilha de auditoria). */
  userAgent: string | null;
}

function normalize(row: TermsAcceptanceRow & { id: string | number }): TermsAcceptanceRow {
  return {
    ...row,
    id: Number(row.id),
    portal_user_id: row.portal_user_id == null ? null : Number(row.portal_user_id),
  };
}

/**
 * Grava UM aceite (append-only). tenant_id é parâmetro PRÓPRIO ($2) — nunca reusa o
 * placeholder do slot (lição do bug #309/ADR 0018: reusar $1 quebra o type deduction).
 */
export async function recordTermsAcceptance(
  input: RecordTermsAcceptanceInput,
): Promise<TermsAcceptanceRow> {
  const r = await query<TermsAcceptanceRow & { id: string }>(
    `INSERT INTO terms_acceptances
       (slot, tenant_id, portal_user_id, terms_version, privacy_version, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, slot, tenant_id, portal_user_id, terms_version, privacy_version,
               ip, user_agent, accepted_at, created_at`,
    [
      input.slot,
      input.tenantId,
      input.portalUserId,
      input.termsVersion,
      input.privacyVersion,
      input.ip,
      input.userAgent,
    ],
  );
  return normalize(r.rows[0]);
}

/**
 * Último aceite registrado para um slot (auditoria/suporte). Escopo SEMPRE por slot
 * (anti-IDOR). null quando o tenant nunca aceitou.
 */
export async function getLatestAcceptanceForSlot(slot: string): Promise<TermsAcceptanceRow | null> {
  const r = await query<TermsAcceptanceRow & { id: string }>(
    `SELECT id, slot, tenant_id, portal_user_id, terms_version, privacy_version,
            ip, user_agent, accepted_at, created_at
       FROM terms_acceptances
      WHERE slot = $1
      ORDER BY accepted_at DESC, id DESC
      LIMIT 1`,
    [slot],
  );
  return r.rows[0] ? normalize(r.rows[0]) : null;
}
