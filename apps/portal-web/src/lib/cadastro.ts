/**
 * Validacao client-side + mascara do cadastro self-service (/cadastro, Missao 020 F1).
 *
 * Espelha o signupSchema do portal-api (apps/portal-api/src/routes/portal-signup.ts):
 * nome 2-100, whatsapp vira canonicalE164 no backend, senha 8-72 (teto real do
 * bcrypt). Erro inline aqui evita bater na API pra tomar 400 — microcopy da spec
 * A3.1/A5 (docs/missoes/020-ux-onboarding-e-agendamento-manual.md).
 */

export const SENHA_MIN = 8;
export const SENHA_MAX = 72;
export const NOME_MIN = 2;
export const NOME_MAX = 100;

/**
 * Área (vertical) do negócio (W8 da Missão 023). São SLUGS estáveis enviados ao
 * backend; o POST /auth/signup já aceita o campo `area` com este enum (o robô
 * nasce com o tom/serviços da área). Os rótulos exibidos vivem no AreaSelector
 * (UI); os slugs aqui são o contrato.
 */
export const AREAS_SLUGS = ['barbearia', 'cabeleireiro', 'manicure', 'estetica', 'outro'] as const;

export type Area = (typeof AREAS_SLUGS)[number];

/** Type guard pro slug de área (defensivo — entrada nunca confiável). */
export function isArea(v: unknown): v is Area {
  return typeof v === 'string' && (AREAS_SLUGS as readonly string[]).includes(v);
}

export interface CadastroDraft {
  nome: string;
  /** Slug da área escolhida, ou null enquanto nada foi marcado. */
  area: Area | null;
  whatsapp: string;
  senha: string;
}

export interface CadastroErrors {
  nome?: string;
  area?: string;
  whatsapp?: string;
  senha?: string;
}

export interface CadastroPayload {
  nome_negocio: string;
  area: Area;
  whatsapp: string;
  senha: string;
}

/** Cards que SUBSTITUEM o form da /cadastro (spec A3.10: beco com saída). */
export type SignupCardView = 'trial-usado' | 'conta-existe' | 'indisponivel' | 'lotado';

/**
 * Mapeia a resposta de erro do POST /auth/signup (portal-signup.ts) pro card
 * dedicado — ou null quando o erro fica no tratamento inline/banner do form:
 *  - 409 trial_ja_usado  -> 'trial-usado' (portão 1, soft check)
 *  - 409 (conta_ja_existe e afins) -> 'conta-existe'
 *  - 404/403 (flag PORTAL_SIGNUP OFF) -> 'indisponivel'
 *  - 503 trial_lotado (teto TRIAL_MAX_ATIVOS, PR #268) -> 'lotado'
 *  - resto (400 telefone_invalido, 500, 503 genérico, rede) -> null
 */
export function signupCardFromError(status: number, code: string | null): SignupCardView | null {
  if (status === 409) return code === 'trial_ja_usado' ? 'trial-usado' : 'conta-existe';
  if (status === 404 || status === 403) return 'indisponivel';
  if (status === 503 && code === 'trial_lotado') return 'lotado';
  return null;
}

/**
 * Reduz a entrada a digitos LOCAIS BR (DDD + numero, max 11).
 * Eco das regras do canonicalE164 (packages/core/phone.ts) pro caso de colar:
 *  - remove prefixo tronco/operadora ("0" a esquerda);
 *  - 12/13 digitos comecando com 55 = DDI colado ("+55 31 9...") -> tira o DDI.
 * Digitar nunca passa de 11, entao a regra do DDI so dispara em paste.
 */
export function phoneDigits(raw: string): string {
  let d = raw.replace(/\D/g, '').replace(/^0+/, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) {
    d = d.slice(2);
  }
  return d.slice(0, 11);
}

/**
 * Mascara progressiva BR: "(11) 99999-9999" (movel 11) / "(11) 9999-9999"
 * (fixo 10). Aceita entrada suja (paste com DDI/pontuacao) via phoneDigits.
 */
export function maskPhoneBR(raw: string): string {
  const d = phoneDigits(raw);
  if (d.length === 0) return '';
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

/**
 * Valida o draft e monta o payload do POST /auth/signup. O whatsapp segue como
 * digitos locais (10/11) — o backend assume BR e canonicaliza (DDI + regra do
 * 9o digito). Senha NAO sofre trim: espaco e caractere valido.
 */
export function validateCadastro(
  d: CadastroDraft,
): { ok: true; value: CadastroPayload } | { ok: false; errors: CadastroErrors } {
  const errors: CadastroErrors = {};

  const nome = d.nome.trim();
  if (nome.length < NOME_MIN) {
    errors.nome = 'Conta o nome do seu negócio pra gente';
  } else if (nome.length > NOME_MAX) {
    errors.nome = `Use no máximo ${NOME_MAX} caracteres`;
  }

  if (!isArea(d.area)) {
    errors.area = 'Escolha o tipo do seu negócio';
  }

  const digits = phoneDigits(d.whatsapp);
  if (digits.length < 10 || digits.length > 11) {
    errors.whatsapp = 'Confere o número? Faltou dígito';
  }

  if (d.senha.length < SENHA_MIN) {
    errors.senha = `Use pelo menos ${SENHA_MIN} caracteres`;
  } else if (d.senha.length > SENHA_MAX) {
    errors.senha = `Use no máximo ${SENHA_MAX} caracteres`;
  }

  // isArea já garante d.area aqui, mas o TS não estreita por meio de errors —
  // o guard explícito mantém o payload tipado sem cast.
  if (errors.nome || errors.area || errors.whatsapp || errors.senha || !isArea(d.area)) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: { nome_negocio: nome, area: d.area, whatsapp: digits, senha: d.senha },
  };
}
