/**
 * Validação + normalização do formulário "Registrar atendimento" (app de gestão,
 * Fase 1). Espelha as regras do backend (POST /portal/atendimentos): valor_cents
 * obrigatório e > 0 (salvo forma 'pacote', que ZERA o valor), desconto opcional
 * não-negativo e não maior que o valor, data 'YYYY-MM-DD'. Dá erro inline ANTES de
 * bater na API. Testável sem React (vive aqui, fora da página).
 *
 * O form guarda valor/desconto como STRING editável (input monetário "50,00"); a
 * validação converte pra centavos via parsePrecoToCents. `forma === 'pacote'` é o
 * caso especial: o atendimento é coberto pelo pacote, então o valor vai 0 (o
 * backend faz o mesmo — a UI só antecipa, travando o campo).
 */
import type { CriarAtendimentoBody, FormaPagamento } from './api-types';
import { parsePrecoToCents } from './format';

export const FORMAS_PAGAMENTO: { value: FormaPagamento; label: string }[] = [
  { value: 'dinheiro', label: 'Dinheiro' },
  { value: 'pix', label: 'Pix' },
  { value: 'credito', label: 'Crédito' },
  { value: 'debito', label: 'Débito' },
  { value: 'pacote', label: 'Pacote' },
  { value: 'outro', label: 'Outro' },
];

export interface Draft {
  /** Valor bruto como texto editável ("50,00"). Ignorado quando forma='pacote'. */
  valor: string;
  /** Desconto como texto editável (opcional). */
  desconto: string;
  servicoNome: string;
  forma: FormaPagamento;
  /** id do colaborador escolhido (estabelecimento) ou null (SOLO). */
  colaboradorId: number | null;
  clienteNome: string;
  /** Data do atendimento 'YYYY-MM-DD'. */
  data: string;
}

export interface FieldErrors {
  valor?: string;
  desconto?: string;
  data?: string;
}

const NOME_MAX = 160;
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

export function emptyDraft(data: string): Draft {
  return {
    valor: '',
    desconto: '',
    servicoNome: '',
    forma: 'dinheiro',
    colaboradorId: null,
    clienteNome: '',
    data,
  };
}

export type ValidateResult =
  | { ok: true; value: CriarAtendimentoBody }
  | { ok: false; errors: FieldErrors };

/**
 * Valida o draft e monta o body do POST. Regra do 'pacote': valor vai 0 e o campo
 * de valor não é exigido (o backend zera mesmo). Campos vazios viram ausência no
 * body (não manda string vazia — o backend trata ausência como "não informado").
 */
export function validate(draft: Draft): ValidateResult {
  const errors: FieldErrors = {};
  const isPacote = draft.forma === 'pacote';

  let valorCents = 0;
  if (!isPacote) {
    const parsed = parsePrecoToCents(draft.valor);
    if (parsed === null) errors.valor = 'Informe o valor do atendimento.';
    else if (parsed <= 0) errors.valor = 'O valor precisa ser maior que zero.';
    else valorCents = parsed;
  }

  let descontoCents = 0;
  const descTrim = draft.desconto.trim();
  if (descTrim !== '') {
    const parsedDesc = parsePrecoToCents(descTrim);
    if (parsedDesc === null) errors.desconto = 'Desconto inválido.';
    else if (!isPacote && parsedDesc > valorCents)
      errors.desconto = 'O desconto não pode ser maior que o valor.';
    else descontoCents = parsedDesc;
  }

  if (!DATA_RE.test(draft.data)) errors.data = 'Data inválida.';

  if (errors.valor || errors.desconto || errors.data) return { ok: false, errors };

  const body: CriarAtendimentoBody = {
    valor_cents: isPacote ? 0 : valorCents,
    forma_pagamento: draft.forma,
    data: draft.data,
  };
  const servico = draft.servicoNome.trim().slice(0, NOME_MAX);
  if (servico) body.servico_nome = servico;
  if (descontoCents > 0) body.desconto_cents = descontoCents;
  // Number(...) defensivo: o id do colaborador nasce de uma coluna BIGSERIAL que
  // o driver pg serializa como string. O boundary (mapColaboradorRow) já converte,
  // mas garantir aqui evita um POST com string -> 400 do backend (Zod number).
  if (draft.colaboradorId !== null) body.colaborador_id = Number(draft.colaboradorId);
  const cliente = draft.clienteNome.trim().slice(0, NOME_MAX);
  if (cliente) body.cliente_nome = cliente;

  return { ok: true, value: body };
}
