/**
 * clientes — CRM canônico de clientes finais do tenant, identificado por
 * (tenant_id + telefone canônico). Os snapshots em `atendimentos` continuam
 * imutáveis; aqui vivem só o perfil canônico e as consultas de CRM.
 */
import { canonicalE164, phoneHint } from '@startap/core/phone';
import type pg from 'pg';
import { pool, query } from '../client.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_RANKING_LIMIT = 50;
const DEFAULT_HISTORY_LIMIT = 50;

interface SeedAtendimentoRow {
  id: string | number;
  cliente_nome: string | null;
  cliente_contato: string | null;
  cliente_telefone_canonico: string | null;
}

interface SqlExecutor {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<T>>;
}

interface ListRowRaw {
  id: string;
  nome: string | null;
  telefone_canonico: string;
  aniversario_mmdd: string | null;
  cidade: string | null;
  total_atendimentos: string;
  ultima_interacao_at: string | null;
  ultimo_profissional_nome: string | null;
  total_count: string;
}

interface SemRetornoRowRaw {
  id: string;
  nome: string | null;
  telefone_canonico: string;
  ultimo_atendimento_at: string;
  dias_sem_retorno: string | number;
  ultimo_profissional_nome: string | null;
  total_count: string;
}

interface AniversarianteRowRaw {
  id: string;
  nome: string | null;
  telefone_canonico: string;
  aniversario_mmdd: string;
  dias_para_aniversario: string | number;
  ultimo_profissional_nome: string | null;
  total_count: string;
}

interface ProfileRowRaw {
  id: string;
  nome: string | null;
  telefone_raw: string;
  aniversario_mmdd: string | null;
  cidade: string | null;
  nota_interna?: string | null;
  total_atendimentos: string;
  ultima_interacao_at: string | null;
  created_at: string;
  updated_at: string;
}

interface HistoricoRowRaw {
  atendimento_id: string | number;
  data: string;
  inicio_at: string | null;
  fim_at: string | null;
  cliente_nome: string | null;
  servico_nome: string | null;
  valor_cents: string | number;
  desconto_cents: string | number;
  forma_pagamento: string | null;
  status: string;
  origem: string;
  colaborador_id: string | number | null;
  profissional_nome: string | null;
}

export interface UpsertClienteFromSnapshotInput {
  tenantId: string;
  slot: string;
  clienteNome?: string | null;
  clienteContato?: string | null;
}

export interface ClienteListItem {
  id: string;
  nome: string | null;
  telefone_masked: string;
  aniversario_mmdd: string | null;
  cidade: string | null;
  total_atendimentos: number;
  ultima_interacao_at: string | null;
  ultimo_profissional_nome: string | null;
}

export interface ClienteListResult {
  clientes: ClienteListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface ClienteProfile {
  id: string;
  nome: string | null;
  telefone: string;
  aniversario_mmdd: string | null;
  cidade: string | null;
  nota_interna: string | null;
  total_atendimentos: number;
  ultima_interacao_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClienteProfileColaborador
  extends Omit<ClienteProfile, 'nota_interna'> {}

export interface ClienteSemRetornoItem {
  id: string;
  nome: string | null;
  telefone_masked: string;
  ultimo_atendimento_at: string;
  dias_sem_retorno: number;
  ultimo_profissional_nome: string | null;
}

export interface ClienteSemRetornoResult {
  clientes: ClienteSemRetornoItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface ClienteAniversarianteItem {
  id: string;
  nome: string | null;
  telefone_masked: string;
  aniversario_mmdd: string;
  dias_para_aniversario: number;
  ultimo_profissional_nome: string | null;
}

export interface ClienteAniversariantesResult {
  clientes: ClienteAniversarianteItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface ClienteHistoricoRow {
  atendimento_id: number;
  data: string;
  inicio_at: string | null;
  fim_at: string | null;
  cliente_nome: string | null;
  servico_nome: string | null;
  valor_cents: number;
  desconto_cents: number;
  forma_pagamento: string | null;
  status: string;
  origem: string;
  colaborador_id: number | null;
  profissional_nome: string | null;
}

export interface UpdateClienteProfileInput {
  aniversario_mmdd?: string | null;
  cidade?: string | null;
  nota_interna?: string | null;
}

export interface SeedClientesResult {
  clientesSeeded: number;
  atendimentosUpdated: number;
}

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function digitsOnly(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

function normalizePhoneSnapshot(
  value: string | null | undefined,
): { canonical: string; rawDigits: string } | null {
  const canonical = canonicalE164(value ?? '');
  const rawDigits = digitsOnly(value);
  if (!canonical || rawDigits.length < 8) return null;
  return { canonical, rawDigits };
}

function normalizePaging(limit?: number, offset?: number): { limit: number; offset: number } {
  const safeLimit = Number.isFinite(limit) ? Math.trunc(limit as number) : DEFAULT_LIMIT;
  const safeOffset = Number.isFinite(offset) ? Math.trunc(offset as number) : 0;
  return {
    limit: Math.min(MAX_LIMIT, Math.max(1, safeLimit)),
    offset: Math.max(0, safeOffset),
  };
}

function normalizeRankingPaging(limit?: number, offset?: number): { limit: number; offset: number } {
  const safeLimit = Number.isFinite(limit) ? Math.trunc(limit as number) : DEFAULT_LIMIT;
  const safeOffset = Number.isFinite(offset) ? Math.trunc(offset as number) : 0;
  return {
    limit: Math.min(MAX_RANKING_LIMIT, Math.max(1, safeLimit)),
    offset: Math.max(0, safeOffset),
  };
}

function normalizeSearch(search?: string | null): {
  token: string | null;
  likeText: string | null;
  likeDigits: string | null;
} {
  const token = trimOrNull(search);
  if (!token) return { token: null, likeText: null, likeDigits: null };
  const lower = token.toLowerCase();
  const digits = digitsOnly(token);
  return {
    token,
    likeText: `%${lower}%`,
    likeDigits: digits.length > 0 ? `%${digits}%` : null,
  };
}

function mapListRow(row: ListRowRaw): ClienteListItem {
  return {
    id: row.id,
    nome: row.nome,
    telefone_masked: phoneHint(row.telefone_canonico),
    aniversario_mmdd: row.aniversario_mmdd,
    cidade: row.cidade,
    total_atendimentos: Number(row.total_atendimentos),
    ultima_interacao_at: row.ultima_interacao_at,
    ultimo_profissional_nome: row.ultimo_profissional_nome,
  };
}

function mapSemRetornoRow(row: SemRetornoRowRaw): ClienteSemRetornoItem {
  return {
    id: row.id,
    nome: row.nome,
    telefone_masked: phoneHint(row.telefone_canonico),
    ultimo_atendimento_at: row.ultimo_atendimento_at,
    dias_sem_retorno: Number(row.dias_sem_retorno),
    ultimo_profissional_nome: row.ultimo_profissional_nome,
  };
}

function mapAniversarianteRow(row: AniversarianteRowRaw): ClienteAniversarianteItem {
  return {
    id: row.id,
    nome: row.nome,
    telefone_masked: phoneHint(row.telefone_canonico),
    aniversario_mmdd: row.aniversario_mmdd,
    dias_para_aniversario: Number(row.dias_para_aniversario),
    ultimo_profissional_nome: row.ultimo_profissional_nome,
  };
}

function mapProfileRow(row: ProfileRowRaw): ClienteProfile {
  return {
    id: row.id,
    nome: row.nome,
    telefone: row.telefone_raw,
    aniversario_mmdd: row.aniversario_mmdd,
    cidade: row.cidade,
    nota_interna: row.nota_interna ?? null,
    total_atendimentos: Number(row.total_atendimentos),
    ultima_interacao_at: row.ultima_interacao_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapHistoricoRow(row: HistoricoRowRaw): ClienteHistoricoRow {
  return {
    atendimento_id: Number(row.atendimento_id),
    data: row.data,
    inicio_at: row.inicio_at,
    fim_at: row.fim_at,
    cliente_nome: row.cliente_nome,
    servico_nome: row.servico_nome,
    valor_cents: Number(row.valor_cents),
    desconto_cents: Number(row.desconto_cents),
    forma_pagamento: row.forma_pagamento,
    status: row.status,
    origem: row.origem,
    colaborador_id: row.colaborador_id == null ? null : Number(row.colaborador_id),
    profissional_nome: row.profissional_nome,
  };
}

async function upsertClienteFromSnapshotWithExecutor(
  executor: SqlExecutor,
  input: UpsertClienteFromSnapshotInput,
): Promise<string | null> {
  const phone = normalizePhoneSnapshot(input.clienteContato);
  if (!phone) return null;

  await executor.query(
    `INSERT INTO clientes (tenant_id, slot, telefone_canonico, telefone_raw, nome, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (tenant_id, telefone_canonico) DO UPDATE
       SET slot = EXCLUDED.slot,
           telefone_raw = COALESCE(NULLIF(EXCLUDED.telefone_raw, ''), clientes.telefone_raw),
           nome = COALESCE(NULLIF(EXCLUDED.nome, ''), clientes.nome),
           updated_at = NOW()`,
    [
      input.tenantId,
      input.slot,
      phone.canonical,
      phone.rawDigits,
      trimOrNull(input.clienteNome),
    ],
  );

  return phone.canonical;
}

export async function upsertClienteFromSnapshot(
  input: UpsertClienteFromSnapshotInput,
  executor: SqlExecutor = { query },
): Promise<string | null> {
  return upsertClienteFromSnapshotWithExecutor(executor, input);
}

/**
 * Semeia o CRM deste tenant a partir dos snapshots já existentes de `atendimentos`,
 * sem mutar nome/telefone nos próprios snapshots. Mantido FORA do hot path de GET:
 * serve para backfill one-shot futuro, não para leitura online.
 */
export async function seedClientesFromAtendimentos(
  slot: string,
  tenantId: string,
): Promise<SeedClientesResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query<SeedAtendimentoRow>(
      `SELECT id, cliente_nome, cliente_contato, cliente_telefone_canonico
         FROM atendimentos
        WHERE slot = $1
          AND tenant_id = $2
          AND deleted_at IS NULL
          AND cliente_contato IS NOT NULL
        ORDER BY COALESCE(inicio_at, data::timestamptz) DESC, id DESC`,
      [slot, tenantId],
    );

    const byCanonical = new Map<string, { rawDigits: string; nome: string | null }>();
    const atendimentoIds: number[] = [];
    const atendimentoCanonicals: string[] = [];

    for (const row of rows.rows) {
      const phone = normalizePhoneSnapshot(row.cliente_contato);
      if (!phone) continue;
      if (!byCanonical.has(phone.canonical)) {
        byCanonical.set(phone.canonical, {
          rawDigits: phone.rawDigits,
          nome: trimOrNull(row.cliente_nome),
        });
      }
      if (row.cliente_telefone_canonico !== phone.canonical) {
        atendimentoIds.push(Number(row.id));
        atendimentoCanonicals.push(phone.canonical);
      }
    }

    if (byCanonical.size > 0) {
      const canonicals = [...byCanonical.keys()];
      const raws = canonicals.map((canonical) => byCanonical.get(canonical)?.rawDigits ?? canonical);
      const nomes = canonicals.map((canonical) => byCanonical.get(canonical)?.nome ?? null);

      await client.query(
        `INSERT INTO clientes (tenant_id, slot, telefone_canonico, telefone_raw, nome, updated_at)
         SELECT $1, $2, src.telefone_canonico, src.telefone_raw, NULLIF(src.nome, ''), NOW()
           FROM UNNEST($3::text[], $4::text[], $5::text[]) AS src(
             telefone_canonico,
             telefone_raw,
             nome
           )
         ON CONFLICT (tenant_id, telefone_canonico) DO UPDATE
           SET slot = EXCLUDED.slot,
               telefone_raw = COALESCE(NULLIF(EXCLUDED.telefone_raw, ''), clientes.telefone_raw),
               nome = COALESCE(NULLIF(EXCLUDED.nome, ''), clientes.nome),
               updated_at = NOW()`,
        [tenantId, slot, canonicals, raws, nomes],
      );
    }

    if (atendimentoIds.length > 0) {
      await client.query(
        `UPDATE atendimentos AS a
            SET cliente_telefone_canonico = src.telefone_canonico
           FROM UNNEST($1::bigint[], $2::text[]) AS src(id, telefone_canonico)
          WHERE a.id = src.id`,
        [atendimentoIds, atendimentoCanonicals],
      );
    }

    await client.query('COMMIT');
    return {
      clientesSeeded: byCanonical.size,
      atendimentosUpdated: atendimentoIds.length,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listClientesForOwner(input: {
  slot: string;
  tenantId: string;
  search?: string | null;
  limit?: number;
  offset?: number;
}): Promise<ClienteListResult> {
  const { limit, offset } = normalizePaging(input.limit, input.offset);
  const search = normalizeSearch(input.search);
  const rows = await query<ListRowRaw>(
    `SELECT *
       FROM (
         SELECT c.id,
                c.nome,
                c.telefone_canonico,
                c.aniversario_mmdd,
                c.cidade,
                COALESCE(stats.total_atendimentos, 0)::bigint AS total_atendimentos,
                stats.ultima_interacao_at,
                stats.ultimo_profissional_nome,
                COUNT(*) OVER()::bigint AS total_count
           FROM clientes c
           LEFT JOIN LATERAL (
             SELECT COUNT(*)::bigint AS total_atendimentos,
                    MAX(COALESCE(a.inicio_at, a.data::timestamptz)) AS ultima_interacao_at,
                    (
                      ARRAY_AGG(cc.nome ORDER BY COALESCE(a.inicio_at, a.data::timestamptz) DESC, a.id DESC)
                    )[1] AS ultimo_profissional_nome
               FROM atendimentos a
               LEFT JOIN clone_colaboradores cc
                 ON cc.id = a.colaborador_id AND cc.slot = a.slot
              WHERE a.slot = c.slot
                AND a.tenant_id = c.tenant_id
                AND a.deleted_at IS NULL
                AND a.cliente_telefone_canonico = c.telefone_canonico
           ) AS stats ON TRUE
          WHERE c.slot = $1
            AND c.tenant_id = $2
            AND (
              $3::text IS NULL
              OR lower(COALESCE(c.nome, '')) LIKE $4
              OR lower(COALESCE(c.cidade, '')) LIKE $4
              OR ($5::text IS NOT NULL AND (c.telefone_raw LIKE $5 OR c.telefone_canonico LIKE $5))
            )
          ORDER BY stats.ultima_interacao_at DESC NULLS LAST, c.updated_at DESC, c.id DESC
       ) AS page
      LIMIT $6 OFFSET $7`,
    [input.slot, input.tenantId, search.token, search.likeText, search.likeDigits, limit, offset],
  );

  return {
    clientes: rows.rows.map(mapListRow),
    total: Number(rows.rows[0]?.total_count ?? 0),
    limit,
    offset,
  };
}

export async function listClientesForColaborador(input: {
  slot: string;
  tenantId: string;
  colaboradorId: number;
  search?: string | null;
  limit?: number;
  offset?: number;
}): Promise<ClienteListResult> {
  const { limit, offset } = normalizePaging(input.limit, input.offset);
  const search = normalizeSearch(input.search);
  const rows = await query<ListRowRaw>(
    `SELECT *
       FROM (
         SELECT c.id,
                c.nome,
                c.telefone_canonico,
                c.aniversario_mmdd,
                c.cidade,
                COALESCE(stats.total_atendimentos, 0)::bigint AS total_atendimentos,
                stats.ultima_interacao_at,
                stats.ultimo_profissional_nome,
                COUNT(*) OVER()::bigint AS total_count
           FROM clientes c
           LEFT JOIN LATERAL (
             SELECT COUNT(*)::bigint AS total_atendimentos,
                    MAX(COALESCE(a.inicio_at, a.data::timestamptz)) AS ultima_interacao_at,
                    (
                      ARRAY_AGG(cc.nome ORDER BY COALESCE(a.inicio_at, a.data::timestamptz) DESC, a.id DESC)
                    )[1] AS ultimo_profissional_nome
               FROM atendimentos a
               LEFT JOIN clone_colaboradores cc
                 ON cc.id = a.colaborador_id AND cc.slot = a.slot
              WHERE a.slot = c.slot
                AND a.tenant_id = c.tenant_id
                AND a.deleted_at IS NULL
                AND a.colaborador_id = $3
                AND a.cliente_telefone_canonico = c.telefone_canonico
           ) AS stats ON TRUE
          WHERE c.slot = $1
            AND c.tenant_id = $2
            AND EXISTS (
              SELECT 1
                FROM atendimentos own_a
               WHERE own_a.slot = c.slot
                 AND own_a.tenant_id = c.tenant_id
                 AND own_a.deleted_at IS NULL
                 AND own_a.colaborador_id = $3
                 AND own_a.cliente_telefone_canonico = c.telefone_canonico
            )
            AND (
              $4::text IS NULL
              OR lower(COALESCE(c.nome, '')) LIKE $5
              OR lower(COALESCE(c.cidade, '')) LIKE $5
              OR ($6::text IS NOT NULL AND (c.telefone_raw LIKE $6 OR c.telefone_canonico LIKE $6))
            )
          ORDER BY stats.ultima_interacao_at DESC NULLS LAST, c.updated_at DESC, c.id DESC
       ) AS page
      LIMIT $7 OFFSET $8`,
    [
      input.slot,
      input.tenantId,
      input.colaboradorId,
      search.token,
      search.likeText,
      search.likeDigits,
      limit,
      offset,
    ],
  );

  return {
    clientes: rows.rows.map(mapListRow),
    total: Number(rows.rows[0]?.total_count ?? 0),
    limit,
    offset,
  };
}

/**
 * Ranking read-only "sem retorno" da carteira do tenant. A lista nunca expõe telefone
 * cru/canônico e considera elegível apenas atendimento ativo, não cancelado e já
 * concluído/passado. Manual usa a data local do produto; agenda usa fim_at/inicio_at.
 *
 * A consulta é separada em ramos agenda/manual via UNION ALL para que o planner consiga
 * usar os dois índices parciais do ranking sem depender de heurística sobre um OR misto.
 */
export async function listClientesSemRetornoForOwner(input: {
  slot: string;
  tenantId: string;
  timezone: string;
  limit?: number;
  offset?: number;
}): Promise<ClienteSemRetornoResult> {
  const { limit, offset } = normalizeRankingPaging(input.limit, input.offset);
  const rows = await query<SemRetornoRowRaw>(
    `WITH elegiveis AS (
       SELECT c.id,
              c.nome,
              c.telefone_canonico,
              COALESCE(a.fim_at, a.inicio_at) AS ultimo_atendimento_at,
              (COALESCE(a.fim_at, a.inicio_at) AT TIME ZONE $3)::date AS referencia_local_date,
              cc.nome AS ultimo_profissional_nome,
              a.id AS atendimento_id
         FROM clientes c
         JOIN atendimentos a
           ON a.slot = c.slot
          AND a.tenant_id = c.tenant_id
          AND a.deleted_at IS NULL
          AND a.status <> 'cancelado'
          AND a.origem = 'agenda'
          AND a.cliente_telefone_canonico = c.telefone_canonico
          AND COALESCE(a.fim_at, a.inicio_at) <= NOW()
         LEFT JOIN clone_colaboradores cc
           ON cc.id = a.colaborador_id AND cc.slot = a.slot
        WHERE c.slot = $1
          AND c.tenant_id = $2

       UNION ALL

       SELECT c.id,
              c.nome,
              c.telefone_canonico,
              (a.data::timestamp AT TIME ZONE $3) AS ultimo_atendimento_at,
              a.data AS referencia_local_date,
              cc.nome AS ultimo_profissional_nome,
              a.id AS atendimento_id
         FROM clientes c
         JOIN atendimentos a
           ON a.slot = c.slot
          AND a.tenant_id = c.tenant_id
          AND a.deleted_at IS NULL
          AND a.status <> 'cancelado'
          AND a.origem = 'manual'
          AND a.cliente_telefone_canonico = c.telefone_canonico
          AND a.data <= (NOW() AT TIME ZONE $3)::date
         LEFT JOIN clone_colaboradores cc
           ON cc.id = a.colaborador_id AND cc.slot = a.slot
        WHERE c.slot = $1
          AND c.tenant_id = $2
     ),
     ranqueados AS (
       SELECT id,
              nome,
              telefone_canonico,
              ultimo_atendimento_at,
              referencia_local_date,
              ultimo_profissional_nome,
              ROW_NUMBER() OVER (
                PARTITION BY id
                ORDER BY ultimo_atendimento_at DESC, atendimento_id DESC
              ) AS rn
         FROM elegiveis
     )
     SELECT id,
            nome,
            telefone_canonico,
            ultimo_atendimento_at,
            GREATEST(0, ((NOW() AT TIME ZONE $3)::date - referencia_local_date))::int AS dias_sem_retorno,
            ultimo_profissional_nome,
            COUNT(*) OVER()::bigint AS total_count
       FROM ranqueados
      WHERE rn = 1
      ORDER BY ultimo_atendimento_at ASC, id ASC
      LIMIT $4 OFFSET $5`,
    [input.slot, input.tenantId, input.timezone, limit, offset],
  );

  return {
    clientes: rows.rows.map(mapSemRetornoRow),
    total: Number(rows.rows[0]?.total_count ?? 0),
    limit,
    offset,
  };
}

export async function listClientesSemRetornoForColaborador(input: {
  slot: string;
  tenantId: string;
  colaboradorId: number;
  timezone: string;
  limit?: number;
  offset?: number;
}): Promise<ClienteSemRetornoResult> {
  const { limit, offset } = normalizeRankingPaging(input.limit, input.offset);
  const rows = await query<SemRetornoRowRaw>(
    `WITH elegiveis AS (
       SELECT c.id,
              c.nome,
              c.telefone_canonico,
              COALESCE(a.fim_at, a.inicio_at) AS ultimo_atendimento_at,
              (COALESCE(a.fim_at, a.inicio_at) AT TIME ZONE $4)::date AS referencia_local_date,
              cc.nome AS ultimo_profissional_nome,
              a.id AS atendimento_id
         FROM clientes c
         JOIN atendimentos a
           ON a.slot = c.slot
          AND a.tenant_id = c.tenant_id
          AND a.deleted_at IS NULL
          AND a.status <> 'cancelado'
          AND a.colaborador_id = $3
          AND a.origem = 'agenda'
          AND a.cliente_telefone_canonico = c.telefone_canonico
          AND COALESCE(a.fim_at, a.inicio_at) <= NOW()
         LEFT JOIN clone_colaboradores cc
           ON cc.id = a.colaborador_id AND cc.slot = a.slot
        WHERE c.slot = $1
          AND c.tenant_id = $2

       UNION ALL

       SELECT c.id,
              c.nome,
              c.telefone_canonico,
              (a.data::timestamp AT TIME ZONE $4) AS ultimo_atendimento_at,
              a.data AS referencia_local_date,
              cc.nome AS ultimo_profissional_nome,
              a.id AS atendimento_id
         FROM clientes c
         JOIN atendimentos a
           ON a.slot = c.slot
          AND a.tenant_id = c.tenant_id
          AND a.deleted_at IS NULL
          AND a.status <> 'cancelado'
          AND a.colaborador_id = $3
          AND a.origem = 'manual'
          AND a.cliente_telefone_canonico = c.telefone_canonico
          AND a.data <= (NOW() AT TIME ZONE $4)::date
         LEFT JOIN clone_colaboradores cc
           ON cc.id = a.colaborador_id AND cc.slot = a.slot
        WHERE c.slot = $1
          AND c.tenant_id = $2
     ),
     ranqueados AS (
       SELECT id,
              nome,
              telefone_canonico,
              ultimo_atendimento_at,
              referencia_local_date,
              ultimo_profissional_nome,
              ROW_NUMBER() OVER (
                PARTITION BY id
                ORDER BY ultimo_atendimento_at DESC, atendimento_id DESC
              ) AS rn
         FROM elegiveis
     )
     SELECT id,
            nome,
            telefone_canonico,
            ultimo_atendimento_at,
            GREATEST(0, ((NOW() AT TIME ZONE $4)::date - referencia_local_date))::int AS dias_sem_retorno,
            ultimo_profissional_nome,
            COUNT(*) OVER()::bigint AS total_count
       FROM ranqueados
      WHERE rn = 1
      ORDER BY ultimo_atendimento_at ASC, id ASC
      LIMIT $5 OFFSET $6`,
    [input.slot, input.tenantId, input.colaboradorId, input.timezone, limit, offset],
  );

  return {
    clientes: rows.rows.map(mapSemRetornoRow),
    total: Number(rows.rows[0]?.total_count ?? 0),
    limit,
    offset,
  };
}

/**
 * Usa o ano bissexto 2000 como calendário sintético para validar/ordenar MM-DD
 * sem perder clientes de 29/02 nos anos não bissextos. O payload segue mínimo:
 * aniversário original + distância em dias, sempre com telefone mascarado.
 */
export async function listClientesAniversariantesForOwner(input: {
  slot: string;
  tenantId: string;
  timezone: string;
  limit?: number;
  offset?: number;
}): Promise<ClienteAniversariantesResult> {
  const { limit, offset } = normalizeRankingPaging(input.limit, input.offset);
  const rows = await query<AniversarianteRowRaw>(
    `WITH contexto AS (
       SELECT EXTRACT(
                DOY FROM make_date(
                  2000,
                  EXTRACT(MONTH FROM (NOW() AT TIME ZONE $3))::int,
                  EXTRACT(DAY FROM (NOW() AT TIME ZONE $3))::int
                )
              )::int AS hoje_doy
     )
     SELECT c.id,
            c.nome,
            c.telefone_canonico,
            c.aniversario_mmdd,
            CASE
              WHEN aniversario_doy >= ctx.hoje_doy THEN aniversario_doy - ctx.hoje_doy
              ELSE 366 - ctx.hoje_doy + aniversario_doy
            END::int AS dias_para_aniversario,
            stats.ultimo_profissional_nome,
            COUNT(*) OVER()::bigint AS total_count
       FROM clientes c
       CROSS JOIN contexto ctx
       CROSS JOIN LATERAL (
         SELECT EXTRACT(
                  DOY FROM make_date(
                    2000,
                    split_part(c.aniversario_mmdd, '-', 1)::int,
                    split_part(c.aniversario_mmdd, '-', 2)::int
                  )
                )::int AS aniversario_doy
       ) AS birthday
       LEFT JOIN LATERAL (
         SELECT (
                  ARRAY_AGG(
                    cc.nome
                    ORDER BY COALESCE(a.inicio_at, a.data::timestamptz) DESC, a.id DESC
                  )
                )[1] AS ultimo_profissional_nome
           FROM atendimentos a
           LEFT JOIN clone_colaboradores cc
             ON cc.id = a.colaborador_id AND cc.slot = a.slot
          WHERE a.slot = c.slot
            AND a.tenant_id = c.tenant_id
            AND a.deleted_at IS NULL
            AND a.cliente_telefone_canonico = c.telefone_canonico
       ) AS stats ON TRUE
      WHERE c.slot = $1
        AND c.tenant_id = $2
        AND c.aniversario_mmdd IS NOT NULL
        AND to_char(to_date('2000-' || c.aniversario_mmdd, 'YYYY-MM-DD'), 'MM-DD') = c.aniversario_mmdd
      ORDER BY dias_para_aniversario ASC, c.aniversario_mmdd ASC, c.id ASC
      LIMIT $4 OFFSET $5`,
    [input.slot, input.tenantId, input.timezone, limit, offset],
  );

  return {
    clientes: rows.rows.map(mapAniversarianteRow),
    total: Number(rows.rows[0]?.total_count ?? 0),
    limit,
    offset,
  };
}

export async function listClientesAniversariantesForColaborador(input: {
  slot: string;
  tenantId: string;
  colaboradorId: number;
  timezone: string;
  limit?: number;
  offset?: number;
}): Promise<ClienteAniversariantesResult> {
  const { limit, offset } = normalizeRankingPaging(input.limit, input.offset);
  const rows = await query<AniversarianteRowRaw>(
    `WITH contexto AS (
       SELECT EXTRACT(
                DOY FROM make_date(
                  2000,
                  EXTRACT(MONTH FROM (NOW() AT TIME ZONE $4))::int,
                  EXTRACT(DAY FROM (NOW() AT TIME ZONE $4))::int
                )
              )::int AS hoje_doy
     )
     SELECT c.id,
            c.nome,
            c.telefone_canonico,
            c.aniversario_mmdd,
            CASE
              WHEN aniversario_doy >= ctx.hoje_doy THEN aniversario_doy - ctx.hoje_doy
              ELSE 366 - ctx.hoje_doy + aniversario_doy
            END::int AS dias_para_aniversario,
            stats.ultimo_profissional_nome,
            COUNT(*) OVER()::bigint AS total_count
       FROM clientes c
       CROSS JOIN contexto ctx
       CROSS JOIN LATERAL (
         SELECT EXTRACT(
                  DOY FROM make_date(
                    2000,
                    split_part(c.aniversario_mmdd, '-', 1)::int,
                    split_part(c.aniversario_mmdd, '-', 2)::int
                  )
                )::int AS aniversario_doy
       ) AS birthday
       LEFT JOIN LATERAL (
         SELECT (
                  ARRAY_AGG(
                    cc.nome
                    ORDER BY COALESCE(a.inicio_at, a.data::timestamptz) DESC, a.id DESC
                  )
                )[1] AS ultimo_profissional_nome
           FROM atendimentos a
           LEFT JOIN clone_colaboradores cc
             ON cc.id = a.colaborador_id AND cc.slot = a.slot
          WHERE a.slot = c.slot
            AND a.tenant_id = c.tenant_id
            AND a.deleted_at IS NULL
            AND a.colaborador_id = $3
            AND a.cliente_telefone_canonico = c.telefone_canonico
       ) AS stats ON TRUE
      WHERE c.slot = $1
        AND c.tenant_id = $2
        AND c.aniversario_mmdd IS NOT NULL
        AND to_char(to_date('2000-' || c.aniversario_mmdd, 'YYYY-MM-DD'), 'MM-DD') = c.aniversario_mmdd
        AND EXISTS (
          SELECT 1
            FROM atendimentos own_a
           WHERE own_a.slot = c.slot
             AND own_a.tenant_id = c.tenant_id
             AND own_a.deleted_at IS NULL
             AND own_a.colaborador_id = $3
             AND own_a.cliente_telefone_canonico = c.telefone_canonico
        )
      ORDER BY dias_para_aniversario ASC, c.aniversario_mmdd ASC, c.id ASC
      LIMIT $5 OFFSET $6`,
    [input.slot, input.tenantId, input.colaboradorId, input.timezone, limit, offset],
  );

  return {
    clientes: rows.rows.map(mapAniversarianteRow),
    total: Number(rows.rows[0]?.total_count ?? 0),
    limit,
    offset,
  };
}

export async function getClienteProfileForOwner(
  slot: string,
  tenantId: string,
  clienteId: string,
): Promise<ClienteProfile | null> {
  const rows = await query<ProfileRowRaw>(
    `SELECT c.id,
            c.nome,
            c.telefone_raw,
            c.aniversario_mmdd,
            c.cidade,
            c.nota_interna,
            c.created_at,
            c.updated_at,
            COALESCE(stats.total_atendimentos, 0)::bigint AS total_atendimentos,
            stats.ultima_interacao_at
       FROM clientes c
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::bigint AS total_atendimentos,
                MAX(COALESCE(a.inicio_at, a.data::timestamptz)) AS ultima_interacao_at
           FROM atendimentos a
          WHERE a.slot = c.slot
            AND a.tenant_id = c.tenant_id
            AND a.deleted_at IS NULL
            AND a.cliente_telefone_canonico = c.telefone_canonico
       ) AS stats ON TRUE
      WHERE c.slot = $1 AND c.tenant_id = $2 AND c.id = $3
      LIMIT 1`,
    [slot, tenantId, clienteId],
  );
  const row = rows.rows[0];
  return row ? mapProfileRow(row) : null;
}

export async function getClienteProfileForColaborador(
  slot: string,
  tenantId: string,
  colaboradorId: number,
  clienteId: string,
): Promise<ClienteProfileColaborador | null> {
  const rows = await query<ProfileRowRaw>(
    `SELECT c.id,
            c.nome,
            c.telefone_raw,
            c.aniversario_mmdd,
            c.cidade,
            c.created_at,
            c.updated_at,
            COALESCE(stats.total_atendimentos, 0)::bigint AS total_atendimentos,
            stats.ultima_interacao_at
       FROM clientes c
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::bigint AS total_atendimentos,
                MAX(COALESCE(a.inicio_at, a.data::timestamptz)) AS ultima_interacao_at
           FROM atendimentos a
          WHERE a.slot = c.slot
            AND a.tenant_id = c.tenant_id
            AND a.deleted_at IS NULL
            AND a.colaborador_id = $3
            AND a.cliente_telefone_canonico = c.telefone_canonico
       ) AS stats ON TRUE
      WHERE c.slot = $1
        AND c.tenant_id = $2
        AND c.id = $4
        AND EXISTS (
          SELECT 1
            FROM atendimentos own_a
           WHERE own_a.slot = c.slot
             AND own_a.tenant_id = c.tenant_id
             AND own_a.deleted_at IS NULL
             AND own_a.colaborador_id = $3
             AND own_a.cliente_telefone_canonico = c.telefone_canonico
        )
      LIMIT 1`,
    [slot, tenantId, colaboradorId, clienteId],
  );
  const row = rows.rows[0];
  if (!row) return null;
  const profile = mapProfileRow(row);
  const { nota_interna: _ignored, ...withoutNote } = profile;
  return withoutNote;
}

export async function listClienteHistoricoForOwner(input: {
  slot: string;
  tenantId: string;
  clienteId: string;
  limit?: number;
}): Promise<ClienteHistoricoRow[]> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(input.limit ?? DEFAULT_HISTORY_LIMIT)));
  const rows = await query<HistoricoRowRaw>(
    `SELECT a.id AS atendimento_id,
            a.data,
            a.inicio_at,
            a.fim_at,
            a.cliente_nome,
            a.servico_nome,
            a.valor_cents,
            a.desconto_cents,
            a.forma_pagamento,
            a.status,
            a.origem,
            a.colaborador_id,
            cc.nome AS profissional_nome
       FROM clientes c
       JOIN atendimentos a
         ON a.slot = c.slot
        AND a.tenant_id = c.tenant_id
        AND a.deleted_at IS NULL
        AND a.cliente_telefone_canonico = c.telefone_canonico
       LEFT JOIN clone_colaboradores cc
         ON cc.id = a.colaborador_id AND cc.slot = a.slot
      WHERE c.slot = $1 AND c.tenant_id = $2 AND c.id = $3
      ORDER BY COALESCE(a.inicio_at, a.data::timestamptz) DESC, a.id DESC
      LIMIT $4`,
    [input.slot, input.tenantId, input.clienteId, limit],
  );
  return rows.rows.map(mapHistoricoRow);
}

export async function listClienteHistoricoForColaborador(input: {
  slot: string;
  tenantId: string;
  colaboradorId: number;
  clienteId: string;
  limit?: number;
}): Promise<ClienteHistoricoRow[]> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(input.limit ?? DEFAULT_HISTORY_LIMIT)));
  const rows = await query<HistoricoRowRaw>(
    `SELECT a.id AS atendimento_id,
            a.data,
            a.inicio_at,
            a.fim_at,
            a.cliente_nome,
            a.servico_nome,
            a.valor_cents,
            a.desconto_cents,
            a.forma_pagamento,
            a.status,
            a.origem,
            a.colaborador_id,
            cc.nome AS profissional_nome
       FROM clientes c
       JOIN atendimentos a
         ON a.slot = c.slot
        AND a.tenant_id = c.tenant_id
        AND a.deleted_at IS NULL
        AND a.colaborador_id = $3
        AND a.cliente_telefone_canonico = c.telefone_canonico
       LEFT JOIN clone_colaboradores cc
         ON cc.id = a.colaborador_id AND cc.slot = a.slot
      WHERE c.slot = $1
        AND c.tenant_id = $2
        AND c.id = $4
        AND EXISTS (
          SELECT 1
            FROM atendimentos own_a
           WHERE own_a.slot = c.slot
             AND own_a.tenant_id = c.tenant_id
             AND own_a.deleted_at IS NULL
             AND own_a.colaborador_id = $3
             AND own_a.cliente_telefone_canonico = c.telefone_canonico
        )
      ORDER BY COALESCE(a.inicio_at, a.data::timestamptz) DESC, a.id DESC
      LIMIT $5`,
    [input.slot, input.tenantId, input.colaboradorId, input.clienteId, limit],
  );
  return rows.rows.map(mapHistoricoRow);
}

export async function updateClienteProfileForOwner(
  slot: string,
  tenantId: string,
  clienteId: string,
  patch: UpdateClienteProfileInput,
): Promise<ClienteProfile | null> {
  const sets: string[] = [];
  const params: unknown[] = [slot, tenantId, clienteId];

  if (patch.aniversario_mmdd !== undefined) {
    params.push(trimOrNull(patch.aniversario_mmdd));
    sets.push(`aniversario_mmdd = $${params.length}`);
  }
  if (patch.cidade !== undefined) {
    params.push(trimOrNull(patch.cidade));
    sets.push(`cidade = $${params.length}`);
  }
  if (patch.nota_interna !== undefined) {
    params.push(trimOrNull(patch.nota_interna));
    sets.push(`nota_interna = $${params.length}`);
  }

  if (sets.length === 0) {
    return getClienteProfileForOwner(slot, tenantId, clienteId);
  }

  const result = await query(
    `UPDATE clientes
        SET ${sets.join(', ')}, updated_at = NOW()
      WHERE slot = $1 AND tenant_id = $2 AND id = $3`,
    params,
  );
  if ((result.rowCount ?? 0) === 0) return null;
  return getClienteProfileForOwner(slot, tenantId, clienteId);
}
