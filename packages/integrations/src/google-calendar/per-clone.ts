/**
 * per-clone.ts — resolve o GoogleCalendarClient correto para um slot (clone ou matriz).
 *
 * REGRA DE ROTEAMENTO (dois caminhos distintos):
 *
 * 1. CLONES (slot começa com "clone_"):
 *    Lookup SOMENTE em flow_clones. Se não achar gcal_status='active' +
 *    gcal_credentials_json + gcal_calendar_id, retorna null.
 *    SEM fallback para bot_config — evita que clone sem GCal próprio use
 *    silenciosamente a agenda da matriz (vazamento cross-tenant inaceitável).
 *    Cirilo e Ricardo continuam isolados.
 *
 * 2. MATRIZES / BOTS INTERNOS (slot NÃO começa com "clone_"):
 *    Lookup em bot_config WHERE slot=$1. Matrizes (teste_barbearia,
 *    teste_vendas_barbearia, etc.) e bots internos (startap) têm GCal
 *    configurado diretamente nessa tabela. Não há risco cross-tenant porque
 *    bot_config é keyed por slot — não existe "outra fonte" que vaze.
 *    Se gcal_status != 'active' ou creds ausentes, retorna null normalmente.
 *
 * Cache em memória de 5 minutos por slot evita SELECT a cada turno de chat.
 * Invalidação acontece quando recebemos erro 401/403 do Google (ver invalidateGcalCache).
 *
 * ── ESTABELECIMENTO (ADR 0023/0024, Fase A) ─────────────────────────────────────
 *  `getGcalsForSlot(slot)` (PLURAL) resolve as agendas dos COLABORADORES de um
 *  estabelecimento. É SEMPRE 'clone_' (lê de flow_clones + clone_colaboradores) e
 *  só é alcançado com `product_type='estabelecimento'` E a flag
 *  ESTABELECIMENTO_ENABLED ligada. Diferente do caminho individual:
 *    - a SELECT projeta tenant_id (ADR 0024 §4) — depende de 045/048 em flow_clones;
 *    - o cache é chaveado por (slot, colaboradorId) e cada entry guarda
 *      { slot, colaboradorId, tenantId, client, expiresAt };
 *    - uma entry cujo tenant_id/slot não bate com o pedido é MISS (re-lê), nunca
 *      devolvida → sem vazamento cross-tenant nem entre colaboradores homônimos.
 *  O caminho individual (getGcalForSlot, abaixo) fica BYTE-A-BYTE inalterado e
 *  100% independente da flag.
 */
import { decryptSecret } from '@startap/core';
import { query } from '@startap/db';
import { GoogleCalendarClient } from './client.js';

interface CacheEntry {
  client: GoogleCalendarClient | null;
  fingerprint: string | null;
  expiresAt: number;
}

// Chave: slot → entry. A consulta ao banco continua necessária em toda resolução
// para detectar imediatamente troca de calendar/credencial; o TTL só reaproveita
// a instância já construída quando a configuração ainda é byte-idêntica.
const cache = new Map<string, CacheEntry>();

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

interface GcalRow {
  gcal_credentials_json: string | null;
  gcal_calendar_id: string | null;
  gcal_status: string | null;
}

/**
 * Retorna GoogleCalendarClient bound ao slot, ou null se GCal não configurado.
 *
 * - Clones (slot começa com "clone_"): busca em flow_clones. Sem fallback.
 * - Matrizes/bots internos (demais slots): busca em bot_config.
 *
 * Retorna null se gcal_status != 'active' ou creds ausentes (em qualquer caminho).
 */
export async function getGcalForSlot(slot: string): Promise<GoogleCalendarClient | null> {
  const now = Date.now();

  const isClone = slot.startsWith('clone_');

  let row: GcalRow | undefined;

  if (isClone) {
    // Clones: lookup exclusivo em flow_clones — sem fallback para bot_config.
    // Garante isolamento: clone sem GCal próprio nunca usa agenda da matriz.
    const result = await query<GcalRow>(
      `SELECT gcal_credentials_json, gcal_calendar_id, gcal_status
       FROM flow_clones
       WHERE slot = $1
       LIMIT 1`,
      [slot],
    );
    row = result.rows[0];
  } else {
    // Matrizes e bots internos: lookup em bot_config.
    // Não há risco cross-tenant — bot_config é keyed por slot único.
    const result = await query<GcalRow>(
      `SELECT gcal_credentials_json, gcal_calendar_id, gcal_status
       FROM bot_config
       WHERE slot = $1
       LIMIT 1`,
      [slot],
    );
    row = result.rows[0];
  }

  const fingerprint = row
    ? `${row.gcal_status ?? ''}\u0000${row.gcal_calendar_id ?? ''}\u0000${row.gcal_credentials_json ?? ''}`
    : null;
  const cached = cache.get(slot);
  if (cached && cached.expiresAt > now && cached.fingerprint === fingerprint) {
    return cached.client;
  }

  if (!row || row.gcal_status !== 'active' || !row.gcal_credentials_json || !row.gcal_calendar_id) {
    cache.set(slot, { client: null, fingerprint, expiresAt: now + CACHE_TTL_MS });
    return null;
  }

  const client = new GoogleCalendarClient({
    credentialsJson: decryptSecret(row.gcal_credentials_json),
    calendarId: row.gcal_calendar_id,
  });

  cache.set(slot, { client, fingerprint, expiresAt: now + CACHE_TTL_MS });
  return client;
}

/**
 * Invalida a entrada de cache para o slot informado.
 * Deve ser chamado quando operações gcal retornam 401/403, forçando
 * re-leitura das credenciais no próximo turno.
 */
export function invalidateGcalCache(slot: string): void {
  cache.delete(slot);
}

// ════════════════════════════════════════════════════════════════════════════════
// ESTABELECIMENTO — resolvedor por colaborador (ADR 0023/0024, Fase A)
//
// Gated por product_type='estabelecimento' E flag ESTABELECIMENTO_ENABLED.
// 100% separado do caminho individual acima (cache, SELECT e tipos próprios) —
// o individual não é tocado por nada daqui.
// ════════════════════════════════════════════════════════════════════════════════

/** Flag de env. Default OFF: sem ela ligada, getGcalsForSlot sempre retorna []. */
function isEstabelecimentoEnabled(): boolean {
  return process.env.ESTABELECIMENTO_ENABLED === 'true';
}

/**
 * Uma agenda de colaborador resolvida: id curto estável + nome + calendarId +
 * client bound àquela agenda. O LLM nunca recebe calendarId cru — só colaboradorId,
 * validado server-side contra clone_colaboradores do slot/tenant (ADR 0024 §4).
 */
export interface ColaboradorGcal {
  colaboradorId: number;
  nome: string;
  calendarId: string;
  client: GoogleCalendarClient;
  /**
   * Serviços que ESTE colaborador faz (clone_colaboradores.servicos, migration 057 —
   * array de servico_nome que espelha flow_clones.servicos[].nome). `[]` = não
   * especificado pelo dono → o caller decide o fallback (oferecer os serviços globais
   * do clone). Usado para montar o bloco [PROFISSIONAIS] por colaborador e validar
   * serviço×profissional no inserir_agendamento (server-side).
   */
  servicos: string[];
}

/**
 * Entry de cache do resolvedor de colaborador. Carrega slot + tenantId além do
 * client — toda leitura quente confere (slot, tenantId) antes de devolver. ADR 0024 §4.
 */
interface ColabCacheEntry {
  slot: string;
  colaboradorId: number;
  tenantId: string;
  nome: string;
  servicos: string[];
  fingerprint: string;
  client: GoogleCalendarClient;
  expiresAt: number;
}

/** Chave: `${slot}::${colaboradorId}` → entry. Separado do cache individual. */
const colabCache = new Map<string, ColabCacheEntry>();

function colabCacheKey(slot: string, colaboradorId: number): string {
  return `${slot}::${colaboradorId}`;
}

/**
 * Linha do JOIN flow_clones × clone_colaboradores. A SELECT PROJETA tenant_id
 * (ADR 0024 §4 — adição; o caminho individual não projeta). product_type vem de
 * flow_clones para o gating server-side.
 */
interface EstabColabRow {
  product_type: string | null;
  tenant_id: string | null;
  clone_credentials_json: string | null;
  colaborador_id: string; // BIGSERIAL chega como string no driver pg
  nome: string;
  gcal_calendar_id: string | null;
  gcal_status: string | null;
  // servicos do colaborador (jsonb, migration 057). O driver pg já desserializa
  // jsonb → array JS; pode vir null se a coluna não existir (pré-057) → [].
  servicos: unknown;
}

/** Normaliza o jsonb `servicos` do colaborador para string[] (trim + descarta vazio). */
function parseColaboradorServicos(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const s = String(item ?? '').trim();
    if (s) out.push(s);
  }
  return out;
}

/**
 * Resolve as agendas dos COLABORADORES de um estabelecimento (PLURAL).
 *
 * Gating estrito (ADR 0023 §3):
 *  - flag ESTABELECIMENTO_ENABLED OFF  → retorna [] (caminho novo nunca alcançado).
 *  - slot NÃO 'clone_'                 → retorna [] (estabelecimento é sempre clone_).
 *  - product_type != 'estabelecimento' → retorna [] (individual nunca entra aqui).
 *
 * Para um estabelecimento válido, retorna a lista de colaboradores ATIVOS com
 * GCal 'active' e calendarId presente. A credencial é a do CLONE (flow_clones,
 * 1 Service Account por cliente — ADR 0024 §2); cada colaborador tem seu calendarId.
 *
 * ISOLAMENTO (ADR 0024 §4):
 *  - a SELECT é escopada por slot E filtra apenas colaboradores daquele slot;
 *  - cada entry de cache guarda (slot, tenantId) e é descartada (MISS) se não bate
 *    com o pedido — sem vazamento cross-tenant nem entre homônimos/slots trocados.
 */
export async function getGcalsForSlot(slot: string): Promise<ColaboradorGcal[]> {
  // Gate 1: flag de env. Sem ela, o caminho novo é inalcançável.
  if (!isEstabelecimentoEnabled()) {
    return [];
  }

  // Gate 2: estabelecimento é SEMPRE 'clone_' (lê de flow_clones, nunca bot_config).
  if (!slot.startsWith('clone_')) {
    return [];
  }

  // SELECT projeta tenant_id (ADR 0024 §4) + product_type (gating server-side).
  // JOIN: a credencial é do clone (flow_clones); o calendarId é do colaborador.
  // Filtra colaboradores ativos/ativos do GCal já no banco.
  const result = await query<EstabColabRow>(
    `SELECT fc.product_type            AS product_type,
            fc.tenant_id               AS tenant_id,
            fc.gcal_credentials_json   AS clone_credentials_json,
            cc.id                      AS colaborador_id,
            cc.nome                    AS nome,
            cc.gcal_calendar_id        AS gcal_calendar_id,
            cc.gcal_status             AS gcal_status,
            cc.servicos                AS servicos
       FROM flow_clones fc
       JOIN clone_colaboradores cc ON cc.slot = fc.slot AND cc.tenant_id = fc.tenant_id
      WHERE fc.slot = $1
        AND cc.ativo = TRUE
      ORDER BY cc.ordem ASC, cc.id ASC`,
    [slot],
  );

  const rows = result.rows;
  if (rows.length === 0) {
    return [];
  }

  // Gate 3: product_type. Vem repetido em cada linha (mesmo clone). Individual
  // (ou qualquer coisa != 'estabelecimento') nunca produz colaborador resolvido.
  const productType = rows[0].product_type;
  if (productType !== 'estabelecimento') {
    return [];
  }

  const cloneCreds = rows[0].clone_credentials_json;
  const tenantId = rows[0].tenant_id;
  if (!cloneCreds || !tenantId) {
    // Sem credencial do clone ou sem tenant_id resolvível → nada a devolver.
    return [];
  }

  const now = Date.now();
  const out: ColaboradorGcal[] = [];

  for (const row of rows) {
    if (row.gcal_status !== 'active' || !row.gcal_calendar_id) {
      continue; // colaborador sem agenda ativa não entra (pending/invalid/disabled).
    }

    const colaboradorId = Number(row.colaborador_id);
    const servicos = parseColaboradorServicos(row.servicos);
    const fingerprint = `${cloneCreds}\u0000${row.gcal_calendar_id}`;
    const key = colabCacheKey(slot, colaboradorId);
    const cached = colabCache.get(key);

    // Cache hit SÓ se (slot, tenantId, colaboradorId) baterem exatamente.
    // Entry de outro tenant/slot (ou chave colidida) = MISS → re-resolve. ADR 0024 §4.
    if (
      cached &&
      cached.expiresAt > now &&
      cached.slot === slot &&
      cached.tenantId === tenantId &&
      cached.colaboradorId === colaboradorId &&
      cached.fingerprint === fingerprint
    ) {
      out.push({
        colaboradorId,
        nome: cached.nome,
        calendarId: row.gcal_calendar_id,
        client: cached.client,
        // servicos vem da LINHA atual (não do cache do client): mudanças do dono no
        // painel devem refletir já no próximo turno, sem esperar o TTL da credencial.
        servicos,
      });
      continue;
    }

    // MISS: monta o client com a credencial do CLONE + calendarId DO COLABORADOR.
    const client = new GoogleCalendarClient({
      credentialsJson: decryptSecret(cloneCreds),
      calendarId: row.gcal_calendar_id,
    });

    colabCache.set(key, {
      slot,
      colaboradorId,
      tenantId,
      nome: row.nome,
      servicos,
      fingerprint,
      client,
      expiresAt: now + CACHE_TTL_MS,
    });

    out.push({ colaboradorId, nome: row.nome, calendarId: row.gcal_calendar_id, client, servicos });
  }

  return out;
}

/**
 * Invalida o cache de colaboradores de um slot (todos) — chamar em 401/403 do
 * Google ou ao recadastrar/desativar colaboradores do estabelecimento.
 */
export function invalidateGcalsForSlot(slot: string): void {
  const prefix = `${slot}::`;
  for (const key of colabCache.keys()) {
    if (key.startsWith(prefix)) {
      colabCache.delete(key);
    }
  }
}
