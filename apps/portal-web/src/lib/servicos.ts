/**
 * Validacao client-side do draft de servico (tela Servicos).
 *
 * Espelha o servicoSchema do backend (packages/core/schemas/flow-config.ts):
 * nome>=1, duracao inteira > 0 e MULTIPLO DE 5 (a grade da agenda anda em
 * passos de 5min — decisao Bruno 2026-06-11), preco>=0. Erro inline aqui
 * evita bater na API pra tomar 400.
 */
import type { Servico } from './api-types';
import { parsePrecoToCents } from './format';

export interface Draft {
  nome: string;
  duracao: string;
  preco: string;
}

export interface FieldErrors {
  nome?: string;
  duracao?: string;
  preco?: string;
}

export function toDraft(s: Servico): Draft {
  return {
    nome: s.nome,
    duracao: String(s.duracao_min),
    preco: (s.preco_cents / 100).toFixed(2).replace('.', ','),
  };
}

export function validate(
  d: Draft,
): { ok: true; value: Servico } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const nome = d.nome.trim();
  if (nome.length === 0) errors.nome = 'Informe um nome para o serviço';
  const duracao = Number(d.duracao);
  if (!Number.isInteger(duracao) || duracao <= 0) {
    errors.duracao = 'Duração deve ser maior que zero';
  } else if (duracao % 5 !== 0) {
    errors.duracao = 'Use múltiplos de 5 min (5, 10, 15…)';
  }
  const cents = parsePrecoToCents(d.preco);
  if (cents === null) errors.preco = 'Informe o preço';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { nome, duracao_min: duracao, preco_cents: cents as number } };
}
