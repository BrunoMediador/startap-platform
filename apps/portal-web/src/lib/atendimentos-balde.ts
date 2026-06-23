/**
 * Lógica pura do "billing derivado da agenda" (ADR 0027 Fase C). Vive fora do
 * React pra ser testável sem jsdom (convenção do portal: tudo testável é função
 * pura em `lib/*` com `.test.ts`). Cobre:
 *   - rótulos com fallback pros campos nullable (forma / profissional / serviço /
 *     cliente) — NUNCA renderizar null cru (bug de tipo do #344);
 *   - resolução do badge da linha (Editado / Auto / Manual) a partir de
 *     `origem` + `dirty_fields`;
 *   - atualização otimista do cache da lista (patch in-place / remoção);
 *   - validação + montagem do PATCH a partir do rascunho de edição (sticky).
 */
import type {
  AtendimentoBaldeRow,
  AtendimentosListResponse,
  EditarAtendimentoBody,
  FormaPagamento,
} from './api-types';
import { parsePrecoToCents } from './format';

// ── Rótulos com fallback (campos nullable do contrato) ───────────────────────

const FORMA_LABEL: Record<FormaPagamento, string> = {
  dinheiro: 'Dinheiro',
  pix: 'Pix',
  credito: 'Crédito',
  debito: 'Débito',
  pacote: 'Pacote',
  outro: 'Outro',
};

/** Rótulo da forma de pagamento. null/desconhecida -> "Sem forma". */
export function formaPagamentoLabel(forma: FormaPagamento | null): string {
  return forma ? (FORMA_LABEL[forma] ?? 'Sem forma') : 'Sem forma';
}

/** Nome do profissional. null (SOLO / nome apagado) -> "Sem profissional". */
export function profissionalLabel(nome: string | null): string {
  return nome && nome.trim() !== '' ? nome : 'Sem profissional';
}

/** Nome do serviço. null/vazio -> "Sem serviço". */
export function servicoLabel(nome: string | null): string {
  return nome && nome.trim() !== '' ? nome : 'Sem serviço';
}

/** Nome do cliente. null/vazio -> "Sem cliente". */
export function clienteLabel(nome: string | null): string {
  return nome && nome.trim() !== '' ? nome : 'Sem cliente';
}

// ── Badge da linha ───────────────────────────────────────────────────────────

export type RowBadge = 'editado' | 'auto' | 'manual';

/**
 * Resolve o badge da linha. `dirty_fields` não-vazio SEMPRE vence (a edição é o
 * sinal mais relevante pro dono — "eu mexi nisso"). Sem dirty, o badge reflete a
 * origem: 'agenda' -> "Auto" (veio da agenda), 'manual' -> "Manual" (walk-in).
 */
export function rowBadge(row: Pick<AtendimentoBaldeRow, 'origem' | 'dirty_fields'>): RowBadge {
  if (row.dirty_fields.length > 0) return 'editado';
  return row.origem === 'manual' ? 'manual' : 'auto';
}

/** Valor líquido da linha (bruto - desconto), nunca negativo. Em centavos. */
export function valorLiquidoCents(
  row: Pick<AtendimentoBaldeRow, 'valor_cents' | 'desconto_cents'>,
): number {
  return Math.max(0, row.valor_cents - row.desconto_cents);
}

// ── Cache otimista da lista ──────────────────────────────────────────────────

/**
 * Aplica uma linha atualizada no cache da lista (PATCH otimista). Casa por id e
 * recomputa o `total_cents` somando os líquidos (a edição muda o total na hora).
 * Se o id não existir (linha já saiu do balde — ex.: virou passado), devolve a
 * MESMA referência intacta; o refetch reconcilia. Pura/testável.
 */
export function patchRowNaLista(
  prev: AtendimentosListResponse,
  atualizado: AtendimentoBaldeRow,
): AtendimentosListResponse {
  let achou = false;
  const atendimentos = prev.atendimentos.map((r) => {
    if (r.id === atualizado.id) {
      achou = true;
      return atualizado;
    }
    return r;
  });
  if (!achou) return prev;
  return { ...prev, atendimentos, total_cents: somarTotalCents(atendimentos) };
}

/**
 * Remove uma linha do cache da lista por id (DELETE otimista — o atendimento não
 * rolou). Recomputa `total_cents`. Idempotente: remover um id ausente devolve a
 * lista intacta (mesma referência). Pura/testável.
 */
export function removerRowDaLista(
  prev: AtendimentosListResponse,
  id: number,
): AtendimentosListResponse {
  const atendimentos = prev.atendimentos.filter((r) => r.id !== id);
  if (atendimentos.length === prev.atendimentos.length) return prev;
  return { ...prev, atendimentos, total_cents: somarTotalCents(atendimentos) };
}

/** Soma os líquidos da lista (fonte do total exibido após edição otimista). */
export function somarTotalCents(rows: AtendimentoBaldeRow[]): number {
  return rows.reduce((acc, r) => acc + valorLiquidoCents(r), 0);
}

// ── Rascunho de edição da linha (sheet de edição) ────────────────────────────

/**
 * Rascunho editável de uma linha. valor/desconto são STRING (input monetário
 * "40,00"); forma/serviço/cliente são os valores editados. `pacote` zera o valor
 * (igual ao Registrar). Nasce de uma Row via `draftFromRow`.
 */
export interface EditDraft {
  valor: string;
  desconto: string;
  forma: FormaPagamento;
  servicoNome: string;
  clienteNome: string;
}

/** "5000" centavos -> "50,00" (input monetário). */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

/** Monta o rascunho a partir da Row (forma null -> default 'dinheiro' no input). */
export function draftFromRow(row: AtendimentoBaldeRow): EditDraft {
  return {
    valor: centsToInput(row.valor_cents),
    desconto: row.desconto_cents > 0 ? centsToInput(row.desconto_cents) : '',
    forma: row.forma_pagamento ?? 'dinheiro',
    servicoNome: row.servico_nome ?? '',
    clienteNome: row.cliente_nome ?? '',
  };
}

export interface EditFieldErrors {
  valor?: string;
  desconto?: string;
}

export type ValidateEditResult =
  | { ok: true; patch: EditarAtendimentoBody }
  | { ok: false; errors: EditFieldErrors };

const NOME_MAX = 160;

/**
 * Valida o rascunho de edição CONTRA a Row original e monta um PATCH MÍNIMO: só
 * entram no body os campos que de fato MUDARAM (PATCH parcial — backend marca como
 * dirty só o que viajou). Regra do 'pacote': valor vai 0 e o campo não é exigido.
 * Pura/testável.
 */
export function validateEdit(original: AtendimentoBaldeRow, draft: EditDraft): ValidateEditResult {
  const errors: EditFieldErrors = {};
  const isPacote = draft.forma === 'pacote';

  let valorCents = 0;
  if (isPacote) {
    valorCents = 0;
  } else {
    const parsed = parsePrecoToCents(draft.valor);
    if (parsed === null) errors.valor = 'Informe o valor.';
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

  if (errors.valor || errors.desconto) return { ok: false, errors };

  const patch: EditarAtendimentoBody = {};
  if (valorCents !== original.valor_cents) patch.valor_cents = valorCents;
  if (descontoCents !== original.desconto_cents) patch.desconto_cents = descontoCents;
  if (draft.forma !== original.forma_pagamento) patch.forma_pagamento = draft.forma;

  const servico = draft.servicoNome.trim().slice(0, NOME_MAX);
  if (servico !== (original.servico_nome ?? '')) patch.servico_nome = servico;

  const cliente = draft.clienteNome.trim().slice(0, NOME_MAX);
  if (cliente !== (original.cliente_nome ?? '')) patch.cliente_nome = cliente;

  return { ok: true, patch };
}

/** True quando o PATCH não tem nenhum campo (nada mudou) — trava o botão "Salvar". */
export function patchVazio(patch: EditarAtendimentoBody): boolean {
  return Object.keys(patch).length === 0;
}
