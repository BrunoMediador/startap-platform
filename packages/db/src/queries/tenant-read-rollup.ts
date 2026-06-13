/**
 * tenant-read-rollup — LEITURA AGREGADA por cliente (MRR + uso de IA), com o
 * READ CUTOVER do `tenant_id` (ADR 0018, Fase 2b / Passo 3) flag-gated.
 *
 * ── O QUE ESTE MÓDULO RESOLVE ──────────────────────────────────────────────────
 * O ADR 0018 §"A dor concreta" descreve o relatório cross-tabela "MRR + uso de IA
 * por cliente" hoje montado por `JOIN ... ON x.slot = y.slot` repetido — a "UNION
 * manual frágil de billing/relatório" do roadmap. String (`slot VARCHAR(80)`) como
 * chave de junção é frágil a typo (já houve um typo de slot do Cirilo na migration
 * 028), a rename e a colisão. Depois do backfill da migration 045 + dual-write
 * (#287), cada linha de `client_billing`/`model_usage` carrega o `tenant_id` do
 * clone — uma chave estável e indexada por linha.
 *
 * ── SAFE-BY-CONSTRUCTION (não-negociável) ──────────────────────────────────────
 * Com a flag `TENANT_READ_CUTOVER` OFF (default) o rollup junta por `slot`,
 * comportamento IDÊNTICO ao de hoje. Com ON, junta por `tenant_id`. O cutover NÃO
 * toca o HOT PATH por-conversa (bot_config/bot_prompt por slot na resposta ao
 * cliente) — só esta leitura agregada de billing/relatório. Rollback = flag OFF.
 *
 * ── PARIDADE ANTES DE LIGAR ─────────────────────────────────────────────────────
 * `compareRollupParity()` roda os DOIS caminhos (slot e tenant_id) e devolve um diff
 * estruturado por cliente. Billing errado em cliente pagante (Cirilo/Edu) é
 * inaceitável — o QA roda isso ANTES de o Bruno ligar a flag e confirma que os dois
 * caminhos batem (mesmo número, mesmos clientes). NÃO liga nada; é só leitura.
 */
import { query } from '../client.js';
import { isTenantReadCutoverEnabled } from './tenant.js';

/** Uma linha do rollup por cliente: billing (MRR) + uso de IA agregado no período. */
export interface ClientRollupRow {
  /** Chave de junção legível (clone). Sempre presente nos dois modos. */
  slot: string;
  /**
   * tenant_id (UUID) do clone. Presente no modo tenant_id; no modo slot vem do
   * LEFT JOIN com flow_clones (pode ser null para slot de plataforma sem clone).
   */
  tenant_id: string | null;
  /** Valor da mensalidade em centavos (snapshot do client_billing). null se sem billing. */
  amount_cents: number | null;
  /** Vencimento corrente 'YYYY-MM-DD'. null se sem billing. */
  next_due_date: string | null;
  /** Nº de chamadas de LLM no período. */
  calls: number;
  /** Tokens totais consumidos no período. */
  total_tokens: number;
  /** Custo estimado em USD no período. */
  cost_usd: number;
}

/** Modo de junção efetivo do rollup. Exposto para observabilidade/log do QA. */
export type RollupMode = 'slot' | 'tenant_id';

/** Resultado do rollup, anotado com o modo que o produziu (transparência pro QA). */
export interface ClientRollupResult {
  mode: RollupMode;
  rows: ClientRollupRow[];
}

// SELECT-list comum aos dois caminhos. A ÚNICA diferença entre os modos é a chave de
// junção model_usage <-> billing/flow_clones (slot vs tenant_id) — o resto é igual,
// pra que a paridade seja uma comparação justa.
const SELECT_LIST = `fc.slot AS slot,
  fc.tenant_id::text AS tenant_id,
  cb.amount_cents AS amount_cents,
  to_char(cb.next_due_date, 'YYYY-MM-DD') AS next_due_date,
  COALESCE(u.calls, 0)::text        AS calls,
  COALESCE(u.total_tokens, 0)::text AS total_tokens,
  COALESCE(u.cost_usd, 0)::text     AS cost_usd`;

interface RawRollupRow {
  slot: string;
  tenant_id: string | null;
  amount_cents: number | null;
  next_due_date: string | null;
  calls: string;
  total_tokens: string;
  cost_usd: string | null;
}

function mapRow(r: RawRollupRow): ClientRollupRow {
  return {
    slot: r.slot,
    tenant_id: r.tenant_id,
    amount_cents: r.amount_cents,
    next_due_date: r.next_due_date,
    calls: Number(r.calls),
    total_tokens: Number(r.total_tokens),
    cost_usd: Number(r.cost_usd ?? 0),
  };
}

/**
 * Rollup por cliente via `slot` (comportamento ATUAL — flag OFF).
 *
 * Âncora em `flow_clones` (1 linha por clone real). model_usage é pré-agregado por
 * slot numa subquery e juntado por `u.slot = fc.slot`; client_billing por
 * `cb.slot = fc.slot`. Só clones reais entram (slots de plataforma sem flow_clones
 * — startap/teste_* — ficam de fora, igual ao relatório por cliente de hoje).
 */
export async function rollupBySlot(daysBack: number): Promise<ClientRollupRow[]> {
  const r = await query<RawRollupRow>(
    `SELECT ${SELECT_LIST}
       FROM flow_clones fc
       LEFT JOIN client_billing cb ON cb.slot = fc.slot
       LEFT JOIN (
         SELECT slot,
                COUNT(*)          AS calls,
                SUM(total_tokens) AS total_tokens,
                SUM(cost_usd)     AS cost_usd
           FROM model_usage
          WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
          GROUP BY slot
       ) u ON u.slot = fc.slot
      ORDER BY fc.slot`,
    [String(daysBack)],
  );
  return r.rows.map(mapRow);
}

/**
 * Rollup por cliente via `tenant_id` (READ CUTOVER — flag ON).
 *
 * Mesma forma do `rollupBySlot`, mas a junção model_usage <-> flow_clones é por
 * `u.tenant_id = fc.tenant_id` (UUID estável) em vez de string `slot`. client_billing
 * também junta por `cb.tenant_id = fc.tenant_id`. O pré-agregado de model_usage filtra
 * `tenant_id IS NOT NULL` (linhas de slot de plataforma não têm tenant — não entram no
 * relatório por cliente, exatamente como no modo slot). Depois do backfill (045) +
 * dual-write (#287), o resultado é equivalente ao modo slot para todo clone real.
 */
export async function rollupByTenant(daysBack: number): Promise<ClientRollupRow[]> {
  const r = await query<RawRollupRow>(
    `SELECT ${SELECT_LIST}
       FROM flow_clones fc
       LEFT JOIN client_billing cb ON cb.tenant_id = fc.tenant_id
       LEFT JOIN (
         SELECT tenant_id,
                COUNT(*)          AS calls,
                SUM(total_tokens) AS total_tokens,
                SUM(cost_usd)     AS cost_usd
           FROM model_usage
          WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
            AND tenant_id IS NOT NULL
          GROUP BY tenant_id
       ) u ON u.tenant_id = fc.tenant_id
      ORDER BY fc.slot`,
    [String(daysBack)],
  );
  return r.rows.map(mapRow);
}

/**
 * Rollup por cliente respeitando a flag `TENANT_READ_CUTOVER`.
 *
 * Flag OFF (default) -> `rollupBySlot` (idêntico a hoje). Flag ON -> `rollupByTenant`.
 * Anota o modo no resultado pra que o consumidor (e o log) saiba qual caminho rodou.
 * `env` é injetável só para teste — em produção lê `process.env`.
 */
export async function clientRollup(
  daysBack: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClientRollupResult> {
  if (isTenantReadCutoverEnabled(env)) {
    return { mode: 'tenant_id', rows: await rollupByTenant(daysBack) };
  }
  return { mode: 'slot', rows: await rollupBySlot(daysBack) };
}

// ─── Paridade slot vs tenant_id (QA roda ANTES de ligar a flag) ────────────────

/** Diferença encontrada num campo agregado de um cliente entre os dois caminhos. */
export interface ParityFieldDiff {
  field: keyof ClientRollupRow;
  slotValue: unknown;
  tenantValue: unknown;
}

/** Diferença por cliente (identificado pelo slot, presente nos dois modos). */
export interface ParityClientDiff {
  slot: string;
  /** O cliente existe num caminho mas não no outro (mismatch de conjunto). */
  presence: 'only_slot' | 'only_tenant' | 'both';
  /** Campos que divergem (vazio quando presence='both' e tudo bate). */
  diffs: ParityFieldDiff[];
}

export interface ParityReport {
  daysBack: number;
  slotCount: number;
  tenantCount: number;
  /** true SÓ se mesmos clientes E todos os campos agregados batem. Pré-condição pra ligar. */
  identical: boolean;
  /** Lista só os clientes com alguma divergência (vazio = paridade perfeita). */
  mismatches: ParityClientDiff[];
}

/**
 * Compara o rollup por `slot` (atual) com o por `tenant_id` (cutover) e devolve um
 * relatório de paridade. NÃO depende da flag (roda os dois caminhos sempre) — é a
 * ferramenta do QA pra validar ANTES de o Bruno ligar `TENANT_READ_CUTOVER`.
 *
 * `identical=true` exige: mesmo conjunto de clientes (por slot) E mesmos valores
 * agregados (amount_cents, next_due_date, calls, total_tokens, cost_usd) em cada um.
 * cost_usd é float — compara com tolerância de 1e-9 (ruído de SUM em ponto flutuante).
 *
 * `tenant_id` em si NÃO entra na comparação de campos: no modo slot ele vem do LEFT
 * JOIN (sempre presente p/ clone real) e no modo tenant é a própria chave — comparar
 * seria circular. O que importa é que os NÚMEROS por cliente batam.
 */
export async function compareRollupParity(daysBack: number): Promise<ParityReport> {
  const [slotRows, tenantRows] = await Promise.all([
    rollupBySlot(daysBack),
    rollupByTenant(daysBack),
  ]);

  const bySlot = new Map(slotRows.map((r) => [r.slot, r]));
  const byTenant = new Map(tenantRows.map((r) => [r.slot, r]));
  const allSlots = new Set<string>([...bySlot.keys(), ...byTenant.keys()]);

  const COMPARE_FIELDS: Array<keyof ClientRollupRow> = [
    'amount_cents',
    'next_due_date',
    'calls',
    'total_tokens',
    'cost_usd',
  ];

  const mismatches: ParityClientDiff[] = [];

  for (const slot of allSlots) {
    const s = bySlot.get(slot);
    const t = byTenant.get(slot);

    if (!s || !t) {
      mismatches.push({ slot, presence: s ? 'only_slot' : 'only_tenant', diffs: [] });
      continue;
    }

    const diffs: ParityFieldDiff[] = [];
    for (const field of COMPARE_FIELDS) {
      const sv = s[field];
      const tv = t[field];
      const equal =
        field === 'cost_usd' ? Math.abs(Number(sv ?? 0) - Number(tv ?? 0)) < 1e-9 : sv === tv;
      if (!equal) diffs.push({ field, slotValue: sv, tenantValue: tv });
    }
    if (diffs.length > 0) mismatches.push({ slot, presence: 'both', diffs });
  }

  return {
    daysBack,
    slotCount: slotRows.length,
    tenantCount: tenantRows.length,
    identical: mismatches.length === 0 && slotRows.length === tenantRows.length,
    mismatches,
  };
}
