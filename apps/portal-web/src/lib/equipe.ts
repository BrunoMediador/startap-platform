/**
 * Validação + normalização do formulário de Equipe (colaboradores), no cliente.
 * Espelha as regras do backend (cloneColaboradores em @startap/db): nome 1..160,
 * serviços trim + dedup case-insensitive (<=80 chars/item, <=50 itens). Dar erro
 * inline ANTES de bater na API. Testável sem React (vive aqui, fora da página).
 *
 * Os serviços são digitados como texto separado por vírgula no form (UX simples
 * pro dono); parseServicos vira o array que o backend espera.
 */
import type { Colaborador } from './api-types';

export interface Draft {
  nome: string;
  /** Serviços como texto separado por vírgula (ex.: "Corte, Barba"). */
  servicos: string;
  ativo: boolean;
}

export interface FieldErrors {
  nome?: string;
}

const NOME_MAX = 160;
const SERVICO_MAX = 80;
const SERVICOS_MAX = 50;

/** Texto "Corte, Barba ,corte" -> ['Corte','Barba'] (trim + dedup case-insensitive). */
export function parseServicos(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const s = part.trim().slice(0, SERVICO_MAX);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= SERVICOS_MAX) break;
  }
  return out;
}

/** Array de serviços -> texto pro input ("Corte, Barba"). */
export function servicosToText(servicos: string[]): string {
  return servicos.join(', ');
}

/** Colaborador (da API) -> Draft pra editar no form. */
export function toDraft(c: Colaborador): Draft {
  return { nome: c.nome, servicos: servicosToText(c.servicos), ativo: c.ativo };
}

export type ValidateResult =
  | { ok: true; value: { nome: string; servicos: string[]; ativo: boolean } }
  | { ok: false; errors: FieldErrors };

/** Valida o draft. Só `nome` tem erro bloqueante (serviços normalizam sozinhos). */
export function validate(draft: Draft): ValidateResult {
  const errors: FieldErrors = {};
  const nome = draft.nome.trim();
  if (!nome) errors.nome = 'Informe o nome do profissional.';
  else if (nome.length > NOME_MAX) errors.nome = `Nome muito longo (máx. ${NOME_MAX}).`;

  if (errors.nome) return { ok: false, errors };
  return {
    ok: true,
    value: {
      nome: nome.slice(0, NOME_MAX),
      servicos: parseServicos(draft.servicos),
      ativo: draft.ativo,
    },
  };
}
