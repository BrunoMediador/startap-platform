/**
 * Validacao client-side do draft de servico (tela Servicos).
 *
 * Espelha o servicoSchema do backend (packages/core/schemas/flow-config.ts):
 * nome>=1, duracao inteira > 0 e MULTIPLO DE 5 (a grade da agenda anda em
 * passos de 5min — decisao Bruno 2026-06-11), preco>=0. Erro inline aqui
 * evita bater na API pra tomar 400.
 *
 * ── Validação cruzada serviço↔persona (ADR 0035, §D2/§D6) ────────────────────
 * PUT /portal/servicos pode responder, atrás da flag `SERVICO_VALIDACAO_CRUZADA_ENABLED`
 * (hoje OFF em prod — nada aqui muda o comportamento enquanto ela estiver desligada):
 *   409 { error:'conflito_persona', reason:'preco_duplicado', servico, trecho, mensagem }
 *     -> PERMANENTE. Tentar de novo sem editar nada nunca resolve.
 *   503 { error:'validacao_indisponivel', mensagem }
 *     -> RETRIABLE. O LLM falhou/deu timeout; o dado do dono não foi julgado.
 * Os dois nunca podem virar a mesma mensagem genérica (era o bug antes desta ADR).
 */
import { ApiError } from './api';
import type { Servico } from './api-types';
import { parsePrecoToCents } from './format';

export interface ConflitoPersona {
  servico: string;
  trecho: string;
  mensagem: string;
}

/** Código de erro (body.error) de um ApiError, quando string. */
function errorCode(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const body = err.body;
  if (body && typeof body === 'object' && 'error' in body) {
    const code = (body as { error?: unknown }).error;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * 409 conflito_persona: o preço do serviço já está escrito no texto do assistente.
 * Extrai o corpo estruturado pro front mostrar QUAL serviço e QUAL frase conflitam.
 * `null` se não for esse erro (guard de tipo + shape, nunca confia cegamente no body).
 */
export function isConflitoPersona(err: unknown): ConflitoPersona | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  if (errorCode(err) !== 'conflito_persona') return null;
  // errorCode() já garantiu que err.body é um objeto (senão não haveria 'error' pra ler) —
  // mesmo assim tratamos como unknown, sem confiar cegamente no shape do resto do corpo.
  const body = err.body as Record<string, unknown>;
  const { servico, trecho, mensagem } = body;
  if (typeof servico !== 'string' || typeof trecho !== 'string' || typeof mensagem !== 'string') {
    return null;
  }
  return { servico, trecho, mensagem };
}

/** 503 validacao_indisponivel: o validador falhou/deu timeout — retriable, dado não julgado. */
export function isValidacaoIndisponivel(err: unknown): boolean {
  return (
    err instanceof ApiError && err.status === 503 && errorCode(err) === 'validacao_indisponivel'
  );
}

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
