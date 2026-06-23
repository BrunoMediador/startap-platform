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
               comissao_pct, comissao_cents, status, data, created_at, updated_at`,
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
// Escopo SEMPRE slot + tenant_id; só status='realizado'. Período inclusivo [de, ate].
// Faturamento = SUM(valor_cents - desconto_cents) (receita líquida de desconto).

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
  total_cents: number;
  count: number;
  ticket_medio_cents: number;
  por_forma_pagamento: FaturamentoPorFormaRow[];
  por_profissional: FaturamentoPorProfissionalRow[];
}

/**
 * Relatório de FATURAMENTO de um período: total, por forma de pagamento, por
 * profissional (com nome), ticket médio e contagem. Só status='realizado'.
 * Escopo slot + tenant_id (defesa em profundidade RLS). Período inclusivo.
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
      WHERE slot = $1 AND tenant_id = $2 AND status = 'realizado'
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
      WHERE slot = $1 AND tenant_id = $2 AND status = 'realizado'
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
      WHERE a.slot = $1 AND a.tenant_id = $2 AND a.status = 'realizado'
        AND a.data >= $3 AND a.data <= $4
      GROUP BY a.colaborador_id, c.nome
      ORDER BY total_cents DESC`,
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
  comissao_cents: number;
  count: number;
}

export interface ComissaoReport {
  de: string;
  ate: string;
  total_cents: number;
  por_profissional: ComissaoPorProfissionalRow[];
}

/**
 * Relatório de COMISSÃO A PAGAR por profissional num período (soma comissao_cents
 * congelado). Só status='realizado', só linhas COM colaborador_id (SOLO não gera
 * comissão -> lista vazia / total 0). Escopo slot + tenant_id.
 */
export async function getComissao(
  slot: string,
  tenantId: string,
  de: string,
  ate: string,
): Promise<ComissaoReport> {
  const r = await query<{
    colaborador_id: number;
    profissional_nome: string | null;
    comissao_cents: string;
    count: string;
  }>(
    `SELECT a.colaborador_id,
            c.nome AS profissional_nome,
            COALESCE(SUM(a.comissao_cents), 0)::bigint AS comissao_cents,
            COUNT(*)::bigint AS count
       FROM atendimentos a
       LEFT JOIN clone_colaboradores c
         ON c.id = a.colaborador_id AND c.slot = a.slot
      WHERE a.slot = $1 AND a.tenant_id = $2 AND a.status = 'realizado'
        AND a.colaborador_id IS NOT NULL
        AND a.data >= $3 AND a.data <= $4
      GROUP BY a.colaborador_id, c.nome
      ORDER BY comissao_cents DESC`,
    [slot, tenantId, de, ate],
  );

  const rows = r.rows.map((x) => ({
    colaborador_id: Number(x.colaborador_id),
    profissional_nome: x.profissional_nome,
    comissao_cents: Number(x.comissao_cents),
    count: Number(x.count),
  }));

  return {
    de,
    ate,
    total_cents: rows.reduce((acc, x) => acc + x.comissao_cents, 0),
    por_profissional: rows,
  };
}

// Garante uso do pool importado mesmo se nenhuma transação for aberta aqui (mantém o
// import alinhado ao padrão dos outros módulos e disponível p/ evolução transacional).
export { pool };
