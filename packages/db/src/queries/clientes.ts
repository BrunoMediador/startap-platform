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
  nome_personalizado: string | null;
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
  dias_ate_aniversario: string | number;
  proxima_ocorrencia_local_date: string;
  ultimo_profissional_nome: string | null;
  total_count: string;
}

interface ProfileRowRaw {
  id: string;
  nome: string | null;
  nome_personalizado: string | null;
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
  nome_personalizado: string | null;
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
  extends Omit<ClienteProfile, 'nota_interna' | 'nome_personalizado'> {}

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
  dias_ate_aniversario: number;
  proxima_ocorrencia_local_date: string;
  ultimo_profissional_nome: string | null;
}

export interface ClienteAniversariantesResult {
  clientes: ClienteAniversarianteItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface ClienteAniversariantesCalendarioItem {
  id: string;
  nome: string | null;
  telefone_masked: string;
  aniversario_mmdd: string;
  ocorrencia_local_date: string;
  ultimo_profissional_nome: string | null;
}

export interface ClienteAniversariantesCalendarioResult {
  clientes: ClienteAniversariantesCalendarioItem[];
  total: number;
  limit: number;
  offset: number;
  periodo_inicio: string;
  periodo_fim: string;
}

export type ClienteAniversariantesModo = 'proximos' | 'mes';

export type ListClientesAniversariantesInput =
  | {
      slot: string;
      tenantId: string;
      timezone: string;
      mode: 'proximos';
      dias: number;
      limit?: number;
      offset?: number;
    }
  | {
      slot: string;
      tenantId: string;
      timezone: string;
      mode: 'mes';
      mes: number;
      limit?: number;
      offset?: number;
    };

export type ListClientesAniversariantesColaboradorInput =
  | {
      slot: string;
      tenantId: string;
      colaboradorId: number;
      timezone: string;
      mode: 'proximos';
      dias: number;
      limit?: number;
      offset?: number;
    }
  | {
      slot: string;
      tenantId: string;
      colaboradorId: number;
      timezone: string;
      mode: 'mes';
      mes: number;
      limit?: number;
      offset?: number;
    };

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
  nome_personalizado?: string | null;
  aniversario_mmdd?: string | null;
  cidade?: string | null;
  nota_interna?: string | null;
}

export type ClienteUltimoAtendimentoFiltro =
  | 'todos'
  | 'hoje'
  | 'ultimos_7_dias'
  | 'ultimos_30_dias'
  | 'sem_historico'
  | 'periodo';

export type ClienteVisitasFiltro = 'todas' | 'uma' | 'duas_a_cinco' | 'seis_a_dez' | 'onze_ou_mais';
export type ClienteOrdenarPor = 'ultimo_atendimento' | 'visitas';
export type ClienteOrdem = 'asc' | 'desc';

export interface ListClientesFilters {
  /** `search` é legado; novos clientes HTTP devem usar nome e telefone separadamente. */
  search?: string | null;
  nome?: string | null;
  telefone?: string | null;
  ultimoAtendimento?: ClienteUltimoAtendimentoFiltro;
  periodoInicio?: string | null;
  periodoFim?: string | null;
  visitas?: ClienteVisitasFiltro;
  ordenarPor?: ClienteOrdenarPor;
  ordem?: ClienteOrdem;
  limit?: number;
  offset?: number;
}

export interface ClientesResumo {
  total_clientes: number;
  aniversariantes_hoje: number;
  sem_retorno: number;
}

export interface ClienteAvatarTarget {
  telefoneCanonico: string;
  wahaSessao: string;
  wahaShardId: number;
}

export interface SeedClientesResult {
  clientesSeeded: number;
  atendimentosUpdated: number;
}

const VALID_MMDD_REGEX = '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$';
const MONTH_MAX_DAY_SQL = `CASE %MONTH_EXPR%
             WHEN 2 THEN 29
             WHEN 4 THEN 30
             WHEN 6 THEN 30
             WHEN 9 THEN 30
             WHEN 11 THEN 30
             ELSE 31
           END`;
const CANDIDATE_MAX_DAY_SQL = `CASE av.aniversario_mes
                  WHEN 2 THEN CASE
                                  WHEN ((gs % 4 = 0 AND gs % 100 <> 0) OR gs % 400 = 0) THEN 29
                                  ELSE 28
                                END
                  WHEN 4 THEN 30
                  WHEN 6 THEN 30
                  WHEN 9 THEN 30
                  WHEN 11 THEN 30
                  ELSE 31
                END`;

function buildMonthMaxDaySql(monthExpr: string): string {
  return MONTH_MAX_DAY_SQL.replace('%MONTH_EXPR%', monthExpr);
}

const VALID_BIRTHDAY_CTES_SQL = `
     aniversarios_candidatos AS (
       SELECT c.id,
              c.slot,
              c.tenant_id,
              COALESCE(c.nome_personalizado, c.nome) AS nome,
              c.telefone_canonico,
              c.aniversario_mmdd,
              split_part(c.aniversario_mmdd, '-', 1)::int AS aniversario_mes,
              split_part(c.aniversario_mmdd, '-', 2)::int AS aniversario_dia
         FROM clientes c
        WHERE c.slot = $1
          AND c.tenant_id = $2
          AND c.aniversario_mmdd IS NOT NULL
          AND c.aniversario_mmdd ~ '${VALID_MMDD_REGEX}'
     ),
     aniversarios_validos AS (
       SELECT ac.id,
              ac.slot,
              ac.tenant_id,
              ac.nome,
              ac.telefone_canonico,
              ac.aniversario_mmdd,
              ac.aniversario_mes,
              ac.aniversario_dia
         FROM aniversarios_candidatos ac
        WHERE ac.aniversario_dia <= ${buildMonthMaxDaySql('ac.aniversario_mes')}
     ),
`;

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function trimNfcOrNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').normalize('NFC').trim();
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

function normalizeRankingPaging(
  limit?: number,
  offset?: number,
): { limit: number; offset: number } {
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

function normalizeListFilters(input: ListClientesFilters) {
  const legacy = normalizeSearch(input.search);
  const nome = normalizeSearch(input.nome);
  const telefone = normalizeSearch(input.telefone);
  return {
    legacy,
    nomeLike: nome.likeText,
    telefoneLike: telefone.likeDigits,
    ultimoAtendimento: input.ultimoAtendimento ?? 'todos',
    periodoInicio: input.periodoInicio ?? null,
    periodoFim: input.periodoFim ?? null,
    visitas: input.visitas ?? 'todas',
    ordenarPor: input.ordenarPor ?? 'ultimo_atendimento',
    ordem: input.ordem ?? 'desc',
  } as const;
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
    dias_ate_aniversario: Number(row.dias_ate_aniversario),
    proxima_ocorrencia_local_date: row.proxima_ocorrencia_local_date,
    ultimo_profissional_nome: row.ultimo_profissional_nome,
  };
}

function mapCalendarioAniversarianteRow(
  row: AniversarianteRowRaw,
): ClienteAniversariantesCalendarioItem {
  return {
    id: row.id,
    nome: row.nome,
    telefone_masked: phoneHint(row.telefone_canonico),
    aniversario_mmdd: row.aniversario_mmdd,
    ocorrencia_local_date: row.proxima_ocorrencia_local_date,
    ultimo_profissional_nome: row.ultimo_profissional_nome,
  };
}

function mapProfileRow(row: ProfileRowRaw): ClienteProfile {
  return {
    id: row.id,
    nome: row.nome,
    nome_personalizado: row.nome_personalizado,
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
    [input.tenantId, input.slot, phone.canonical, phone.rawDigits, trimOrNull(input.clienteNome)],
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
      const raws = canonicals.map(
        (canonical) => byCanonical.get(canonical)?.rawDigits ?? canonical,
      );
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

const LIST_CLIENTES_SQL = `
  SELECT *
    FROM (
       SELECT c.id,
              COALESCE(c.nome_personalizado, c.nome) AS nome,
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
                 MAX(e.atendimento_at) AS ultima_interacao_at,
                 (ARRAY_AGG(cc.nome ORDER BY e.atendimento_at DESC, e.id DESC))[1]
                   AS ultimo_profissional_nome
            FROM (
              SELECT a.id, a.colaborador_id, COALESCE(a.fim_at, a.inicio_at) AS atendimento_at
                FROM atendimentos a
               WHERE a.slot = c.slot AND a.tenant_id = c.tenant_id
                 AND a.deleted_at IS NULL AND a.status <> 'cancelado'
                 AND a.origem = 'agenda' AND a.cliente_telefone_canonico = c.telefone_canonico
                 AND COALESCE(a.fim_at, a.inicio_at) <= NOW()
              UNION ALL
              SELECT a.id, a.colaborador_id, (a.data::timestamp AT TIME ZONE $3) AS atendimento_at
                FROM atendimentos a
               WHERE a.slot = c.slot AND a.tenant_id = c.tenant_id
                 AND a.deleted_at IS NULL AND a.status <> 'cancelado'
                 AND a.origem = 'manual' AND a.cliente_telefone_canonico = c.telefone_canonico
                 AND a.data <= (NOW() AT TIME ZONE $3)::date
              /* COLABORADOR_ATENDIMENTOS */
            ) e
            LEFT JOIN clone_colaboradores cc ON cc.id = e.colaborador_id AND cc.slot = c.slot
        ) stats ON TRUE
       WHERE c.slot = $1 AND c.tenant_id = $2
         /* COLABORADOR_CARTEIRA */
         AND ($4::text IS NULL OR lower(COALESCE(c.nome_personalizado, c.nome, '')) LIKE $4)
         AND ($5::text IS NULL OR (c.telefone_raw LIKE $5 OR c.telefone_canonico LIKE $5))
         AND ($6::text IS NULL OR lower(COALESCE(c.nome_personalizado, c.nome, '')) LIKE $6
              OR ($7::text IS NOT NULL AND (c.telefone_raw LIKE $7 OR c.telefone_canonico LIKE $7)))
         AND (
           $8 = 'todos'
           OR ($8 = 'hoje' AND (stats.ultima_interacao_at AT TIME ZONE $3)::date = (NOW() AT TIME ZONE $3)::date)
           OR ($8 = 'ultimos_7_dias' AND (stats.ultima_interacao_at AT TIME ZONE $3)::date BETWEEN (NOW() AT TIME ZONE $3)::date - 6 AND (NOW() AT TIME ZONE $3)::date)
           OR ($8 = 'ultimos_30_dias' AND (stats.ultima_interacao_at AT TIME ZONE $3)::date BETWEEN (NOW() AT TIME ZONE $3)::date - 29 AND (NOW() AT TIME ZONE $3)::date)
           OR ($8 = 'sem_historico' AND COALESCE(stats.total_atendimentos, 0) = 0)
           OR ($8 = 'periodo' AND (stats.ultima_interacao_at AT TIME ZONE $3)::date BETWEEN $9::date AND $10::date)
         )
         AND (
           $11 = 'todas'
           OR ($11 = 'uma' AND COALESCE(stats.total_atendimentos, 0) = 1)
           OR ($11 = 'duas_a_cinco' AND COALESCE(stats.total_atendimentos, 0) BETWEEN 2 AND 5)
           OR ($11 = 'seis_a_dez' AND COALESCE(stats.total_atendimentos, 0) BETWEEN 6 AND 10)
           OR ($11 = 'onze_ou_mais' AND COALESCE(stats.total_atendimentos, 0) >= 11)
         )
       ORDER BY
         CASE WHEN $12 = 'ultimo_atendimento' AND $13 = 'desc' THEN stats.ultima_interacao_at END DESC NULLS LAST,
         CASE WHEN $12 = 'ultimo_atendimento' AND $13 = 'asc' THEN stats.ultima_interacao_at END ASC NULLS LAST,
         CASE WHEN $12 = 'visitas' AND $13 = 'desc' THEN COALESCE(stats.total_atendimentos, 0) END DESC,
         CASE WHEN $12 = 'visitas' AND $13 = 'asc' THEN COALESCE(stats.total_atendimentos, 0) END ASC,
         c.updated_at DESC, c.id DESC
    ) page
   LIMIT $14 OFFSET $15`;

async function listClientes(
  input: ListClientesFilters & {
    slot: string;
    tenantId: string;
    timezone: string;
    colaboradorId?: number;
  },
): Promise<ClienteListResult> {
  const { limit, offset } = normalizePaging(input.limit, input.offset);
  const filters = normalizeListFilters(input);
  const isColaborador = input.colaboradorId !== undefined;
  const sql = LIST_CLIENTES_SQL.replaceAll(
    '/* COLABORADOR_ATENDIMENTOS */',
    isColaborador ? 'AND a.colaborador_id = $16' : '',
  ).replace(
    '/* COLABORADOR_CARTEIRA */',
    isColaborador
      ? `AND EXISTS (
             SELECT 1 FROM atendimentos own_a
              WHERE own_a.slot = c.slot AND own_a.tenant_id = c.tenant_id
                AND own_a.deleted_at IS NULL AND own_a.status <> 'cancelado'
                AND own_a.colaborador_id = $16
                AND own_a.cliente_telefone_canonico = c.telefone_canonico
           )`
      : '',
  );
  const rows = await query<ListRowRaw>(sql, [
    input.slot,
    input.tenantId,
    input.timezone,
    filters.nomeLike,
    filters.telefoneLike,
    filters.legacy.likeText,
    filters.legacy.likeDigits,
    filters.ultimoAtendimento,
    filters.periodoInicio,
    filters.periodoFim,
    filters.visitas,
    filters.ordenarPor,
    filters.ordem,
    limit,
    offset,
    input.colaboradorId ?? null,
  ]);
  return {
    clientes: rows.rows.map(mapListRow),
    total: Number(rows.rows[0]?.total_count ?? 0),
    limit,
    offset,
  };
}

export async function listClientesForOwner(
  input: ListClientesFilters & {
    slot: string;
    tenantId: string;
    timezone: string;
  },
): Promise<ClienteListResult> {
  return listClientes(input);
}

export async function listClientesForColaborador(
  input: ListClientesFilters & {
    slot: string;
    tenantId: string;
    colaboradorId: number;
    timezone: string;
  },
): Promise<ClienteListResult> {
  return listClientes(input);
}

interface ResumoRowRaw {
  total_clientes: string | number;
  aniversariantes_hoje: string | number;
  sem_retorno: string | number;
}

export async function getClientesResumo(input: {
  slot: string;
  tenantId: string;
  timezone: string;
  colaboradorId?: number;
}): Promise<ClientesResumo> {
  const isColaborador = input.colaboradorId !== undefined;
  const carteiraSql = isColaborador
    ? `AND EXISTS (
         SELECT 1 FROM atendimentos own_a
          WHERE own_a.slot = c.slot AND own_a.tenant_id = c.tenant_id
            AND own_a.deleted_at IS NULL AND own_a.colaborador_id = $4
            AND own_a.cliente_telefone_canonico = c.telefone_canonico
       )`
    : '';
  const atendimentoScopeSql = isColaborador ? 'AND a.colaborador_id = $4' : '';
  const rows = await query<ResumoRowRaw>(
    `SELECT COUNT(*)::bigint AS total_clientes,
            COUNT(*) FILTER (
              WHERE c.aniversario_mmdd = to_char((NOW() AT TIME ZONE $3)::date, 'MM-DD')
            )::bigint AS aniversariantes_hoje,
            COUNT(*) FILTER (
              WHERE EXISTS (
                SELECT 1 FROM atendimentos a
                 WHERE a.slot = c.slot AND a.tenant_id = c.tenant_id
                   AND a.deleted_at IS NULL AND a.status <> 'cancelado'
                   AND a.cliente_telefone_canonico = c.telefone_canonico
                   ${atendimentoScopeSql}
                   AND (
                     (a.origem = 'agenda' AND COALESCE(a.fim_at, a.inicio_at) <= NOW())
                     OR (a.origem = 'manual' AND a.data <= (NOW() AT TIME ZONE $3)::date)
                   )
              )
            )::bigint AS sem_retorno
       FROM clientes c
      WHERE c.slot = $1 AND c.tenant_id = $2
        ${carteiraSql}`,
    [input.slot, input.tenantId, input.timezone, input.colaboradorId ?? null],
  );
  const row = rows.rows[0];
  return {
    total_clientes: Number(row?.total_clientes ?? 0),
    aniversariantes_hoje: Number(row?.aniversariantes_hoje ?? 0),
    sem_retorno: Number(row?.sem_retorno ?? 0),
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
              COALESCE(c.nome_personalizado, c.nome) AS nome,
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
            COALESCE(c.nome_personalizado, c.nome) AS nome,
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
              COALESCE(c.nome_personalizado, c.nome) AS nome,
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
              COALESCE(c.nome_personalizado, c.nome) AS nome,
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
 * Lista read-only de aniversariantes do CRM. A consulta valida MM-DD legado
 * antes de gerar a próxima ocorrência real, então `02-31` nunca explode em 500
 * e `02-29` segue válido com a próxima data bissexta correspondente.
 */
export async function listClientesAniversariantesForOwner(
  input: ListClientesAniversariantesInput,
): Promise<ClienteAniversariantesResult> {
  const { limit, offset } = normalizeRankingPaging(input.limit, input.offset);
  const filterSql =
    input.mode === 'proximos'
      ? 'AND base.dias_ate_aniversario <= $4'
      : 'AND base.aniversario_mes = $4';
  const orderSql =
    input.mode === 'proximos'
      ? 'base.dias_ate_aniversario ASC, base.aniversario_mmdd ASC, base.id ASC'
      : "split_part(base.aniversario_mmdd, '-', 2)::int ASC, base.id ASC";
  const rows = await query<AniversarianteRowRaw>(
    `WITH contexto AS (
       SELECT (NOW() AT TIME ZONE $3)::date AS hoje_local_date,
              EXTRACT(YEAR FROM (NOW() AT TIME ZONE $3))::int AS ano_atual
     ),
     ${VALID_BIRTHDAY_CTES_SQL}
     base AS (
       SELECT av.id,
              av.nome,
              av.telefone_canonico,
              av.aniversario_mmdd,
              av.aniversario_mes,
              (next_occ.proxima_ocorrencia_local_date - ctx.hoje_local_date)::int AS dias_ate_aniversario,
              to_char(next_occ.proxima_ocorrencia_local_date, 'YYYY-MM-DD') AS proxima_ocorrencia_local_date,
              stats.ultimo_profissional_nome
         FROM aniversarios_validos av
         CROSS JOIN contexto ctx
         JOIN LATERAL (
           SELECT candidate_date AS proxima_ocorrencia_local_date
             FROM (
               SELECT CASE
                        WHEN av.aniversario_dia <= ${CANDIDATE_MAX_DAY_SQL}
                        THEN concat(
                          gs::text,
                          '-',
                          lpad(av.aniversario_mes::text, 2, '0'),
                          '-',
                          lpad(av.aniversario_dia::text, 2, '0')
                        )::date
                        ELSE NULL
                      END AS candidate_date
                 FROM generate_series(ctx.ano_atual, ctx.ano_atual + 8) AS gs
             ) years
            WHERE candidate_date IS NOT NULL
              AND candidate_date >= ctx.hoje_local_date
            ORDER BY candidate_date ASC
            LIMIT 1
         ) AS next_occ ON TRUE
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
          WHERE a.slot = av.slot
            AND a.tenant_id = av.tenant_id
            AND a.deleted_at IS NULL
            AND a.cliente_telefone_canonico = av.telefone_canonico
       ) AS stats ON TRUE
     )
     SELECT base.id,
            base.nome,
            base.telefone_canonico,
            base.aniversario_mmdd,
            base.dias_ate_aniversario,
            base.proxima_ocorrencia_local_date,
            base.ultimo_profissional_nome,
            COUNT(*) OVER()::bigint AS total_count
       FROM base
      WHERE 1 = 1
        ${filterSql}
      ORDER BY ${orderSql}
      LIMIT $5 OFFSET $6`,
    [
      input.slot,
      input.tenantId,
      input.timezone,
      input.mode === 'proximos' ? input.dias : input.mes,
      limit,
      offset,
    ],
  );

  return {
    clientes: rows.rows.map(mapAniversarianteRow),
    total: Number(rows.rows[0]?.total_count ?? 0),
    limit,
    offset,
  };
}

export async function listClientesAniversariantesForColaborador(
  input: ListClientesAniversariantesColaboradorInput,
): Promise<ClienteAniversariantesResult> {
  const { limit, offset } = normalizeRankingPaging(input.limit, input.offset);
  const filterSql =
    input.mode === 'proximos'
      ? 'AND base.dias_ate_aniversario <= $5'
      : 'AND base.aniversario_mes = $5';
  const orderSql =
    input.mode === 'proximos'
      ? 'base.dias_ate_aniversario ASC, base.aniversario_mmdd ASC, base.id ASC'
      : "split_part(base.aniversario_mmdd, '-', 2)::int ASC, base.id ASC";
  const rows = await query<AniversarianteRowRaw>(
    `WITH contexto AS (
       SELECT (NOW() AT TIME ZONE $4)::date AS hoje_local_date,
              EXTRACT(YEAR FROM (NOW() AT TIME ZONE $4))::int AS ano_atual
     ),
     ${VALID_BIRTHDAY_CTES_SQL}
     base AS (
       SELECT av.id,
              av.nome,
              av.telefone_canonico,
              av.aniversario_mmdd,
              av.aniversario_mes,
              (next_occ.proxima_ocorrencia_local_date - ctx.hoje_local_date)::int AS dias_ate_aniversario,
              to_char(next_occ.proxima_ocorrencia_local_date, 'YYYY-MM-DD') AS proxima_ocorrencia_local_date,
              stats.ultimo_profissional_nome
         FROM aniversarios_validos av
         CROSS JOIN contexto ctx
         JOIN LATERAL (
           SELECT candidate_date AS proxima_ocorrencia_local_date
             FROM (
               SELECT CASE
                        WHEN av.aniversario_dia <= ${CANDIDATE_MAX_DAY_SQL}
                        THEN concat(
                          gs::text,
                          '-',
                          lpad(av.aniversario_mes::text, 2, '0'),
                          '-',
                          lpad(av.aniversario_dia::text, 2, '0')
                        )::date
                        ELSE NULL
                      END AS candidate_date
                 FROM generate_series(ctx.ano_atual, ctx.ano_atual + 8) AS gs
             ) years
            WHERE candidate_date IS NOT NULL
              AND candidate_date >= ctx.hoje_local_date
            ORDER BY candidate_date ASC
            LIMIT 1
         ) AS next_occ ON TRUE
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
          WHERE a.slot = av.slot
            AND a.tenant_id = av.tenant_id
            AND a.deleted_at IS NULL
            AND a.colaborador_id = $3
            AND a.cliente_telefone_canonico = av.telefone_canonico
       ) AS stats ON TRUE
      WHERE EXISTS (
          SELECT 1
            FROM atendimentos own_a
           WHERE own_a.slot = av.slot
             AND own_a.tenant_id = av.tenant_id
             AND own_a.deleted_at IS NULL
             AND own_a.colaborador_id = $3
             AND own_a.cliente_telefone_canonico = av.telefone_canonico
        )
     )
     SELECT base.id,
            base.nome,
            base.telefone_canonico,
            base.aniversario_mmdd,
            base.dias_ate_aniversario,
            base.proxima_ocorrencia_local_date,
            base.ultimo_profissional_nome,
            COUNT(*) OVER()::bigint AS total_count
       FROM base
      WHERE 1 = 1
        ${filterSql}
      ORDER BY ${orderSql}
      LIMIT $6 OFFSET $7`,
    [
      input.slot,
      input.tenantId,
      input.colaboradorId,
      input.timezone,
      input.mode === 'proximos' ? input.dias : input.mes,
      limit,
      offset,
    ],
  );

  return {
    clientes: rows.rows.map(mapAniversarianteRow),
    total: Number(rows.rows[0]?.total_count ?? 0),
    limit,
    offset,
  };
}

interface CalendarioAniversarioRowRaw extends AniversarianteRowRaw {
  periodo_inicio: string;
  periodo_fim: string;
}

/**
 * Calendário ancorado em data local já validada na rota. A âncora não carrega fuso:
 * o timezone do tenant só é resolvido antes, no servidor; isto evita o navegador
 * deslocar um aniversário ao serializar meia-noite em UTC.
 */
export async function listClientesAniversariantesCalendario(input: {
  slot: string;
  tenantId: string;
  timezone: string;
  anchor: string;
  view: 'semana' | 'mes';
  colaboradorId?: number;
  limit?: number;
  offset?: number;
}): Promise<ClienteAniversariantesCalendarioResult> {
  const { limit, offset } = normalizeRankingPaging(input.limit, input.offset);
  const rows = await query<CalendarioAniversarioRowRaw>(
    `WITH contexto AS (
       SELECT CASE WHEN $5 = 'semana' THEN date_trunc('week', $4::date)::date
                   ELSE date_trunc('month', $4::date)::date END AS periodo_inicio,
              CASE WHEN $5 = 'semana' THEN (date_trunc('week', $4::date)::date + 6)
                   ELSE (date_trunc('month', $4::date) + INTERVAL '1 month - 1 day')::date END AS periodo_fim
     ),
     ${VALID_BIRTHDAY_CTES_SQL}
     ocorrencias AS (
       SELECT av.id, av.slot, av.tenant_id, av.nome, av.telefone_canonico,
              av.aniversario_mmdd,
              candidate.ocorrencia_local_date,
              ctx.periodo_inicio, ctx.periodo_fim
         FROM aniversarios_validos av
         CROSS JOIN contexto ctx
         CROSS JOIN LATERAL (
           SELECT concat(gs::text, '-', lpad(av.aniversario_mes::text, 2, '0'), '-',
                         lpad(av.aniversario_dia::text, 2, '0'))::date AS ocorrencia_local_date
             FROM generate_series(
                    EXTRACT(YEAR FROM ctx.periodo_inicio)::int - 1,
                    EXTRACT(YEAR FROM ctx.periodo_fim)::int + 1
                  ) gs
            WHERE av.aniversario_dia <= ${CANDIDATE_MAX_DAY_SQL}
         ) candidate
        WHERE candidate.ocorrencia_local_date BETWEEN ctx.periodo_inicio AND ctx.periodo_fim
     ),
     base AS (
       SELECT o.id, o.nome, o.telefone_canonico, o.aniversario_mmdd,
              to_char(o.ocorrencia_local_date, 'YYYY-MM-DD') AS proxima_ocorrencia_local_date,
              to_char(o.periodo_inicio, 'YYYY-MM-DD') AS periodo_inicio,
              to_char(o.periodo_fim, 'YYYY-MM-DD') AS periodo_fim,
              stats.ultimo_profissional_nome
         FROM ocorrencias o
         LEFT JOIN LATERAL (
           SELECT (ARRAY_AGG(cc.nome ORDER BY COALESCE(a.inicio_at, a.data::timestamptz) DESC, a.id DESC))[1]
                    AS ultimo_profissional_nome
             FROM atendimentos a
             LEFT JOIN clone_colaboradores cc ON cc.id = a.colaborador_id AND cc.slot = a.slot
            WHERE a.slot = o.slot AND a.tenant_id = o.tenant_id
              AND a.deleted_at IS NULL AND a.cliente_telefone_canonico = o.telefone_canonico
              AND ($6::bigint IS NULL OR a.colaborador_id = $6)
         ) stats ON TRUE
        WHERE ($6::bigint IS NULL OR EXISTS (
          SELECT 1 FROM atendimentos own_a
           WHERE own_a.slot = o.slot AND own_a.tenant_id = o.tenant_id
             AND own_a.deleted_at IS NULL AND own_a.colaborador_id = $6
             AND own_a.cliente_telefone_canonico = o.telefone_canonico
        ))
     )
     SELECT base.*, 0::int AS dias_ate_aniversario, COUNT(*) OVER()::bigint AS total_count
       FROM base
      ORDER BY proxima_ocorrencia_local_date ASC, nome ASC NULLS LAST, id ASC
      LIMIT $7 OFFSET $8`,
    [
      input.slot,
      input.tenantId,
      input.timezone,
      input.anchor,
      input.view,
      input.colaboradorId ?? null,
      limit,
      offset,
    ],
  );
  const first = rows.rows[0];
  const anchor = new Date(`${input.anchor}T12:00:00Z`);
  const fallbackStart =
    input.view === 'semana'
      ? new Date(anchor.valueOf() - ((anchor.getUTCDay() + 6) % 7) * 86_400_000)
      : new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const fallbackEnd =
    input.view === 'semana'
      ? new Date(fallbackStart.valueOf() + 6 * 86_400_000)
      : new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0));
  const formatDate = (value: Date) => value.toISOString().slice(0, 10);
  return {
    clientes: rows.rows.map(mapCalendarioAniversarianteRow),
    total: Number(first?.total_count ?? 0),
    limit,
    offset,
    periodo_inicio: first?.periodo_inicio ?? formatDate(fallbackStart),
    periodo_fim: first?.periodo_fim ?? formatDate(fallbackEnd),
  };
}

export async function getClienteProfileForOwner(
  slot: string,
  tenantId: string,
  clienteId: string,
): Promise<ClienteProfile | null> {
  const rows = await query<ProfileRowRaw>(
    `SELECT c.id,
            COALESCE(c.nome_personalizado, c.nome) AS nome,
            c.nome_personalizado,
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

/** Resolve o alvo internamente; telefone/sessão nunca atravessam a resposta HTTP. */
export async function getClienteAvatarTargetForOwner(
  slot: string,
  tenantId: string,
  clienteId: string,
): Promise<ClienteAvatarTarget | null> {
  const rows = await query<{
    telefone_canonico: string;
    waha_sessao: string | null;
    waha_shard_id: number | string | null;
  }>(
    `SELECT c.telefone_canonico, fc.waha_sessao, fc.waha_shard_id
       FROM clientes c
       JOIN flow_clones fc ON fc.slot = c.slot
      WHERE c.slot = $1 AND c.tenant_id = $2 AND c.id = $3
        AND fc.tenant_id = c.tenant_id
      LIMIT 1`,
    [slot, tenantId, clienteId],
  );
  const row = rows.rows[0];
  if (!row?.waha_sessao) return null;
  return {
    telefoneCanonico: row.telefone_canonico,
    wahaSessao: row.waha_sessao,
    wahaShardId: Number(row.waha_shard_id ?? 0),
  };
}

export async function getClienteProfileForColaborador(
  slot: string,
  tenantId: string,
  colaboradorId: number,
  clienteId: string,
): Promise<ClienteProfileColaborador | null> {
  const rows = await query<ProfileRowRaw>(
    `SELECT c.id,
            COALESCE(c.nome_personalizado, c.nome) AS nome,
            c.nome_personalizado,
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
  const {
    nota_interna: _ignored,
    nome_personalizado: _personalizadoIgnored,
    ...withoutNote
  } = profile;
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
  if (patch.nome_personalizado !== undefined) {
    params.push(trimNfcOrNull(patch.nome_personalizado));
    sets.push(`nome_personalizado = $${params.length}`);
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
