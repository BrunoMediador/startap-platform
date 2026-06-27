/**
 * Geração da senha de LOGIN do colaborador quando o DONO gera pelo PORTAL
 * (POST /portal/equipe/:id/gerar-senha, SCRUM-32 follow-up).
 *
 * ESPELHA `_genPortalPassword` do gestão (painel-admin/server.js): MESMO alfabeto sem
 * caracteres ambíguos (sem 0/O/1/l/I) e MESMO comprimento (14). A senha em claro existe
 * só por um instante — vai cifrada (bcrypt) pro banco e aparece UMA vez na resposta da
 * rota. NUNCA é logada nem persistida em claro (regra de ouro 6 / LGPD).
 *
 * Pura e sem dependência de rede/DB de propósito: o teste cobre alfabeto + comprimento +
 * unicidade prática, sem precisar subir o app.
 */
import { randomBytes } from 'node:crypto';

/** Alfabeto sem caracteres ambíguos (idêntico ao _genPortalPassword do gestão). */
export const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Comprimento da senha gerada (idêntico ao gestão). */
export const PASSWORD_LENGTH = 14;

/**
 * Gera uma senha aleatória forte e legível (sem caracteres ambíguos). Usa
 * `crypto.randomBytes` (CSPRNG) — nunca Math.random. Cada byte indexa o alfabeto.
 */
export function genColaboradorPassword(): string {
  const bytes = randomBytes(PASSWORD_LENGTH);
  let out = '';
  for (let i = 0; i < PASSWORD_LENGTH; i++) {
    out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  }
  return out;
}
