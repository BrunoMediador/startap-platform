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

export interface CadastroDraft {
  nome: string;
  whatsapp: string;
  senha: string;
}

export interface CadastroErrors {
  nome?: string;
  whatsapp?: string;
  senha?: string;
}

export interface CadastroPayload {
  nome_negocio: string;
  whatsapp: string;
  senha: string;
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

  const digits = phoneDigits(d.whatsapp);
  if (digits.length < 10 || digits.length > 11) {
    errors.whatsapp = 'Confere o número? Faltou dígito';
  }

  if (d.senha.length < SENHA_MIN) {
    errors.senha = `Use pelo menos ${SENHA_MIN} caracteres`;
  } else if (d.senha.length > SENHA_MAX) {
    errors.senha = `Use no máximo ${SENHA_MAX} caracteres`;
  }

  if (errors.nome || errors.whatsapp || errors.senha) {
    return { ok: false, errors };
  }
  return { ok: true, value: { nome_negocio: nome, whatsapp: digits, senha: d.senha } };
}
