/**
 * atendimentos — FONTE DA VERDADE do financeiro do NEGÓCIO do cliente
 * (faturamento + comissão). ADR 0026, Fase 1 (MVP atrás de flag).
 *
 * REGRA DE OURO DE DOMÍNIO (ADR 0026 §2): isto é o faturamento DELE (o negócio do
 * cliente). NUNCA misturar com client_billing/AbacatePay (a mensalidade B2B que ele
 * paga PRA NÓS). Nenhuma query aqui toca client_billing/billing_charges.
 *
 * ISOLAMENTO (regra de ouro 5, ADR 0018): toda escrita carimba slot + tenant_id; toda
 * leitura filtra por slot E tenant_id. O slot vem SEMPRE da sessão (withTenant no
 * portal) — nunca de input do cliente. O tenant_id é resolvido do clone (getScopeBySlot),
 * nunca de campo livre. Anti-IDOR: colaborador_id é validado pertencer ao slot antes do
 * INSERT (belongsToSlot).
 *
 * CUIDADO com o bug do $1 (ADR 0018, postmortem 2026-06-14): nenhum placeholder é
 * reusado entre contextos de tipo distintos. Aqui não há dual-write subselect — o
 * tenant_id já chega resolvido como parâmetro próprio.
 */
import { pool, query } from '../client.js';

/** Status do atendimento (validado no app; sem CHECK no banco). */
export type AtendimentoStatus = 'agendado' | 'realizado' | 'cancelado';

/** Linha de atendimento devolvida ao caller. */
export interface AtendimentoRow {
  id: number;
  slot: string;
  gcal_event_id: string | null;
  cliente_nome: string | null;
  cliente_contato: string | null;
  servico_nome: string | null;
  valor_cents: number;
  desconto_cents: number;
  forma_pagamento: string | null;
  colaborador_id: number | null;
  comissao_pct: string | null;
  comissao_cents: number;
  status: string;
  data: string;
  created_at: string;
  updated_at: string;
  // ── ADR 0027 (billing derivado da agenda) ──────────────────────────────────
  /** 'agenda' = derivado de evento do GCal | 'manual' = walk-in registrado no painel. */
  origem: string;
  /** Colunas pinadas por edição manual (sticky). upsert do evento NÃO as sobrescreve. */
  dirty_fields: string[];
  /** Início do evento (ISO). NULL = walk-in sem janela de tempo. */
  inicio_at: string | null;
  /** Fim do evento (ISO). Split previsão×faturado é stateless por fim_at vs now(). */
  fim_at: string | null;
  /** Soft-delete: preenchido = some de TODO relatório. Normalmente null nas leituras. */
  deleted_at: string | null;
}

/** Input do registro de atendimento. slot/tenantId vêm do CALLER (sessão/clone). */
export interface CreateAtendimentoInput {
  slot: string;
  /** tenant_id resolvido do clone pelo CALLER (getScopeBySlot). NOT NULL na tabela. */
  tenantId: string;
  servicoNome?: string | null;
  valorCents: number;
  descontoCents?: number;
  /** NULL = SOLO (individual sem profissional) -> sem split de comissão. */
  colaboradorId?: number | null;
  formaPagamento?: string | null;
  clienteNome?: string | null;
  clienteContato?: string | null;
  gcalEventId?: string | null;
  /** Dia do atendimento (YYYY-MM-DD). Ausente -> hoje (default do banco). */
  data?: string | null;
}

/**
 * Calcula a comissão sobre o valor BRUTO líquido de desconto (ADR 0026 §3): comissão =
 * round((valor - desconto) * pct/100), em centavos inteiros, nunca negativa.
 *
 * SOLO (pct null/<=0) -> 0. Esta função é PURA e testável isoladamente (a regra de
 * negócio do dinheiro vive aqui, não na rota).
 */
export function calcComissaoCents(
  valorCents: number,
  descontoCents: number,
  comissaoPct: number | null,
): number {
  if (comissaoPct == null || comissaoPct <= 0) return 0;
  const base = Math.max(0, valorCents - descontoCents);
  return Math.max(0, Math.round((base * comissaoPct) / 100));
}

/**
 * Lê o comissao_pct CORRENTE de um colaborador, SE ele pertence a este slot.
 * Retorna null quando o colaborador não é do slot (anti-IDOR) OU não existe.
 * O caller distingue "não pertence" pelo segundo elemento (belongs=false -> 409/400).
 */
export async function getColaboradorComissao(
  slot: string,
  colaboradorId: number,
): Promise<{ belongs: boolean; comissaoPct: number | null }> {
  const r = await query<{ comissao_pct: string | null }>(
    'SELECT comissao_pct FROM clone_colaboradores WHERE slot = $1 AND id = $2 LIMIT 1',
    [slot, colaboradorId],
  );
  const row = r.rows[0];
  if (!row) return { belongs: false, comissaoPct: null };
  return { belongs: true, comissaoPct: row.comissao_pct == null ? null : Number(row.comissao_pct) };
}

/**
 * Registra/conclui um atendimento. Aplica as regras do ADR 0026:
 *  - PACOTE: forma_pagamento='pacote' -> valor_cents=0 (receita já entrou na venda do
 *    pacote; não contar 2×). desconto também zera nesse caso (não há o que descontar).
 *  - SOLO: colaboradorId null -> comissao_pct/comissao_cents = NULL/0.
 *  - EMPRESA: colaboradorId setado + comissao_pct>0 -> congela snapshot de pct + cents.
 *
 * status nasce 'realizado'. slot + tenant_id são carimbados (nunca de input livre).
 * O caller (rota) já validou que colaboradorId pertence ao slot (anti-IDOR).
 */
export async function createAtendimento(input: CreateAtendimentoInput): Promise<AtendimentoRow> {
  const isPacote = input.formaPagamento === 'pacote';

  // PACOTE -> não contar receita 2× (ADR 0026 §risco 1).
  const valorCents = isPacote ? 0 : Math.max(0, Math.trunc(input.valorCents));
  const descontoCents = isPacote ? 0 : Math.max(0, Math.trunc(input.descontoCents ?? 0));

  const colaboradorId = input.colaboradorId == null ? null : Math.trunc(input.colaboradorId);

  // Comissão: só quando há profissional E comissao_pct corrente > 0. SOLO -> snapshot NULL/0.
  let comissaoPct: number | null = null;
  let comissaoCents = 0;
  if (colaboradorId != null) {
    const { comissaoPct: pct } = await getColaboradorComissao(input.slot, colaboradorId);
    if (pct != null && pct > 0) {
      comissaoPct = pct;
      comissaoCents = calcComissaoCents(valorCents, descontoCents, pct);
    }
  }

  const r = await query<AtendimentoRow>(
    `INSERT INTO atendimentos
       (slot, tenant_id, gcal_event_id, cliente_nome, cliente_contato, servico_nome,
        valor_cents, desconto_cents, forma_pagamento, colaborador_id,
        comissao_pct, comissao_cents, status, data)
     VALUES
       ($1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, 'realizado', COALESCE($13::date, now()::date))
     RETURNING id, slot, gcal_event_id, cliente_nome, cliente_contato, servico_nome,
               valor_cents, desconto_cents, forma_pagamento, colaborador_id,
               comissao_pct, comissao_cents, status, data, created_at, updated_at,
               origem, dirty_fields, inicio_at, fim_at, deleted_at`,
    [
      input.slot,
      input.tenantId,
      input.gcalEventId ?? null,
      input.clienteNome ?? null,
      input.clienteContato ?? null,
      input.servicoNome ?? null,
      valorCents,
      descontoCents,
      input.formaPagamento ?? null,
      colaboradorId,
      comissaoPct,
      comissaoCents,
      input.data ?? null,
    ],
  );
  return r.rows[0] as AtendimentoRow;
}

// ── Relatórios ─────────────────────────────────────────────────────────────────────
// Escopo SEMPRE slot + tenant_id. Período inclusivo [de, ate]. Faturamento = SUM(valor -
// desconto). ADR 0027: relatórios contam SÓ linhas FATURADAS (passado) e NÃO deletadas.
//
// FATURADO (predicado canônico — alinhado com listAtendimentos balde='faturado'):
//   deleted_at IS NULL AND status <> 'cancelado' AND (fim_at <= now() OR origem='manual')
// → walk-in do MVP (origem='manual', status='realizado') segue contando (compat). Agenda
//   derivada vira faturamento só depois de fim_at passar. PREVISÃO (futuro) nunca soma.
// O fragmento abaixo é reusado SEM placeholders extras (só colunas + now()) — seguro.
const _FATURADO_SQL =
  "deleted_at IS NULL AND status <> 'cancelado' AND (fim_at <= now() OR origem = 'manual')";
// Versão prefixada com alias `a.` para as queries que usam JOIN.
const _FATURADO_SQL_A =
  "a.deleted_at IS NULL AND a.status <> 'cancelado' AND (a.fim_at <= now() OR a.origem = 'manual')";

export interface FaturamentoPorFormaRow {
  forma_pagamento: string | null;
  total_cents: number;
  count: number;
}

export interface FaturamentoPorProfissionalRow {
  colaborador_id: number | null;
  profissional_nome: string | null;
  total_cents: number;
  count: number;
}

export interface FaturamentoReport {
  de: string;
  ate: string;
  /** total FATURADO (passado, líquido de desconto). Mantém o contrato existente. */
  total_cents: number;
  count: number;
  ticket_medio_cents: number;
  /** total PREVISTO (futuro/aberto, ADR 0027): aditivo — front pode exibir lado a lado. */
  previsto_total_cents: number;
  por_forma_pagamento: FaturamentoPorFormaRow[];
  por_profissional: FaturamentoPorProfissionalRow[];
}

/**
 * Relatório de FATURAMENTO de um período: total, por forma de pagamento, por
 * profissional (com nome), ticket médio e contagem. Só linhas FATURADAS (passado) e NÃO
 * deletadas (ADR 0027 — previsão/futuro não soma). Escopo slot + tenant_id (defesa em
 * profundidade RLS). Período inclusivo.
 */
export async function getFaturamento(
  slot: string,
  tenantId: string,
  de: string,
  ate: string,
): Promise<FaturamentoReport> {
  const params = [slot, tenantId, de, ate];

  const totalQ = await query<{ total_cents: string | null; count: string }>(
    `SELECT COALESCE(SUM(valor_cents - desconto_cents), 0)::bigint AS total_cents,
            COUNT(*)::bigint AS count
       FROM atendimentos
      WHERE slot = $1 AND tenant_id = $2 AND ${_FATURADO_SQL}
        AND data >= $3 AND data <= $4`,
    params,
  );

  const formaQ = await query<{
    forma_pagamento: string | null;
    total_cents: string;
    count: string;
  }>(
    `SELECT forma_pagamento,
            COALESCE(SUM(valor_cents - desconto_cents), 0)::bigint AS total_cents,
            COUNT(*)::bigint AS count
       FROM atendimentos
      WHERE slot = $1 AND tenant_id = $2 AND ${_FATURADO_SQL}
        AND data >= $3 AND data <= $4
      GROUP BY forma_pagamento
      ORDER BY total_cents DESC`,
    params,
  );

  const profQ = await query<{
    colaborador_id: number | null;
    profissional_nome: string | null;
    total_cents: string;
    count: string;
  }>(
    `SELECT a.colaborador_id,
            c.nome AS profissional_nome,
            COALESCE(SUM(a.valor_cents - a.desconto_cents), 0)::bigint AS total_cents,
            COUNT(*)::bigint AS count
       FROM atendimentos a
       LEFT JOIN clone_colaboradores c
         ON c.id = a.colaborador_id AND c.slot = a.slot
      WHERE a.slot = $1 AND a.tenant_id = $2 AND ${_FATURADO_SQL_A}
        AND a.data >= $3 AND a.data <= $4
      GROUP BY a.colaborador_id, c.nome
      ORDER BY total_cents DESC`,
    params,
  );

  // PREVISTO (futuro/aberto): mesmo predicado do balde='previsao'. Aditivo, não altera total.
  const previstoQ = await query<{ total_cents: string | null }>(
    `SELECT COALESCE(SUM(valor_cents - desconto_cents), 0)::bigint AS total_cents
       FROM atendimentos
      WHERE slot = $1 AND tenant_id = $2
        AND deleted_at IS NULL AND status <> 'cancelado' AND fim_at > now()
        AND data >= $3 AND data <= $4`,
    params,
  );

  const total = Number(totalQ.rows[0]?.total_cents ?? 0);
  const count = Number(totalQ.rows[0]?.count ?? 0);

  return {
    de,
    ate,
    total_cents: total,
    count,
    ticket_medio_cents: count > 0 ? Math.round(total / count) : 0,
    previsto_total_cents: Number(previstoQ.rows[0]?.total_cents ?? 0),
    por_forma_pagamento: formaQ.rows.map((r) => ({
      forma_pagamento: r.forma_pagamento,
      total_cents: Number(r.total_cents),
      count: Number(r.count),
    })),
    por_profissional: profQ.rows.map((r) => ({
      colaborador_id: r.colaborador_id == null ? null : Number(r.colaborador_id),
      profissional_nome: r.profissional_nome,
      total_cents: Number(r.total_cents),
      count: Number(r.count),
    })),
  };
}

export interface ComissaoPorProfissionalRow {
  colaborador_id: number;
  profissional_nome: string | null;
  /** Base BRUTA (SUM(valor - desconto)) das linhas do balde — denominador da comissão. */
  total_bruto_cents: number;
  /** % aplicado: FATURADO usa o snapshot (já congelado); PREVISÃO usa o pct CORRENTE do colaborador. */
  comissao_pct: number;
  /** FATURADO = SUM(comissao_cents congelado); PREVISÃO = round(bruto * pct/100) projetado. */
  comissao_cents: number;
  count: number;
}

export interface ComissaoReport {
  de: string;
  ate: string;
  /** Balde do relatório: 'faturado' (realizado) ou 'previsao' (agendamentos futuros). */
  balde: Balde;
  total_cents: number;
  por_profissional: ComissaoPorProfissionalRow[];
}

/**
 * Relatório de COMISSÃO por profissional num período. DOIS BALDES (ADR 0027):
 *
 *  - 'faturado' (DEFAULT — comportamento histórico inalterado nos valores): comissão sobre
 *    o REALIZADO. Soma o comissao_cents CONGELADO (snapshot da venda) sobre o predicado
 *    canônico de faturado (deleted_at NULL, status<>'cancelado', fim_at<=now() OU
 *    origem='manual').
 *
 *  - 'previsao': comissão PROJETADA dos agendamentos futuros (deleted_at NULL,
 *    status='agendado', fim_at>now()). As linhas de previsão têm comissao_cents=0 congelado
 *    (o snapshot só acontece ao virar faturado), então a comissão é CALCULADA: para cada
 *    linha, round(GREATEST(valor-desconto,0) * pct/100) com o pct CORRENTE do colaborador
 *    (clone_colaboradores.comissao_pct) — MESMA regra do calcComissaoCents, agregada em SQL.
 *
 * TODOS OS ATIVOS APARECEM: a query PARTE de clone_colaboradores (ativo = TRUE) com LEFT
 * JOIN em atendimentos. Assim, TODO colaborador ativo do clone entra em por_profissional —
 * com seu comissao_pct corrente e total_bruto/comissão 0 quando NÃO tem atendimento no
 * balde/período. Antes a query partia de atendimentos (GROUP BY), então só quem TINHA
 * booking aparecia — o que confundia o dono (setava % num barbeiro sem booking e ele sumia).
 *
 *  - Colaborador ATIVO sem atendimento -> total_bruto_cents=0, comissao_cents=0, mas com o
 *    comissao_pct dele exposto (informativo). count=0.
 *  - Colaborador INATIVO/removido -> NÃO aparece (filtro ativo = TRUE).
 *  - SOLO/individual -> clone_colaboradores tem 0 linhas -> por_profissional vazio (gating de
 *    comissão preservado). Atendimentos SOLO têm colaborador_id NULL e nunca casam o JOIN.
 *  - total_cents (soma das comissões) NÃO muda: linhas zeradas somam 0.
 *
 * comissao_pct exposto:
 *  - previsao: o pct CORRENTE do colaborador (uniforme por profissional, sempre presente).
 *  - faturado: pct médio efetivo (comissao/bruto*100) quando há base; SEM base usa o pct
 *    corrente do colaborador (cc.comissao_pct) — assim o zerado mostra o % configurado, não 0.
 *
 * Escopo: slot do colaborador + tenant_id do atendimento no ON do JOIN (defesa em
 * profundidade RLS). Período inclusivo por `data`. Ordenação ESTÁVEL: comissão desc, com os
 * zerados no fim, desempate por nome e id (determinístico).
 */
export async function getComissao(
  slot: string,
  tenantId: string,
  de: string,
  ate: string,
  balde: Balde = 'faturado',
): Promise<ComissaoReport> {
  // Predicado do balde dentro do ON do LEFT JOIN — preserva colaboradores SEM atendimento
  // (filtrar no ON, não no WHERE, é o que mantém a linha zerada). faturado: snapshot
  // congelado; previsao: projeção sobre o pct corrente.
  const baldeCond =
    balde === 'previsao' ? "a.status = 'agendado' AND a.fim_at > now()" : _FATURADO_SQL_A;

  // comissao_cents:
  //  - faturado: SUM do snapshot congelado (a.comissao_cents).
  //  - previsao: SUM por linha de round(GREATEST(valor-desconto,0) * pct corrente / 100),
  //    com COALESCE(cc.comissao_pct,0) — colaborador sem pct -> projeta 0 (mas aparece).
  // comissao_pct exposto (cc = clone_colaboradores, sempre presente pois é a tabela base):
  //  - previsao: o pct corrente do colaborador.
  //  - faturado: pct médio efetivo SE há base; sem base -> o pct corrente do colaborador (o
  //    zerado mostra o % configurado, não 0 — é o ponto desta mudança).
  const comissaoExpr =
    balde === 'previsao'
      ? 'COALESCE(SUM(ROUND(GREATEST(a.valor_cents - a.desconto_cents, 0) * COALESCE(cc.comissao_pct, 0) / 100.0)), 0)::bigint'
      : 'COALESCE(SUM(a.comissao_cents), 0)::bigint';
  const pctExpr =
    balde === 'previsao'
      ? 'COALESCE(cc.comissao_pct, 0)::numeric'
      : `CASE WHEN COALESCE(SUM(a.valor_cents - a.desconto_cents), 0) > 0
              THEN ROUND(COALESCE(SUM(a.comissao_cents), 0)::numeric
                         / SUM(a.valor_cents - a.desconto_cents)::numeric * 100, 2)
              ELSE COALESCE(cc.comissao_pct, 0) END`;

  // PARTE de clone_colaboradores (ativos do slot) -> LEFT JOIN atendimentos com TODOS os
  // filtros (tenant, período, balde, deleted) no ON, para preservar o zerado. GROUP BY pelas
  // colunas do colaborador (cc.comissao_pct entra no GROUP BY: é um valor por colaborador).
  const r = await query<{
    colaborador_id: number;
    profissional_nome: string | null;
    total_bruto_cents: string;
    comissao_pct: string;
    comissao_cents: string;
    count: string;
  }>(
    `SELECT cc.id AS colaborador_id,
            cc.nome AS profissional_nome,
            COALESCE(SUM(a.valor_cents - a.desconto_cents), 0)::bigint AS total_bruto_cents,
            ${pctExpr} AS comissao_pct,
            ${comissaoExpr} AS comissao_cents,
            COUNT(a.id)::bigint AS count
       FROM clone_colaboradores cc
       LEFT JOIN atendimentos a
         ON a.colaborador_id = cc.id
        AND a.slot = cc.slot
        AND a.tenant_id = $2
        AND a.deleted_at IS NULL
        AND a.data >= $3 AND a.data <= $4
        AND ${baldeCond}
      WHERE cc.slot = $1 AND cc.ativo = TRUE
      GROUP BY cc.id, cc.nome, cc.comissao_pct, cc.ordem
      ORDER BY comissao_cents DESC, cc.ordem ASC, cc.nome ASC, cc.id ASC`,
    [slot, tenantId, de, ate],
  );

  const rows = r.rows.map((x) => ({
    colaborador_id: Number(x.colaborador_id),
    profissional_nome: x.profissional_nome,
    total_bruto_cents: Number(x.total_bruto_cents),
    comissao_pct: Number(x.comissao_pct),
    comissao_cents: Number(x.comissao_cents),
    count: Number(x.count),
  }));

  return {
    de,
    ate,
    balde,
    total_cents: rows.reduce((acc, x) => acc + x.comissao_cents, 0),
    por_profissional: rows,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────
// ADR 0027 — billing DERIVADO DA AGENDA (split previsão×faturado + sticky de edição)
//
// Helpers do gancho de criar/atualizar/remover atendimento A PARTIR de um evento do GCal.
// A LIGAÇÃO destes helpers às rotas de agendamento é a Fase B2 (depois do PR #347) — aqui
// só os escrevemos e testamos. O coração é o "sticky": colunas que o dono editou à mão
// (registradas em dirty_fields) NUNCA são reescritas quando o evento muda (preço do
// catálogo não volta por cima do valor editado).
// ─────────────────────────────────────────────────────────────────────────────────────

/** Colunas que o split previsão×faturado e o sticky reconhecem como "deriváveis do evento". */
export type DirtyField =
  | 'valor_cents'
  | 'desconto_cents'
  | 'forma_pagamento'
  | 'servico_nome'
  | 'cliente_nome'
  | 'cliente_contato'
  | 'colaborador_id';

/**
 * Evento NORMALIZADO que o caller (B2) extrai de um CalendarEvent + contexto do clone.
 * Mantém este módulo desacoplado do SDK do Google Calendar (sem import cruzado de
 * packages/integrations). O caller resolve servico_nome do summary/descrição do evento e
 * o colaborador (estabelecimento) ANTES de chamar — aqui só persistimos.
 */
export interface AtendimentoEventInput {
  slot: string;
  /** tenant_id resolvido do clone pelo CALLER (getScopeBySlot). NOT NULL na tabela. */
  tenantId: string;
  /** ID do evento do GCal — chave da idempotência (unique parcial ux_atend_event_ativo). */
  gcalEventId: string;
  /** Nome do serviço (snapshot). Usado pra resolver o preço do catálogo se valorCents ausente. */
  servicoNome?: string | null;
  /**
   * Valor em centavos. Se AUSENTE (undefined/null), resolve do flow_clones.servicos pelo
   * servico_nome (fonte do preço, ver free-slots.ts). 'pacote' força 0.
   */
  valorCents?: number | null;
  descontoCents?: number | null;
  /** NULL = SOLO (individual sem profissional). Validado pertencer ao slot pelo CALLER. */
  colaboradorId?: number | null;
  /** NULL = ainda não pago/definido (previsão). 'pacote' -> valor 0. */
  formaPagamento?: string | null;
  clienteNome?: string | null;
  clienteContato?: string | null;
  /** Início do evento (Date ou ISO). Define inicio_at + data (dia do atendimento). */
  inicioAt?: Date | string | null;
  /** Fim do evento (Date ou ISO). Define fim_at (split previsão×faturado é por fim_at). */
  fimAt?: Date | string | null;
}

const _RETURNING_COLS = `id, slot, gcal_event_id, cliente_nome, cliente_contato, servico_nome,
  valor_cents, desconto_cents, forma_pagamento, colaborador_id,
  comissao_pct, comissao_cents, status, data, created_at, updated_at,
  origem, dirty_fields, inicio_at, fim_at, deleted_at`;

/** Normaliza dirty_fields vindo do pg (jsonb já parseado, mas defensivo p/ string). */
function asDirty(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === 'string');
  if (typeof value === 'string') {
    try {
      const p = JSON.parse(value);
      return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toIso(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d.toISOString();
  const parsed = new Date(d);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Dia (YYYY-MM-DD) de um instante; null se ausente -> deixa o banco usar now()::date. */
function isoToDateOnly(iso: string | null): string | null {
  return iso ? (iso.slice(0, 10) as string) : null;
}

/**
 * Resolve o preço do serviço (centavos) a partir de flow_clones.servicos pelo nome
 * (case-insensitive, trim). Fonte do preço — MESMO catálogo que o bot usa (free-slots.ts).
 * Retorna 0 se o serviço não bate (atendimento de previsão nasce sem valor; o dono ajusta).
 */
export async function resolvePrecoCents(slot: string, servicoNome: string | null): Promise<number> {
  if (!servicoNome || servicoNome.trim() === '') return 0;
  const r = await query<{ servicos: unknown }>(
    'SELECT servicos FROM flow_clones WHERE slot = $1 LIMIT 1',
    [slot],
  );
  const raw = r.rows[0]?.servicos;
  if (raw == null) return 0;
  let list: Array<{ nome?: unknown; preco_cents?: unknown }>;
  if (Array.isArray(raw)) list = raw as Array<{ nome?: unknown; preco_cents?: unknown }>;
  else if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      list = Array.isArray(p) ? p : [];
    } catch {
      return 0;
    }
  } else return 0;

  const alvo = servicoNome.trim().toLowerCase();
  for (const s of list) {
    const nome = typeof s.nome === 'string' ? s.nome.trim().toLowerCase() : '';
    if (nome === alvo) {
      const preco = Number(s.preco_cents);
      return Number.isFinite(preco) && preco > 0 ? Math.trunc(preco) : 0;
    }
  }
  return 0;
}

/**
 * Cria OU atualiza (idempotente pelo unique parcial ux_atend_event_ativo) o atendimento de
 * um evento do GCal. origem='agenda', status='agendado', forma_pagamento default NULL.
 *
 * STICKY (coração do ADR 0027): no UPDATE (evento já tinha linha), NENHUMA coluna presente
 * em dirty_fields é sobrescrita — o dono pinou aquele valor à mão. As demais deriváveis são
 * re-derivadas do evento (servico/valor/colaborador/janela). dirty_fields em si é preservado.
 *
 * PREÇO: valorCents ausente -> resolve do flow_clones.servicos pelo servico_nome.
 * PACOTE: forma_pagamento='pacote' -> valor_cents=0 (receita vive na venda do pacote).
 *
 * Comissão NÃO é congelada aqui (atendimento ainda é PREVISÃO; comissão só sobre faturado).
 * O snapshot de comissão acontece quando vira faturado (Fase B2 — fora do escopo deste PR).
 */
export async function upsertAtendimentoFromEvent(
  input: AtendimentoEventInput,
): Promise<AtendimentoRow> {
  const isPacote = input.formaPagamento === 'pacote';

  // Preço: explícito > catálogo. Pacote zera. Nunca negativo, sempre inteiro.
  let valorCents: number;
  if (isPacote) {
    valorCents = 0;
  } else if (input.valorCents != null) {
    valorCents = Math.max(0, Math.trunc(input.valorCents));
  } else {
    valorCents = await resolvePrecoCents(input.slot, input.servicoNome ?? null);
  }
  const descontoCents = isPacote ? 0 : Math.max(0, Math.trunc(input.descontoCents ?? 0));
  const colaboradorId = input.colaboradorId == null ? null : Math.trunc(input.colaboradorId);

  const inicioIso = toIso(input.inicioAt);
  const fimIso = toIso(input.fimAt);
  const dataDay = isoToDateOnly(inicioIso);

  // INSERT ... ON CONFLICT (slot, gcal_event_id) WHERE ... DO UPDATE. O coalesce com
  // dirty_fields é a chave do sticky: para cada coluna derivável, só atualiza se a coluna
  // NÃO estiver pinada (atendimentos.dirty_fields = a linha ANTIGA, via EXCLUDED é a nova).
  // `a.dirty_fields ? 'coluna'` (operador jsonb ?) testa pertença no array de strings.
  const r = await query<AtendimentoRow & { dirty_fields: unknown }>(
    `INSERT INTO atendimentos
       (slot, tenant_id, gcal_event_id, cliente_nome, cliente_contato, servico_nome,
        valor_cents, desconto_cents, forma_pagamento, colaborador_id,
        status, origem, dirty_fields, inicio_at, fim_at, data)
     VALUES
       ($1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        'agendado', 'agenda', '[]'::jsonb, $11::timestamptz, $12::timestamptz,
        COALESCE($13::date, now()::date))
     ON CONFLICT (slot, gcal_event_id) WHERE gcal_event_id IS NOT NULL AND deleted_at IS NULL
     DO UPDATE SET
       cliente_nome     = CASE WHEN atendimentos.dirty_fields ? 'cliente_nome'
                               THEN atendimentos.cliente_nome ELSE EXCLUDED.cliente_nome END,
       cliente_contato  = CASE WHEN atendimentos.dirty_fields ? 'cliente_contato'
                               THEN atendimentos.cliente_contato ELSE EXCLUDED.cliente_contato END,
       servico_nome     = CASE WHEN atendimentos.dirty_fields ? 'servico_nome'
                               THEN atendimentos.servico_nome ELSE EXCLUDED.servico_nome END,
       valor_cents      = CASE WHEN atendimentos.dirty_fields ? 'valor_cents'
                               THEN atendimentos.valor_cents ELSE EXCLUDED.valor_cents END,
       desconto_cents   = CASE WHEN atendimentos.dirty_fields ? 'desconto_cents'
                               THEN atendimentos.desconto_cents ELSE EXCLUDED.desconto_cents END,
       forma_pagamento  = CASE WHEN atendimentos.dirty_fields ? 'forma_pagamento'
                               THEN atendimentos.forma_pagamento ELSE EXCLUDED.forma_pagamento END,
       colaborador_id   = CASE WHEN atendimentos.dirty_fields ? 'colaborador_id'
                               THEN atendimentos.colaborador_id ELSE EXCLUDED.colaborador_id END,
       inicio_at        = EXCLUDED.inicio_at,
       fim_at           = EXCLUDED.fim_at,
       data             = EXCLUDED.data,
       updated_at       = now()
     RETURNING ${_RETURNING_COLS}`,
    [
      input.slot,
      input.tenantId,
      input.gcalEventId,
      input.clienteNome ?? null,
      input.clienteContato ?? null,
      input.servicoNome ?? null,
      valorCents,
      descontoCents,
      input.formaPagamento ?? null,
      colaboradorId,
      inicioIso,
      fimIso,
      dataDay,
    ],
  );
  const row = r.rows[0] as AtendimentoRow & { dirty_fields: unknown };
  return { ...row, dirty_fields: asDirty(row.dirty_fields) };
}

/**
 * Sincroniza a linha de um evento já existente (remarcar/trocar serviço pelo GCal).
 * É um alias semântico de upsertAtendimentoFromEvent — o ON CONFLICT cobre tanto o
 * "criar" quanto o "atualizar". Existe para a Fase B2 chamar com intenção explícita
 * (sync no cancelar/remarcar) e para o teste de sticky no caminho de update. Sem wire.
 */
export async function syncAtendimentoFromEvent(
  input: AtendimentoEventInput,
): Promise<AtendimentoRow> {
  return upsertAtendimentoFromEvent(input);
}

/**
 * Soft-delete do atendimento ATIVO de um evento (cancelar no GCal -> some do faturamento).
 * Escopado por slot — nunca cross-cliente. Idempotente: re-rodar é no-op (já deletado não
 * casa o WHERE). Retorna a linha deletada (ou null se não havia ativa). Para a Fase B2. Sem
 * wire. Não há estorno/trilha (decisão do Bruno: remover = some).
 */
export async function softDeleteAtendimentoByEvent(
  slot: string,
  gcalEventId: string,
): Promise<AtendimentoRow | null> {
  const r = await query<AtendimentoRow & { dirty_fields: unknown }>(
    `UPDATE atendimentos
        SET deleted_at = now(), updated_at = now()
      WHERE slot = $1 AND gcal_event_id = $2 AND deleted_at IS NULL
      RETURNING ${_RETURNING_COLS}`,
    [slot, gcalEventId],
  );
  const row = r.rows[0];
  return row ? { ...row, dirty_fields: asDirty(row.dirty_fields) } : null;
}

// ── Listagem por balde (previsão × faturado) — ADR 0027 ──────────────────────────────

/** Balde do split: previsao = futuro/aberto; faturado = passado/walk-in. */
export type Balde = 'previsao' | 'faturado';

/** Linha enriquecida com o nome do profissional (LEFT JOIN clone_colaboradores). */
export interface AtendimentoListRow {
  id: number;
  data: string;
  inicio_at: string | null;
  fim_at: string | null;
  cliente_nome: string | null;
  cliente_contato: string | null;
  servico_nome: string | null;
  valor_cents: number;
  desconto_cents: number;
  forma_pagamento: string | null;
  colaborador_id: number | null;
  profissional_nome: string | null;
  origem: string;
  dirty_fields: string[];
  status: string;
}

export interface AtendimentoListResult {
  atendimentos: AtendimentoListRow[];
  total_cents: number;
}

/** Forma crua de uma linha enriquecida (atendimentos a + JOIN clone_colaboradores). */
interface JoinedRawRow {
  id: number;
  data: string;
  inicio_at: string | null;
  fim_at: string | null;
  cliente_nome: string | null;
  cliente_contato: string | null;
  servico_nome: string | null;
  valor_cents: number;
  desconto_cents: number;
  forma_pagamento: string | null;
  colaborador_id: number | null;
  profissional_nome: string | null;
  origem: string;
  dirty_fields: unknown;
  status: string;
}

/**
 * Colunas da Row enriquecida (mesma forma do GET list E do retorno do PATCH). Usada nas
 * queries que fazem o LEFT JOIN com clone_colaboradores para trazer profissional_nome.
 * `a.` = alias de atendimentos; `c.` = alias de clone_colaboradores.
 */
const _LIST_COLS = `a.id, a.data, a.inicio_at, a.fim_at, a.cliente_nome, a.cliente_contato,
  a.servico_nome, a.valor_cents, a.desconto_cents, a.forma_pagamento,
  a.colaborador_id, c.nome AS profissional_nome, a.origem, a.dirty_fields, a.status`;

/** Mapeia a linha crua do JOIN -> AtendimentoListRow (números coeridos, dirty_fields normalizado). */
function mapJoinedRow(x: JoinedRawRow): AtendimentoListRow {
  return {
    id: Number(x.id),
    data: x.data,
    inicio_at: x.inicio_at,
    fim_at: x.fim_at,
    cliente_nome: x.cliente_nome,
    cliente_contato: x.cliente_contato,
    servico_nome: x.servico_nome,
    valor_cents: Number(x.valor_cents),
    desconto_cents: Number(x.desconto_cents),
    forma_pagamento: x.forma_pagamento,
    colaborador_id: x.colaborador_id == null ? null : Number(x.colaborador_id),
    profissional_nome: x.profissional_nome,
    origem: x.origem,
    dirty_fields: asDirty(x.dirty_fields),
    status: x.status,
  };
}

/**
 * Lista atendimentos de um balde num período [de, ate] (inclusivo por `data`). Escopo
 * SEMPRE slot + tenant_id. total_cents = SUM(valor - desconto) das linhas listadas.
 *
 * Split STATELESS por fim_at vs now() (ADR 0027):
 *   - previsao: deleted_at NULL AND status<>'cancelado' AND fim_at > now()
 *   - faturado: deleted_at NULL AND (fim_at <= now() OR origem='manual')
 * Walk-in (origem='manual', tipicamente fim_at NULL) é sempre FATURADO.
 */
export async function listAtendimentos(
  slot: string,
  tenantId: string,
  balde: Balde,
  de: string,
  ate: string,
): Promise<AtendimentoListResult> {
  const baldeCond =
    balde === 'previsao'
      ? "a.status <> 'cancelado' AND a.fim_at > now()"
      : "(a.fim_at <= now() OR a.origem = 'manual')";

  const r = await query<JoinedRawRow>(
    `SELECT ${_LIST_COLS}
       FROM atendimentos a
       LEFT JOIN clone_colaboradores c
         ON c.id = a.colaborador_id AND c.slot = a.slot
      WHERE a.slot = $1 AND a.tenant_id = $2
        AND a.deleted_at IS NULL
        AND a.data >= $3 AND a.data <= $4
        AND ${baldeCond}
      ORDER BY COALESCE(a.inicio_at, a.data::timestamptz) DESC, a.id DESC`,
    [slot, tenantId, de, ate],
  );

  const atendimentos = r.rows.map(mapJoinedRow);

  const total_cents = atendimentos.reduce((acc, a) => acc + (a.valor_cents - a.desconto_cents), 0);
  return { atendimentos, total_cents };
}

// ── Edição manual (PATCH) — pina as colunas enviadas em dirty_fields (sticky) ────────

/** Campos editáveis pelo dono no PATCH. Cada um enviado é PINADO em dirty_fields. */
export interface PatchAtendimentoInput {
  valorCents?: number;
  descontoCents?: number;
  formaPagamento?: string | null;
  servicoNome?: string | null;
  clienteNome?: string | null;
}

/**
 * Edita manualmente um atendimento e PINA cada coluna enviada em dirty_fields (sticky:
 * upsert futuro do evento não reverte). Escopado por slot + tenant_id (anti-IDOR) e só
 * linhas NÃO deletadas. Retorna a Row ENRIQUECIDA (igual ao GET list — inclui
 * `profissional_nome`, null no SOLO/sem colaborador), ou null se o id não existe no escopo.
 *
 * O retorno casa 1:1 com a Row do GET por balde (AtendimentoListRow): o front renderiza o
 * resultado do PATCH direto, sem refetch e sem piscar "Sem profissional" no estabelecimento.
 *
 * dirty_fields novo = união (sem duplicatas) do antigo + as colunas deste patch. Pinned vai
 * como jsonb parametrizado (nunca interpolado) e deduplica via jsonb_agg(DISTINCT) no SQL.
 */
export async function patchAtendimento(
  slot: string,
  tenantId: string,
  id: number,
  patch: PatchAtendimentoInput,
): Promise<AtendimentoListRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [slot, tenantId, id];
  const pinned: DirtyField[] = [];

  if (patch.valorCents !== undefined) {
    params.push(Math.max(0, Math.trunc(patch.valorCents)));
    sets.push(`valor_cents = $${params.length}`);
    pinned.push('valor_cents');
  }
  if (patch.descontoCents !== undefined) {
    params.push(Math.max(0, Math.trunc(patch.descontoCents)));
    sets.push(`desconto_cents = $${params.length}`);
    pinned.push('desconto_cents');
  }
  if (patch.formaPagamento !== undefined) {
    params.push(patch.formaPagamento);
    sets.push(`forma_pagamento = $${params.length}`);
    pinned.push('forma_pagamento');
  }
  if (patch.servicoNome !== undefined) {
    params.push(patch.servicoNome);
    sets.push(`servico_nome = $${params.length}`);
    pinned.push('servico_nome');
  }
  if (patch.clienteNome !== undefined) {
    params.push(patch.clienteNome);
    sets.push(`cliente_nome = $${params.length}`);
    pinned.push('cliente_nome');
  }

  if (sets.length === 0) {
    // Nada a alterar — devolve a linha atual ENRIQUECIDA (no escopo, não deletada) ou null.
    // Mesmo LEFT JOIN do GET list pra trazer profissional_nome.
    const cur = await query<JoinedRawRow>(
      `SELECT ${_LIST_COLS}
         FROM atendimentos a
         LEFT JOIN clone_colaboradores c
           ON c.id = a.colaborador_id AND c.slot = a.slot
        WHERE a.slot = $1 AND a.tenant_id = $2 AND a.id = $3 AND a.deleted_at IS NULL`,
      [slot, tenantId, id],
    );
    const row = cur.rows[0];
    return row ? mapJoinedRow(row) : null;
  }

  // Pinned (colunas deste patch) vai como jsonb parametrizado (nunca interpolado) — anti-
  // injeção mesmo sendo lista fixa. dirty_fields := DISTINCT(antigo || pinned).
  params.push(JSON.stringify(pinned.map((p) => p)));
  const pinnedParam = `$${params.length}::jsonb`;

  // CTE: faz o UPDATE escopado e SELECT da linha atualizada com o MESMO LEFT JOIN do GET
  // list — o retorno do PATCH traz profissional_nome (null no SOLO). Sem segundo round-trip.
  const r = await query<JoinedRawRow>(
    `WITH upd AS (
       UPDATE atendimentos AS a
          SET ${sets.join(', ')},
              dirty_fields = (
                SELECT COALESCE(jsonb_agg(DISTINCT e), '[]'::jsonb)
                  FROM jsonb_array_elements_text(a.dirty_fields || ${pinnedParam}) AS e
              ),
              updated_at = now()
        WHERE a.slot = $1 AND a.tenant_id = $2 AND a.id = $3 AND a.deleted_at IS NULL
        RETURNING a.*
     )
     SELECT ${_LIST_COLS}
       FROM upd a
       LEFT JOIN clone_colaboradores c
         ON c.id = a.colaborador_id AND c.slot = a.slot`,
    params,
  );
  const row = r.rows[0];
  return row ? mapJoinedRow(row) : null;
}

/**
 * Soft-delete de um atendimento por id (DELETE da rota — "some de tudo"). Escopado por
 * slot + tenant_id. Idempotente (já deletado não casa o WHERE -> retorna false). Sem
 * estorno/trilha (decisão do Bruno). Retorna true se deletou agora, false se não existia/já deletado.
 */
export async function softDeleteAtendimentoById(
  slot: string,
  tenantId: string,
  id: number,
): Promise<boolean> {
  const r = await query(
    `UPDATE atendimentos
        SET deleted_at = now(), updated_at = now()
      WHERE slot = $1 AND tenant_id = $2 AND id = $3 AND deleted_at IS NULL`,
    [slot, tenantId, id],
  );
  return (r.rowCount ?? 0) > 0;
}

// Garante uso do pool importado mesmo se nenhuma transação for aberta aqui (mantém o
// import alinhado ao padrão dos outros módulos e disponível p/ evolução transacional).
export { pool };
