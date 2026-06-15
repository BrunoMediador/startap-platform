/**
 * package-phone.ts — HMAC do número de WhatsApp do cliente final para a
 * IDENTIDADE de saldo de pacote (ADR 0025, pacotes de serviço — BLOCO 2a).
 *
 * client_package_credits NUNCA guarda o número cru: guarda
 * HMAC-SHA256(PACKAGE_PHONE_PEPPER, E.164 canônico) + um phone_hint mascarado
 * para suporte. O número canônico vem de canonicalE164 (phone.ts), o hint de
 * phoneHint — mesmo PADRÃO do trial (trial.ts), para identidade estável BR
 * (o 9º dígito móvel não diferencia identidade).
 *
 * ⚠️ PEPPER PRÓPRIO — DECISÃO LGPD (ADR 0025 §4): pacotes usam
 * PACKAGE_PHONE_PEPPER, **distinto** de TRIAL_PHONE_PEPPER. Reusar a mesma
 * chave faria o MESMO número gerar o MESMO hash nas duas tabelas, permitindo um
 * JOIN TRIVIAL entre trial_ledger e client_package_credits pelo hash — exatamente
 * a linkability cross-finalidade (anti-trial-farming vs. saldo de pacote) que a
 * minimização desencoraja. Peppers separados impedem esse join.
 *
 * LIÇÃO DA CASA (postmortem P0 2026-06-09 / incidente #247): a env é validada
 * LAZY — só no ponto de uso, quando de fato vamos hashear um telefone de pacote.
 * Boot SEM a env NUNCA crasha (feature dormente atrás da flag PACOTES_ENABLED).
 * Quem chamar sem pepper recebe PackagePepperMissingError e degrada.
 *
 * ATENÇÃO: o pepper NUNCA rotaciona — rotação invalida TODOS os lookups de saldo
 * (HMAC determinístico). Gerar UMA vez e guardar como segredo.
 */
import { createHmac } from 'node:crypto';

const PEPPER_ENV = 'PACKAGE_PHONE_PEPPER';
const PEPPER_MIN_LENGTH = 16;

export class PackagePepperMissingError extends Error {
  constructor() {
    super(
      `packages: ${PEPPER_ENV} ausente ou curta demais (min ${PEPPER_MIN_LENGTH} chars) — gere com: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"`,
    );
    this.name = 'PackagePepperMissingError';
  }
}

function getPepper(): string {
  const pepper = process.env[PEPPER_ENV];
  if (!pepper || pepper.trim().length < PEPPER_MIN_LENGTH) {
    throw new PackagePepperMissingError();
  }
  return pepper.trim();
}

/** true se o pepper de pacotes está configurado (sem lançar) — pré-check barato. */
export function isPackagePepperConfigured(): boolean {
  const pepper = process.env[PEPPER_ENV];
  return !!pepper && pepper.trim().length >= PEPPER_MIN_LENGTH;
}

/**
 * HMAC-SHA256 (hex) do telefone E.164 canônico (ver canonicalE164 em phone.ts),
 * com o PEPPER PRÓPRIO de pacotes. Determinístico: mesmo número => mesmo hash =>
 * lookup O(1) no índice (slot, cliente_phone_hmac).
 *
 * NÃO é compatível com trialPhoneHmac (pepper diferente de propósito — ver topo).
 * @throws PackagePepperMissingError se o pepper de pacotes não está configurado (lazy).
 */
export function packagePhoneHmac(canonicalPhone: string): string {
  return createHmac('sha256', getPepper()).update(canonicalPhone, 'utf8').digest('hex');
}
