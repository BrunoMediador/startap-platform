/**
 * gcal-health — leituras e UPDATEs do health-check periódico das agendas (SCRUM-27).
 *
 * Suporta o cron `gcal-healthcheck` (apps/worker) que revalida as agendas marcadas
 * 'active' e corrige o "active mentiroso" (status 'active' enquanto a agenda está
 * quebrada). Duas fontes:
 *   - INDIVIDUAL: flow_clones.gcal_* (1 agenda por clone).
 *   - ESTABELECIMENTO: clone_colaboradores.gcal_* (N calendarIds; a credencial é a do
 *     CLONE em flow_clones — ADR 0024 §2, 1 Service Account por cliente).
 *
 * Só lê candidatos 'active' COM credencial + calendarId presentes (os que PODEM estar
 * mentindo). Prioriza os de check mais ANTIGO (gcal_last_check_at ASC NULLS FIRST) para,
 * sob o teto por ciclo, dar a volta em todos ao longo de vários ciclos.
 *
 * Os UPDATEs são forward-only e idempotentes, com guarda `WHERE gcal_status='active'`:
 * só transicionam a partir de 'active' — se o operador mexeu no status entre o SELECT e o
 * UPDATE (ex.: 'disabled'), a guarda impede ressuscitar/clobberar. NÃO destrutivo.
 */
import { query } from '../client.js';

/** Candidato individual (flow_clones) a revalidar. */
export interface IndividualGcalCandidate {
  id: number;
  slot: string;
  gcal_credentials_json: string;
  gcal_calendar_id: string;
}

/** Candidato colaborador (clone_colaboradores + creds do clone). */
export interface ColaboradorGcalCandidate {
  colaborador_id: number;
  slot: string;
  gcal_calendar_id: string;
  /** Credencial (Service Account) do CLONE — uma por cliente (ADR 0024 §2). */
  clone_credentials_json: string;
}

/** Linha crua do pg (id BIGSERIAL pode chegar como string). */
interface IndividualRowRaw {
  id: string | number;
  slot: string;
  gcal_credentials_json: string;
  gcal_calendar_id: string;
}
interface ColaboradorRowRaw {
  colaborador_id: string | number;
  slot: string;
  gcal_calendar_id: string;
  clone_credentials_json: string;
}

/**
 * Clones INDIVIDUAIS com agenda 'active' + creds + calendarId. Ordena pelos checados
 * há mais tempo (NULL = nunca checado, vem primeiro). `limit` é o teto por ciclo.
 */
export async function listActiveIndividualGcals(limit: number): Promise<IndividualGcalCandidate[]> {
  const result = await query<IndividualRowRaw>(
    `SELECT id, slot, gcal_credentials_json, gcal_calendar_id
       FROM flow_clones
      WHERE gcal_status = 'active'
        AND gcal_credentials_json IS NOT NULL
        AND gcal_calendar_id IS NOT NULL
      ORDER BY gcal_last_check_at ASC NULLS FIRST, id ASC
      LIMIT $1`,
    [limit],
  );
  return result.rows.map((r) => ({
    id: Number(r.id),
    slot: r.slot,
    gcal_credentials_json: r.gcal_credentials_json,
    gcal_calendar_id: r.gcal_calendar_id,
  }));
}

/**
 * COLABORADORES (estabelecimento) com agenda 'active' + calendarId, cujo CLONE tem
 * credencial. JOIN escopado por (slot, tenant_id) — isolamento (ADR 0024 §4). Só
 * colaboradores ativos. Mesma priorização por check mais antigo. `limit` = teto por ciclo.
 */
export async function listActiveColaboradorGcals(
  limit: number,
): Promise<ColaboradorGcalCandidate[]> {
  const result = await query<ColaboradorRowRaw>(
    `SELECT cc.id                     AS colaborador_id,
            cc.slot                   AS slot,
            cc.gcal_calendar_id       AS gcal_calendar_id,
            fc.gcal_credentials_json  AS clone_credentials_json
       FROM clone_colaboradores cc
       JOIN flow_clones fc ON fc.slot = cc.slot AND fc.tenant_id = cc.tenant_id
      WHERE cc.gcal_status = 'active'
        AND cc.ativo = TRUE
        AND cc.gcal_calendar_id IS NOT NULL
        AND fc.gcal_credentials_json IS NOT NULL
      ORDER BY cc.gcal_last_check_at ASC NULLS FIRST, cc.id ASC
      LIMIT $1`,
    [limit],
  );
  return result.rows.map((r) => ({
    colaborador_id: Number(r.colaborador_id),
    slot: r.slot,
    gcal_calendar_id: r.gcal_calendar_id,
    clone_credentials_json: r.clone_credentials_json,
  }));
}

/**
 * Aplica o resultado da revalidação a um clone individual. Guarda `gcal_status='active'`:
 * só transiciona a partir de 'active'. `status` = 'active' (revalidado OK — só carimba o
 * check) ou 'invalid' (quebrou). gcal_connected_at preservado (espelha o teste do painel).
 * Retorna quantas linhas mudaram (0 = a guarda barrou; ex.: operador mudou pra 'disabled').
 */
export async function setIndividualGcalStatus(
  id: number,
  status: 'active' | 'invalid',
): Promise<number> {
  const result = await query(
    `UPDATE flow_clones
        SET gcal_status        = $1,
            gcal_last_check_at = NOW(),
            updated_at         = NOW()
      WHERE id = $2
        AND gcal_status = 'active'`,
    [status, id],
  );
  return result.rowCount ?? 0;
}

/**
 * Aplica o resultado da revalidação a um colaborador. Mesma guarda `gcal_status='active'`.
 * Escopo por id (a SELECT já garantiu pertencimento ao slot/tenant). Retorna linhas mudadas.
 */
export async function setColaboradorGcalStatus(
  colaboradorId: number,
  status: 'active' | 'invalid',
): Promise<number> {
  const result = await query(
    `UPDATE clone_colaboradores
        SET gcal_status        = $1,
            gcal_last_check_at = NOW(),
            updated_at         = NOW()
      WHERE id = $2
        AND gcal_status = 'active'`,
    [status, colaboradorId],
  );
  return result.rowCount ?? 0;
}
