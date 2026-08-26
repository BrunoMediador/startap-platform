/**
 * Job — SYNC PERIÓDICO GCal→atendimentos (SCRUM-89 / ADR 0031). A AGENDA é a fonte da verdade
 * do Faturamento.
 *
 * PROBLEMA: o billing derivado da agenda (ADR 0027) só é alimentado por HOOKS (bot ao agendar +
 * rotas do portal). Evento criado À MÃO no Google Calendar (caso real: 59 recorrências semanais da
 * Ingrid, R$110 cada) não passa por hook nenhum e nunca vira linha de atendimento. Decisão do Bruno
 * (dono, 17/07): a agenda é a fonte da verdade — evento novo/alterado entra/atualiza; evento que
 * SUMIU sai do Previsto/Faturado, INCLUSIVE no passado e INCLUSIVE linha já paga. A salvaguarda
 * "nunca deletar pago" foi DERRUBADA; mitigação aceita = log de auditoria em toda remoção.
 *
 * ALGORITMO (reconciliação, por clone com o gate billing-da-agenda ON e agenda 'active'):
 *   F0. Enumera os slots (flowClones.listAtendSyncSlots = env ATEND_FROM_AGENDA_SLOTS ∪ coluna
 *       billing_from_agenda_enabled — MESMO gate do hook). Loop com try/catch INDIVIDUAL por slot
 *       (regra de ouro 7). Reconfirma o gate por slot; sem tenant_id → skip (regra 5).
 *   F1. Snapshot da agenda: listEventsPaged numa janela de LISTAGEM (deleção ± pad) com sinal de
 *       COMPLETUDE. Individual = 1 calendário; estabelecimento = N (completo = AND de todos).
 *   F2/F3. Conjunto PRESENTE (status confirmed/tentative E TIMED) + UPSERT idempotente de cada um
 *       (preço por catálogo, fallback uniforme; sticky respeitado no helper). SEMPRE roda, mesmo
 *       com listagem incompleta (upsert é seguro sobre conhecimento parcial).
 *   F4. DELEÇÃO (soft) das linhas origem='agenda' cujo evento SUMIU — SÓ se a listagem é COMPLETA
 *       (fail-safe: deletar exige conhecimento total). Filtro por updated_at < (início do ciclo -
 *       grace) mata a corrida com o hook. origem='manual' é INTOCÁVEL. Cada deleção é AUDITADA em
 *       warn (slot/evento/valor/forma/data — NUNCA telefone/nome, LGPD).
 *
 * PRINCÍPIO DE SEGURANÇA (inegociável): DELETAR só sobre conhecimento COMPLETO. Qualquer
 * truncamento/erro/timeout na paginação → NÃO deleta neste ciclo (mas ainda faz upsert).
 *
 * GATE MACRO: só é registrado com GCAL_ATEND_SYNC_ENABLED=true (worker.ts). Default OFF.
 * ISOLAMENTO: falha de 1 clone loga e segue — nunca derruba o ciclo dos outros (regra 7).
 */
import { isAgendaAutomaticaIntent } from '@startap/core/agenda-degrade';
import { parseEventSummary } from '@startap/core/agenda-summary';
import { hashEventIdForLog } from '@startap/core/gcal-event-log';
import { logger } from '@startap/core/logger';
import { resolveModoAtendenteEnabled } from '@startap/core/modo-atendente-gate';
import { atendimentos, flowClones } from '@startap/db';
import { gcal } from '@startap/integrations';
import { config } from '../config.js';

const log = logger.child({ job: 'gcal-atend-sync' });

const MS_PER_DAY = 86_400_000;

/** Motivo/ator carimbados na linha soft-deletada pelo reconciler (SCRUM-90 / migration 074). */
const SYNC_DELETE_AUDIT: atendimentos.SoftDeleteAudit = {
  reason: 'gcal_sync_absent',
  by: 'gcal-atend-sync',
};

/**
 * Hash one-way do gcal_event_id para o LOG de auditoria (SCRUM-90/91, jurídico). A implementação
 * agora vive em @startap/core/gcal-event-log (fonte ÚNICA, compartilhada com o portal-api — SCRUM-91).
 * Re-exportada aqui pra preservar os call sites e o teste deste módulo.
 */
export { hashEventIdForLog };

export interface GcalAtendSyncResult extends Record<string, unknown> {
  /** clones enumerados e efetivamente processados neste ciclo (sob o teto por ciclo). */
  slots: number;
  /** slots preservados porque o modo efetivo é atendente, mesmo com o gate do sync ainda ligado. */
  skippedEffectiveAtendente: number;
  /** eventos PRESENTES bilhetáveis considerados (somados sobre todos os slots). */
  scanned: number;
  /** linhas criadas/atualizadas via upsert. */
  upserted: number;
  /** linhas soft-deletadas (evento sumiu da agenda, listagem completa). */
  deleted: number;
  /** slots cuja DELEÇÃO foi pulada por listagem incompleta (fail-safe). */
  skippedIncomplete: number;
  /** slots pulados por gcal não configurado/ativo — snapshot null (fail-safe: zero upsert/delete). */
  skippedNoGcal: number;
  /**
   * Linhas de atendimento PRESERVADAS na F4 porque o colaborador delas não foi listado por completo
   * neste ciclo (dropout parcial de um colaborador do estabelecimento — SCRUM-111). Fail-safe: sem
   * conhecimento completo do calendário daquele colaborador, seu faturamento não é apagado.
   */
  deletionsSkippedColabAbsent: number;
  /** slots que caíram no catch individual (erro isolado, não derrubou o ciclo). */
  slotsWithError: number;
  /**
   * SCRUM-129: eventos cujo serviço estava presente no summary mas NÃO casou o catálogo (nem por
   * normalização) e sem preço uniforme → nasceram com valor 0. Contador da cauda a investigar.
   */
  unrecognizedServices: number;
}

/** Evento do snapshot + o colaborador (estabelecimento) de cujo calendário ele veio (null = individual). */
interface SnapEvent {
  event: gcal.CalendarEvent;
  colaboradorId: number | null;
}

/** Resultado do snapshot de UM slot: eventos + completude agregada + motivo (se incompleto). */
interface SlotSnapshot {
  events: SnapEvent[];
  complete: boolean;
  pages: number;
  incompleteReason?: gcal.GcalListIncompleteReason;
  /**
   * Estabelecimento: conjunto dos colaboradorId que getGcalsForSlot ENTREGOU e cuja listagem
   * chegou (a F4 só é alcançada com `complete=true`, ou seja, todos os ENTREGUES vieram por
   * inteiro). Um colaborador que SUMIU de getGcalsForSlot (dropout parcial: gcal_status virou
   * != 'active', calendarId caiu, etc.) NÃO está aqui — e por isso o faturamento dele não é
   * apagado nesta rodada (fail-safe SCRUM-111). `null` = caminho INDIVIDUAL (1 calendário; a
   * deleção é gated só por `complete`, comportamento inalterado).
   */
  listedColaboradorIds: Set<number> | null;
}

/** CSV → lista de slots (trim, ignora vazios). '*' não é expandido aqui (ver listAtendSyncSlots). */
function csvToArray(csv: string): string[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Quebra o summary do bot ("Nome - Servico | WhatsApp: numero") em partes. Tolerante: sem match
 * do formato, devolve o texto inteiro como `nome` e serviço vazio. Ex.: "Fulano Atendimento"
 * (evento manual da Ingrid) → servico='' → preço cai no fallback uniforme do catálogo.
 *
 * UNIFICADO (ADR 0028): a implementação agora é @startap/core/agenda-summary::parseEventSummary
 * — fonte única compartilhada com apps/portal-api/src/routes/portal-agendamentos.ts (antes eram
 * dois parsers duplicados). Re-exportada aqui pra preservar o símbolo e os call sites deste módulo.
 */
export const parseBotSummary = parseEventSummary;

/** Como o preço foi obtido — para observabilidade da cauda "serviço não reconhecido" (SCRUM-129). */
export type PrecoMatch = 'exact' | 'normalized' | 'uniform' | 'none';

export interface PrecoResolution {
  /** preço em centavos (0 quando nada casou e o catálogo não é uniforme). */
  cents: number;
  /** 'none' = serviço presente porém fora do catálogo, sem preço uniforme → sinal observável. */
  match: PrecoMatch;
}

/**
 * Preço (centavos) de um serviço a partir do pricing pré-carregado, em CAMADAS (SCRUM-129):
 *   1. match EXATO (case-insensitive/trim) no catálogo;
 *   2. fallback NORMALIZADO (sem acentos/caixa/espaços — normalizeServiceName) contra o mesmo
 *      catálogo, antes de desistir (elimina a classe "Sobrâncelha" vs "sobrancelha", 72% do Samuel);
 *   3. preço UNIFORME do catálogo (ADR 0031, caso Ingrid "Fulano Atendimento" com serviço vazio);
 *   4. 0 quando nada casa — NUNCA inventa preço. O caller emite o sinal observável quando match='none'.
 * A edição manual do dono (sticky) vence isto no upsert.
 */
export function resolvePreco(pricing: atendimentos.SlotPricing, servico: string): PrecoResolution {
  const key = servico.trim().toLowerCase();
  if (key) {
    const exact = pricing.byNameLower.get(key);
    if (exact != null) return { cents: exact, match: 'exact' };
    const norm = atendimentos.normalizeServiceName(servico);
    if (norm) {
      const normHit = pricing.byNameNormalized.get(norm);
      if (normHit != null) return { cents: normHit, match: 'normalized' };
    }
  }
  const uniform = pricing.uniformPriceCents;
  if (uniform != null) return { cents: uniform, match: 'uniform' };
  return { cents: 0, match: 'none' };
}

/**
 * Evento é BILHETÁVEL (entra no presentIds + upsert)? status ∈ {confirmed, tentative} (undefined =
 * confirmed; 'cancelled' = ausente) E TIMED (start.dateTime presente; all-day com start.date é
 * ignorado — não bilhetável). Type guard: narra o evento com id + start.dateTime garantidos.
 */
function isBillableEvent(
  ev: gcal.CalendarEvent,
): ev is gcal.CalendarEvent & { id: string; start: { dateTime: string } } {
  if (ev.extendedProperties?.private?.kind === 'bloqueio') return false;
  const status = ev.status ?? 'confirmed';
  if (status !== 'confirmed' && status !== 'tentative') return false;
  if (!ev.id) return false;
  if (!ev.start?.dateTime) return false;
  return true;
}

/**
 * Classifica SOMENTE o contrato fechado do paginador. O caller pode ser mockado ou futuramente
 * alterado; por isso qualquer shape não allowlisted cai em `unknown`, sem interpolar texto externo.
 */
const SAFE_LIST_ERROR_CLASSES = new Set<gcal.GcalHttpErrorClass>([
  'bad_request',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'backend_error',
  'server_error',
  'unexpected_http',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function classifyIncomplete(reason: unknown): string {
  if (!isRecord(reason) || typeof reason.code !== 'string') return 'unknown';
  if (reason.code === 'truncated_max_pages') return 'truncated_max_pages';
  if (reason.code === gcal.GCAL_LIST_TIMEOUT_SENTINEL) return 'timeout';
  if (reason.code === 'token_error' || reason.code === 'network_error') return 'network';
  if (reason.code === 'invalid_response') return 'invalid_response';
  if (
    reason.code !== 'http_error' ||
    reason.endpoint !== 'events_collection' ||
    reason.operation !== 'read' ||
    typeof reason.httpStatus !== 'number' ||
    !Number.isInteger(reason.httpStatus) ||
    reason.httpStatus < 100 ||
    reason.httpStatus > 599 ||
    typeof reason.errorClass !== 'string' ||
    !SAFE_LIST_ERROR_CLASSES.has(reason.errorClass as gcal.GcalHttpErrorClass)
  ) {
    return 'unknown';
  }
  return `http_${reason.httpStatus}:${reason.errorClass}`;
}

/**
 * Snapshot da agenda de UM slot na janela de listagem. Individual = 1 calendário; estabelecimento =
 * N calendários de colaborador (completo = AND de todos; presentIds = união). Retorna null quando
 * o GCal do slot não está configurado/ativo → o caller pula o slot inteiro (zero upsert, zero
 * delete = fail-safe).
 */
async function buildSlotSnapshot(
  scope: flowClones.AtendSyncSlotRow,
  listFromIso: string,
  listToIso: string,
): Promise<SlotSnapshot | null> {
  const maxPages = config.GCAL_ATEND_SYNC_MAX_PAGES;
  const timeoutMs = config.GCAL_ATEND_SYNC_TIMEOUT_MS;

  if (scope.product_type === 'estabelecimento') {
    const colabs = await gcal.getGcalsForSlot(scope.slot);
    if (colabs.length === 0) return null; // sem agenda ativa de colaborador → skip slot.
    const events: SnapEvent[] = [];
    // Só os colaboradores ENTREGUES por getGcalsForSlot entram aqui. Um colaborador que sumiu
    // da lista (dropout parcial) nunca é adicionado → a F4 não deleta o faturamento dele (SCRUM-111).
    const listedColaboradorIds = new Set<number>();
    let complete = true;
    let pages = 0;
    let incompleteReason: gcal.GcalListIncompleteReason | undefined;
    for (const c of colabs) {
      listedColaboradorIds.add(c.colaboradorId);
      const paged = await c.client.listEventsPaged({
        timeMin: listFromIso,
        timeMax: listToIso,
        maxPages,
        timeoutMs,
      });
      pages += paged.pages;
      if (!paged.complete) {
        complete = false;
        incompleteReason = incompleteReason ?? paged.incompleteReason;
      }
      for (const ev of paged.events) events.push({ event: ev, colaboradorId: c.colaboradorId });
    }
    return { events, complete, pages, incompleteReason, listedColaboradorIds };
  }

  // Individual: 1 calendário do clone.
  const client = await gcal.getGcalForSlot(scope.slot);
  if (!client) return null; // gcal_status != 'active' → skip slot.
  const paged = await client.listEventsPaged({
    timeMin: listFromIso,
    timeMax: listToIso,
    maxPages,
    timeoutMs,
  });
  return {
    events: paged.events.map((ev) => ({ event: ev, colaboradorId: null })),
    complete: paged.complete,
    pages: paged.pages,
    incompleteReason: paged.incompleteReason,
    listedColaboradorIds: null, // individual → sem gate por colaborador (só `complete`).
  };
}

/**
 * Reconcilia UM slot. ORDEM CRÍTICA (ADR 0031): snapshot GCal (F1) ANTES de ler candidatos do
 * banco (F4), e candidatos filtrados por updated_at < (início do ciclo - grace) — nenhuma linha
 * nascida durante o ciclo é deletada. Lança em erro grave (o caller isola no try/catch por slot).
 */
async function reconcileSlot(
  scope: flowClones.AtendSyncSlotRow,
  result: GcalAtendSyncResult,
  syncModeGuard: atendimentos.GcalSyncModeWriteGuard,
): Promise<void> {
  // Reconfirma o gate por slot (belt-and-suspenders) — mesma resolução env→coluna do hook.
  const enabled = await flowClones.resolveAtendFromAgendaEnabledForSlot(
    scope.slot,
    config.ATEND_FROM_AGENDA_SLOTS,
  );
  if (!enabled) return;

  // Sem tenant_id não dá pra carimbar a linha (regra de ouro 5) — pula o slot.
  if (!scope.tenant_id) {
    log.warn({ slot: scope.slot }, 'gcal-atend-sync: clone sem tenant_id — slot pulado');
    return;
  }
  const tenantId = scope.tenant_id;

  // Relógio da corrida: fixado ANTES de qualquer leitura (F1). É o teto do grace na F4.
  const cycleStartedAt = new Date();
  const nowMs = cycleStartedAt.getTime();
  const delFrom = new Date(nowMs - config.GCAL_ATEND_SYNC_LOOKBACK_DAYS * MS_PER_DAY);
  const delTo = new Date(nowMs + config.GCAL_ATEND_SYNC_LOOKAHEAD_DAYS * MS_PER_DAY);
  const padMs = config.GCAL_ATEND_SYNC_LIST_PAD_DAYS * MS_PER_DAY;
  const listFrom = new Date(delFrom.getTime() - padMs);
  const listTo = new Date(delTo.getTime() + padMs);

  // Catálogo de preços 1× por slot (sem N leituras no upsert).
  const pricing = await atendimentos.loadSlotPricing(scope.slot);

  // F1 — snapshot da agenda.
  const snapshot = await buildSlotSnapshot(scope, listFrom.toISOString(), listTo.toISOString());
  if (snapshot === null) {
    // gcal não configurado/ativo → skip inteiro (fail-safe: zero upsert/delete). Antes saía MUDO
    // e sem contador — agora conta e loga pra visibilidade (SCRUM-111).
    result.skippedNoGcal++;
    log.warn(
      { slot: scope.slot, product_type: scope.product_type },
      'gcal-atend-sync: gcal não configurado/ativo — slot pulado (nenhum upsert/delete)',
    );
    return;
  }

  // F2/F3 — conjunto PRESENTE + upsert (sempre roda, mesmo com listagem incompleta).
  const presentIds = new Set<string>();
  for (const se of snapshot.events) {
    const ev = se.event;
    if (!isBillableEvent(ev)) continue; // cancelled / all-day → ausente.
    result.scanned++;
    presentIds.add(ev.id);
    const parsed = parseBotSummary(ev.summary ?? '');
    const preco = resolvePreco(pricing, parsed.servico);
    const valorCents = preco.cents;
    // SCRUM-129: serviço presente no evento mas SEM match no catálogo (nem normalizado) e sem preço
    // uniforme → nasce com valor 0. Emite sinal estruturado observável (slot + nome do serviço, NUNCA
    // telefone/nome do cliente, LGPD) pra vermos a cauda de nomes fora do catálogo. NÃO chuta preço.
    if (preco.match === 'none' && parsed.servico.trim() !== '') {
      result.unrecognizedServices++;
      log.warn(
        {
          slot: scope.slot,
          servico: parsed.servico.trim().slice(0, 80),
          catalogSize: pricing.byNameLower.size,
        },
        'gcal-atend-sync: serviço do evento não reconhecido no catálogo — atendimento nasce com valor 0 (SCRUM-129)',
      );
    }
    // NÃO passa formaPagamento (undefined → o UPDATE PRESERVA forma/valor/desconto: não reabre o
    // bug DOBRA) nem reprecificarServico (reconciler nunca reprecifica). Sticky respeitado no helper.
    const row = await atendimentos.upsertAtendimentoFromEvent({
      slot: scope.slot,
      tenantId,
      gcalEventId: ev.id,
      servicoNome: parsed.servico || null,
      clienteNome: parsed.nome || null,
      clienteContato: parsed.telefone ?? null,
      inicioAt: ev.start.dateTime,
      fimAt: ev.end?.dateTime ?? null,
      timezone: scope.timezone,
      valorCents,
      colaboradorId: se.colaboradorId,
      syncModeGuard,
    });
    if (!row) {
      log.warn(
        { slot: scope.slot },
        'gcal-atend-sync: modo mudou para atendente durante o ciclo — escritas restantes puladas',
      );
      continue;
    }
    result.upserted++;
  }

  // F4 — DELEÇÃO só sobre listagem COMPLETA (fail-safe).
  if (!snapshot.complete) {
    result.skippedIncomplete++;
    log.warn(
      {
        slot: scope.slot,
        reason: classifyIncomplete(snapshot.incompleteReason),
        pages: snapshot.pages,
      },
      'gcal-atend-sync: listagem incompleta — DELEÇÃO pulada neste ciclo (fail-safe)',
    );
    return;
  }

  const updatedBefore = new Date(
    nowMs - config.GCAL_ATEND_SYNC_DELETE_GRACE_SEC * 1000,
  ).toISOString();
  const dbRows = await atendimentos.listAgendaAtendimentosInWindow(
    scope.slot,
    delFrom.toISOString(),
    delTo.toISOString(),
    updatedBefore,
  );
  // SCRUM-111: no estabelecimento, um evento só pode ser tido por "sumiu da agenda" se o
  // calendário do colaborador DELE foi listado por completo neste ciclo. Se o colaborador sumiu
  // de getGcalsForSlot (dropout parcial), NÃO temos conhecimento da agenda dele → preservar.
  const colabGate = snapshot.listedColaboradorIds; // null = individual (sem gate).
  const absentColabIds = new Set<number>();
  let skippedByColab = 0;
  for (const r of dbRows) {
    if (presentIds.has(r.gcal_event_id)) continue; // ainda na agenda → mantém.
    if (colabGate !== null) {
      // Estabelecimento: só deleta se o colaborador da linha entrou no snapshot deste ciclo.
      // colaborador_id null (linha SOLO/legada) OU ausente do gate = sem conhecimento → preserva.
      const colabId = r.colaborador_id;
      if (colabId == null || !colabGate.has(colabId)) {
        skippedByColab++;
        result.deletionsSkippedColabAbsent++;
        if (colabId != null) absentColabIds.add(colabId);
        continue;
      }
    }
    // SCRUM-90: carimba deleted_reason/deleted_by na MESMA linha (trilha durável no banco).
    const deleted = await atendimentos.softDeleteAtendimentoByEvent(
      scope.slot,
      r.gcal_event_id,
      SYNC_DELETE_AUDIT,
      syncModeGuard,
    );
    if (!deleted) continue;
    result.deleted++;
    // AUDITORIA obrigatória (Bruno derrubou "nunca deletar pago"): valor/forma/data, NUNCA telefone.
    // gcalEventId vai HASHEADO no log (jurídico, SCRUM-90); o id cru fica na linha soft-deletada.
    log.warn(
      {
        slot: scope.slot,
        gcalEventId: hashEventIdForLog(r.gcal_event_id),
        valorCents: r.valor_cents,
        descontoCents: r.desconto_cents,
        formaPagamento: r.forma_pagamento,
        data: r.data,
        paga: r.forma_pagamento != null,
      },
      'gcal-atend-sync: linha removida — agenda é fonte da verdade (inclusive paga)',
    );
  }

  // SCRUM-111: visibilidade do fail-safe por colaborador. Sem este log, um dropout parcial
  // preservava faturamento em silêncio (bom pro cliente, cego pra operação).
  if (skippedByColab > 0) {
    log.warn(
      {
        slot: scope.slot,
        skippedRows: skippedByColab,
        listedColabs: colabGate ? colabGate.size : 0,
        absentColabIds: [...absentColabIds].sort((a, b) => a - b),
      },
      'gcal-atend-sync: deleção pulada — colaborador ausente/incompleto no snapshot (fail-safe SCRUM-111)',
    );
  }
}

/**
 * Ciclo do reconciler. Enumera os slots gated, processa cada um sob try/catch INDIVIDUAL (regra 7)
 * e acumula o resumo. Idempotente: rodar 2× seguidas = mesmo resultado (upsert/softDelete idem-
 * potentes; o 2º ciclo não acha mais a linha deletada).
 */
export async function runGcalAtendSync(): Promise<GcalAtendSyncResult> {
  const result: GcalAtendSyncResult = {
    slots: 0,
    skippedEffectiveAtendente: 0,
    scanned: 0,
    upserted: 0,
    deleted: 0,
    skippedIncomplete: 0,
    skippedNoGcal: 0,
    deletionsSkippedColabAbsent: 0,
    slotsWithError: 0,
    unrecognizedServices: 0,
  };

  const explicitSlots = csvToArray(config.ATEND_FROM_AGENDA_SLOTS);
  const modoAtendenteEntries = csvToArray(config.MODO_ATENDENTE_SLOTS);
  const modoAtendenteWildcard = modoAtendenteEntries.includes('*');
  const modoAtendenteSlots = modoAtendenteEntries.filter((entry) => entry !== '*');
  const syncModeGuard: atendimentos.GcalSyncModeWriteGuard = {
    modoAtendenteSlots,
    modoAtendenteWildcard,
  };
  const allSlots = await flowClones.listAtendSyncSlots(
    explicitSlots,
    modoAtendenteSlots,
    modoAtendenteWildcard,
  );
  const maxSlots = config.GCAL_ATEND_SYNC_MAX_SLOTS_PER_RUN;
  const slots = allSlots.slice(0, maxSlots);
  if (allSlots.length > maxSlots) {
    log.warn(
      { total: allSlots.length, processed: maxSlots },
      'gcal-atend-sync: mais slots que o teto por ciclo — restante entra no próximo',
    );
  }

  for (const scope of slots) {
    result.slots++;
    const modoAtendenteEfetivo =
      resolveModoAtendenteEnabled(
        scope.slot,
        config.MODO_ATENDENTE_SLOTS,
        scope.modo_atendente_enabled,
      ) && !isAgendaAutomaticaIntent(scope.agenda_automatica);
    if (modoAtendenteEfetivo) {
      result.skippedEffectiveAtendente++;
      log.warn(
        { slot: scope.slot },
        'gcal-atend-sync: modo efetivo atendente — reconciliação pulada (atendimentos preservados)',
      );
      continue;
    }
    try {
      await reconcileSlot(scope, result, syncModeGuard);
    } catch (err: unknown) {
      // Falha de 1 clone NUNCA derruba o ciclo dos outros (regra de ouro 7).
      result.slotsWithError++;
      log.error(
        { slot: scope.slot, err: err instanceof Error ? err.message : String(err) },
        'gcal-atend-sync: erro no slot (ciclo dos demais preservado)',
      );
    }
  }

  return result;
}
