/**
 * trial.ts — HMAC do número de WhatsApp para a trava anti trial-farming
 * (Missão 020 F1, doc docs/missoes/020-onboarding-self-service.md).
 *
 * O trial_ledger NUNCA guarda o número cru: guarda HMAC-SHA256(pepper, E.164
 * canônico). O pepper vive em TRIAL_PHONE_PEPPER (env, server-side).
 *
 * LIÇÃO DA CASA (postmortem P0 2026-06-09 / incidente #247): a env é validada
 * LAZY — só no ponto de uso. Boot SEM a env NUNCA crasha (feature dormente
 * atrás da flag PORTAL_SIGNUP). Quem chamar sem pepper recebe
 * TrialPepperMissingError e decide degradar (503 na rota / log no hook).
 *
 * ATENÇÃO: o pepper NUNCA rotaciona — rotação invalida TODOS os lookups do
 * ledger (HMAC determinístico). Gerar UMA vez e guardar como segredo.
 */
import { createHmac } from 'node:crypto';

const PEPPER_ENV = 'TRIAL_PHONE_PEPPER';
const PEPPER_MIN_LENGTH = 16;

export class TrialPepperMissingError extends Error {
  constructor() {
    super(
      `trial: ${PEPPER_ENV} ausente ou curta demais (min ${PEPPER_MIN_LENGTH} chars) — gere com: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"`,
    );
    this.name = 'TrialPepperMissingError';
  }
}

function getPepper(): string {
  const pepper = process.env[PEPPER_ENV];
  if (!pepper || pepper.trim().length < PEPPER_MIN_LENGTH) {
    throw new TrialPepperMissingError();
  }
  return pepper.trim();
}

/** true se o pepper está configurado (sem lançar) — pré-check barato em rotas. */
export function isTrialPepperConfigured(): boolean {
  const pepper = process.env[PEPPER_ENV];
  return !!pepper && pepper.trim().length >= PEPPER_MIN_LENGTH;
}

/**
 * HMAC-SHA256 (hex) do telefone E.164 canônico (ver canonicalE164 em phone.ts).
 * Determinístico: mesmo número => mesmo hash => lookup O(1) no UNIQUE do ledger.
 * @throws TrialPepperMissingError se o pepper não está configurado (lazy).
 */
export function trialPhoneHmac(canonicalPhone: string): string {
  return createHmac('sha256', getPepper()).update(canonicalPhone, 'utf8').digest('hex');
}
