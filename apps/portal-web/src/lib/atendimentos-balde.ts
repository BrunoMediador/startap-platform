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
  Colaborador,
  ComissaoPorProfissional,
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

/**
 * Título proeminente de uma linha do billing. No ESTABELECIMENTO o destaque é o
 * VENDEDOR (profissional que atendeu — pedido do Bruno); no individual/SOLO
 * (profissional_nome=null) o destaque continua o cliente, senão toda linha viraria
 * "Sem profissional". Pura/testável.
 */
export function tituloLinhaAtendimento(
  row: Pick<AtendimentoBaldeRow, 'cliente_nome' | 'profissional_nome'>,
  mostrarVendedor: boolean,
): string {
  return mostrarVendedor
    ? profissionalLabel(row.profissional_nome)
    : clienteLabel(row.cliente_nome);
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

// ── Agregações pro gráfico do Billing (3 visões) ─────────────────────────────
//
// Tudo PURO/testável. Soma SEMPRE o líquido (valorLiquidoCents) pra bater com o
// total exibido na lista (somarTotalCents). NUNCA derivar o dia de `inicio_at`
// (UTC) — a coluna `data` já vem em America/Sao_Paulo do backend (ADR 0027, bug
// de data). Agrupar/ordenar por ela.

export interface AggBucket {
  /** Chave estável do balde (data 'YYYY-MM-DD', id do profissional, forma). */
  chave: string;
  /** Rótulo legível pra UI. */
  rotulo: string;
  /** Soma do líquido em centavos. */
  total_cents: number;
  /** Quantidade de linhas no balde. */
  count: number;
}

/**
 * Faturamento por DIA. Agrupa por `row.data` (YYYY-MM-DD, já em BR), ordenado
 * cronologicamente. O rótulo fica a cargo da UI (formatAgendamentoDia) — aqui a
 * chave é a própria data pra ordenação determinística.
 */
export function agruparPorDia(rows: AtendimentoBaldeRow[]): AggBucket[] {
  const mapa = new Map<string, AggBucket>();
  for (const r of rows) {
    const chave = r.data;
    const atual = mapa.get(chave) ?? { chave, rotulo: chave, total_cents: 0, count: 0 };
    atual.total_cents += valorLiquidoCents(r);
    atual.count += 1;
    mapa.set(chave, atual);
  }
  return [...mapa.values()].sort((a, b) => a.chave.localeCompare(b.chave));
}

/**
 * Faturamento por PROFISSIONAL. Agrupa por `colaborador_id` (estável; null = SOLO/
 * sem profissional, num balde único). Rótulo = `profissional_nome` com fallback.
 * Ordena por total desc (o maior aparece primeiro nas barras).
 */
export function agruparPorProfissional(rows: AtendimentoBaldeRow[]): AggBucket[] {
  const mapa = new Map<string, AggBucket>();
  for (const r of rows) {
    const chave = r.colaborador_id != null ? String(r.colaborador_id) : '__sem__';
    const atual = mapa.get(chave) ?? {
      chave,
      rotulo: profissionalLabel(r.profissional_nome),
      total_cents: 0,
      count: 0,
    };
    atual.total_cents += valorLiquidoCents(r);
    atual.count += 1;
    mapa.set(chave, atual);
  }
  return [...mapa.values()].sort((a, b) => b.total_cents - a.total_cents);
}

/**
 * Faturamento por FORMA DE PAGAMENTO. Agrupa por `forma_pagamento` (null = "Sem
 * forma" num balde próprio). Rótulo = formaPagamentoLabel. Ordena por total desc.
 */
export function agruparPorForma(rows: AtendimentoBaldeRow[]): AggBucket[] {
  const mapa = new Map<string, AggBucket>();
  for (const r of rows) {
    const chave = r.forma_pagamento ?? '__sem__';
    const atual = mapa.get(chave) ?? {
      chave,
      rotulo: formaPagamentoLabel(r.forma_pagamento),
      total_cents: 0,
      count: 0,
    };
    atual.total_cents += valorLiquidoCents(r);
    atual.count += 1;
    mapa.set(chave, atual);
  }
  return [...mapa.values()].sort((a, b) => b.total_cents - a.total_cents);
}

// ── Filtros client-side do Billing (cliente / colaborador / serviço) ─────────
//
// Os campos (`cliente_nome`, `colaborador_id`/`profissional_nome`, `servico_nome`)
// JÁ chegam por linha → filtra-se 100% no cliente, sem novo fetch. Helpers PUROS
// (testáveis sem React). O total é recomputado via somarTotalCents pelo chamador.

export interface BillingFiltro {
  /** Texto livre case-insensitive sobre cliente_nome ('' = sem filtro). */
  cliente: string;
  /** id do colaborador (null = todos). */
  colaboradorId: number | null;
  /** nome exato do serviço ('' = todos). */
  servico: string;
}

export const FILTRO_VAZIO: BillingFiltro = { cliente: '', colaboradorId: null, servico: '' };

/** Algum filtro ativo? (controla "Limpar filtros" + recomputo de total). */
export function temFiltroAtivo(f: BillingFiltro): boolean {
  return f.cliente.trim() !== '' || f.colaboradorId !== null || f.servico !== '';
}

/**
 * Aplica os filtros sobre o array de atendimentos (AND entre os filtros ativos).
 * Cliente = `includes` case-insensitive; colaborador = igualdade de id; serviço =
 * igualdade exata de nome. Pura/testável.
 */
export function filtrarAtendimentos(
  rows: AtendimentoBaldeRow[],
  f: BillingFiltro,
): AtendimentoBaldeRow[] {
  const clienteBusca = f.cliente.trim().toLowerCase();
  return rows.filter((r) => {
    if (clienteBusca !== '') {
      const nome = (r.cliente_nome ?? '').toLowerCase();
      if (!nome.includes(clienteBusca)) return false;
    }
    if (f.colaboradorId !== null && r.colaborador_id !== f.colaboradorId) return false;
    if (f.servico !== '' && (r.servico_nome ?? '') !== f.servico) return false;
    return true;
  });
}

// ── Comissão recomputada CLIENT-SIDE (sob filtro) ────────────────────────────
//
// Quando há filtro ativo no Billing, o relatório de comissão do backend (que olha o
// período inteiro) não bate mais — recomputamos do MESMO array filtrado. Regra
// (invariante 3): comissão é LIVE-COMPUTE = líquido × pct do colaborador, NUNCA
// materializada. "Lista TODOS os profissionais ativos" mesmo sem booking (delta 0)
// quando NÃO se filtra por colaborador específico. Pura/testável.

export interface ComissaoComputeResult {
  total_cents: number;
  por_profissional: ComissaoPorProfissional[];
}

/**
 * Recomputa a comissão a partir das linhas (já filtradas) + os colaboradores ATIVOS
 * (pra listar quem não teve booking com 0). Só conta linhas com colaborador_id (SOLO
 * não tem comissão). `forma_pagamento='pacote'` já entra com líquido 0 (valor 0).
 *
 * `colaboradoresAtivos`: usados pra incluir profissionais sem atendimento no período
 *   (linha com bruto/comissão 0). Passe [] (ou só o filtrado) quando há filtro de
 *   colaborador — aí só o(s) presente(s) aparece(m).
 */
export function computeComissaoFromRows(
  rows: AtendimentoBaldeRow[],
  colaboradoresAtivos: Pick<Colaborador, 'id' | 'nome' | 'comissao_pct'>[],
): ComissaoComputeResult {
  // Base: bruto líquido somado por colaborador presente nas linhas.
  const brutoPorColab = new Map<number, { bruto: number; nome: string | null; count: number }>();
  for (const r of rows) {
    if (r.colaborador_id == null) continue;
    const atual = brutoPorColab.get(r.colaborador_id) ?? {
      bruto: 0,
      nome: r.profissional_nome,
      count: 0,
    };
    atual.bruto += valorLiquidoCents(r);
    atual.count += 1;
    if (atual.nome == null) atual.nome = r.profissional_nome;
    brutoPorColab.set(r.colaborador_id, atual);
  }

  // pct + nome canônicos vêm da Equipe (fonte da verdade da % e do nome ativo).
  const pctPorColab = new Map<number, { pct: number; nome: string }>();
  for (const c of colaboradoresAtivos) pctPorColab.set(c.id, { pct: c.comissao_pct, nome: c.nome });

  // União: todos os colaboradores ativos + os que aparecem nas linhas (defesa).
  const ids = new Set<number>([...pctPorColab.keys(), ...brutoPorColab.keys()]);

  const por_profissional: ComissaoPorProfissional[] = [];
  let total = 0;
  for (const id of ids) {
    const base = brutoPorColab.get(id);
    const info = pctPorColab.get(id);
    const pct = info?.pct ?? null;
    const bruto = base?.bruto ?? 0;
    const comissao = pct != null && pct > 0 ? Math.round((bruto * pct) / 100) : 0;
    total += comissao;
    por_profissional.push({
      colaborador_id: id,
      profissional_nome: info?.nome ?? base?.nome ?? null,
      total_bruto_cents: bruto,
      comissao_pct: pct,
      comissao_cents: comissao,
      count: base?.count ?? 0,
    });
  }
  // Ordena por comissão desc (maior primeiro), igual ao relatório.
  por_profissional.sort((a, b) => b.comissao_cents - a.comissao_cents);
  return { total_cents: total, por_profissional };
}
