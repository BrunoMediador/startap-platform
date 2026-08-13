/**
 * Testes do job runGcalAtendSync (sync periódico GCal→atendimentos — SCRUM-89 / ADR 0031).
 *
 * `@startap/db` (atendimentos, flowClones), `@startap/integrations` (gcal), `@startap/core/logger`
 * e `../config.js` são MOCKADOS — sem banco, sem rede. A orquestração (upsert idempotente, deleção
 * SÓ sobre listagem completa, auditoria da deleção, isolamento por slot, gate) é coberta de ponta a
 * ponta.
 *
 * Cobre:
 *  - UPSERT: evento manual "Fulano Atendimento" (sem " - ") → servico='' → valorCents = preço
 *    uniforme do catálogo; upsert sem formaPagamento e sem reprecificarServico.
 *  - preço por catálogo (match) e 0 quando catálogo não-uniforme e sem match.
 *  - DELETE só com complete=true: evento sumido → softDelete + warn de auditoria (valor/forma), NUNCA telefone.
 *  - complete=false → softDelete NÃO chamado; upsert ainda roda.
 *  - status='cancelled' e all-day não entram no presentIds/upsert.
 *  - grace: listAgendaAtendimentosInWindow recebe updatedBefore ≈ início do ciclo - grace.
 *  - isolamento: erro em 1 slot não derruba os demais (slotsWithError).
 *  - estabelecimento: 1 colaborador incompleto → nenhuma deleção no slot; upsert dos presentes segue.
 *  - gate reconfirmado false → slot pulado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const GCAL_LIST_TIMEOUT_SENTINEL = '__gcal_list_timeout__';

// ── Mocks dos módulos externos ao job ───────────────────────────────────────────
const listAtendSyncSlots = vi.fn();
const resolveAtendFromAgendaEnabledForSlot = vi.fn();
const loadSlotPricing = vi.fn();
const upsertAtendimentoFromEvent = vi.fn();
const listAgendaAtendimentosInWindow = vi.fn();
const softDeleteAtendimentoByEvent = vi.fn();
const getGcalForSlot = vi.fn();
const getGcalsForSlot = vi.fn();

// normalizeServiceName é PURO (sem I/O) — usamos a implementação REAL no mock para que o matcher
// normalizado (SCRUM-129) seja exercitado de verdade nos testes do reconciler.
const normalizeServiceName = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

vi.mock('@startap/db', () => ({
  atendimentos: {
    loadSlotPricing,
    upsertAtendimentoFromEvent,
    listAgendaAtendimentosInWindow,
    softDeleteAtendimentoByEvent,
    normalizeServiceName,
  },
  flowClones: { listAtendSyncSlots, resolveAtendFromAgendaEnabledForSlot },
}));

vi.mock('@startap/integrations', () => ({
  gcal: { getGcalForSlot, getGcalsForSlot, GCAL_LIST_TIMEOUT_SENTINEL },
}));

const logInfo = vi.fn();
const logWarn = vi.fn();
const logError = vi.fn();
vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: logInfo, warn: logWarn, error: logError }) },
}));

async function loadJob(configOverrides: Record<string, unknown> = {}) {
  vi.resetModules();
  vi.doMock('../config.js', () => ({
    config: {
      ATEND_FROM_AGENDA_SLOTS: 'clone_x',
      MODO_ATENDENTE_SLOTS: '',
      GCAL_ATEND_SYNC_ENABLED: true,
      GCAL_ATEND_SYNC_CRON: '37 * * * *',
      GCAL_ATEND_SYNC_LOOKBACK_DAYS: 62,
      GCAL_ATEND_SYNC_LOOKAHEAD_DAYS: 60,
      GCAL_ATEND_SYNC_LIST_PAD_DAYS: 7,
      GCAL_ATEND_SYNC_MAX_PAGES: 20,
      GCAL_ATEND_SYNC_TIMEOUT_MS: 15_000,
      GCAL_ATEND_SYNC_DELETE_GRACE_SEC: 120,
      GCAL_ATEND_SYNC_MAX_SLOTS_PER_RUN: 50,
      ...configOverrides,
    },
  }));
  return import('./gcal-atend-sync.js');
}

// ── Fábricas ─────────────────────────────────────────────────────────────────────
function slot(over: Record<string, unknown> = {}) {
  return {
    slot: 'clone_x',
    tenant_id: 'tenant-1',
    timezone: 'America/Sao_Paulo',
    product_type: 'individual',
    ...over,
  };
}

interface EvOpts {
  summary?: string;
  status?: string;
  dateTime?: string | null;
  allDay?: boolean;
}
function ev(id: string, o: EvOpts = {}) {
  const start = o.allDay
    ? { date: '2026-07-20' }
    : { dateTime: o.dateTime ?? '2026-07-20T14:00:00-03:00' };
  const end = o.allDay ? { date: '2026-07-21' } : { dateTime: '2026-07-20T14:30:00-03:00' };
  return { id, summary: o.summary ?? 'Cliente - Corte', start, end, status: o.status };
}

/** Client fake com listEventsPaged controlado. */
function pagedClient(result: {
  events: unknown[];
  complete: boolean;
  pages?: number;
  incompleteReason?: string;
}) {
  return { listEventsPaged: vi.fn().mockResolvedValue({ pages: 1, ...result }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults: 1 slot individual, gate ON, catálogo vazio, sem candidatos a deleção.
  listAtendSyncSlots.mockResolvedValue([slot()]);
  resolveAtendFromAgendaEnabledForSlot.mockResolvedValue(true);
  loadSlotPricing.mockResolvedValue({
    byNameLower: new Map(),
    byNameNormalized: new Map(),
    uniformPriceCents: null,
  });
  listAgendaAtendimentosInWindow.mockResolvedValue([]);
  upsertAtendimentoFromEvent.mockResolvedValue({ id: 1 });
  softDeleteAtendimentoByEvent.mockResolvedValue({ id: 1 });
  getGcalForSlot.mockResolvedValue(pagedClient({ events: [], complete: true }));
  getGcalsForSlot.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UPSERT — preço', () => {
  it('evento manual "Fulano Atendimento" (sem " - ") → servico="" → preço uniforme do catálogo', async () => {
    loadSlotPricing.mockResolvedValue({
      byNameLower: new Map(),
      byNameNormalized: new Map(),
      uniformPriceCents: 11000,
    });
    getGcalForSlot.mockResolvedValue(
      pagedClient({ events: [ev('m1', { summary: 'Fulano Atendimento' })], complete: true }),
    );

    const { runGcalAtendSync } = await loadJob();
    const res = await runGcalAtendSync();

    expect(res.upserted).toBe(1);
    expect(upsertAtendimentoFromEvent).toHaveBeenCalledTimes(1);
    const arg = upsertAtendimentoFromEvent.mock.calls[0][0];
    expect(arg.valorCents).toBe(11000);
    expect(arg.servicoNome).toBeNull(); // servico vazio → null
    expect(arg.clienteNome).toBe('Fulano Atendimento');
    expect(arg.gcalEventId).toBe('m1');
    // Reconciler NUNCA passa forma/reprice (não reabre bug DOBRA; nunca reprecifica).
    expect(arg).not.toHaveProperty('formaPagamento');
    expect(arg).not.toHaveProperty('reprecificarServico');
  });

  it('match no catálogo usa o preço do serviço', async () => {
    loadSlotPricing.mockResolvedValue({
      byNameLower: new Map([['corte', 5000]]),
      byNameNormalized: new Map([['corte', 5000]]),
      uniformPriceCents: null,
    });
    getGcalForSlot.mockResolvedValue(
      pagedClient({ events: [ev('e1', { summary: 'Zé - Corte' })], complete: true }),
    );

    const { runGcalAtendSync } = await loadJob();
    const res = await runGcalAtendSync();

    expect(upsertAtendimentoFromEvent.mock.calls[0][0].valorCents).toBe(5000);
    expect(res.unrecognizedServices).toBe(0);
  });

  it('SCRUM-129: match NORMALIZADO (acento/caixa/espaço) → preço do catálogo, sem sinal de não-reconhecido', async () => {
    loadSlotPricing.mockResolvedValue({
      byNameLower: new Map([['sobrancelha', 2000]]),
      byNameNormalized: new Map([['sobrancelha', 2000]]),
      uniformPriceCents: null,
    });
    getGcalForSlot.mockResolvedValue(
      pagedClient({ events: [ev('e1', { summary: 'Zé -  SOBRÂNCELHA ' })], complete: true }),
    );

    const { runGcalAtendSync } = await loadJob();
    const res = await runGcalAtendSync();

    expect(upsertAtendimentoFromEvent.mock.calls[0][0].valorCents).toBe(2000);
    expect(res.unrecognizedServices).toBe(0);
    // Nenhum warn de "não reconhecido" quando o normalizado casou.
    expect(
      logWarn.mock.calls.find((c) => String(c[1]).includes('não reconhecido')),
    ).toBeUndefined();
  });

  it('SCRUM-129: serviço presente fora do catálogo (sem uniforme) → valor 0 + sinal observável SEM PII', async () => {
    loadSlotPricing.mockResolvedValue({
      byNameLower: new Map([['barba', 3000]]),
      byNameNormalized: new Map([['barba', 3000]]),
      uniformPriceCents: null,
    });
    getGcalForSlot.mockResolvedValue(
      pagedClient({ events: [ev('e1', { summary: 'Zé - Progressiva' })], complete: true }),
    );

    const { runGcalAtendSync } = await loadJob();
    const res = await runGcalAtendSync();

    expect(upsertAtendimentoFromEvent.mock.calls[0][0].valorCents).toBe(0);
    expect(res.unrecognizedServices).toBe(1);
    const warn = logWarn.mock.calls.find((c) => String(c[1]).includes('não reconhecido'));
    expect(warn).toBeDefined();
    const payload = warn?.[0] as Record<string, unknown>;
    expect(payload.servico).toBe('Progressiva');
    expect(payload.slot).toBe('clone_x');
    // LGPD: nunca vaza telefone/nome do cliente no sinal.
    expect(payload).not.toHaveProperty('telefone');
    expect(payload).not.toHaveProperty('clienteNome');
    expect(payload).not.toHaveProperty('nome');
  });

  it('SCRUM-129: serviço VAZIO sem uniforme → valor 0 MAS não conta como não-reconhecido', async () => {
    loadSlotPricing.mockResolvedValue({
      byNameLower: new Map([['barba', 3000]]),
      byNameNormalized: new Map([['barba', 3000]]),
      uniformPriceCents: null,
    });
    // "Fulano Atendimento" (sem " - ") → servico='' → não é "serviço não reconhecido".
    getGcalForSlot.mockResolvedValue(
      pagedClient({ events: [ev('e1', { summary: 'Fulano Atendimento' })], complete: true }),
    );

    const { runGcalAtendSync } = await loadJob();
    const res = await runGcalAtendSync();

    expect(upsertAtendimentoFromEvent.mock.calls[0][0].valorCents).toBe(0);
    expect(res.unrecognizedServices).toBe(0);
    expect(
      logWarn.mock.calls.find((c) => String(c[1]).includes('não reconhecido')),
    ).toBeUndefined();
  });
});

describe('DELEÇÃO — só sobre listagem completa + auditoria', () => {
  it('evento sumido (complete=true) → softDelete + warn de auditoria SEM telefone', async () => {
    getGcalForSlot.mockResolvedValue(pagedClient({ events: [ev('presente')], complete: true }));
    listAgendaAtendimentosInWindow.mockResolvedValue([
      {
        gcal_event_id: 'sumiu',
        valor_cents: 11000,
        desconto_cents: 0,
        forma_pagamento: 'pix',
        data: '2026-07-10',
      },
    ]);

    const { runGcalAtendSync } = await loadJob();
    const res = await runGcalAtendSync();

    expect(res.deleted).toBe(1);
    // SCRUM-90: carimba deleted_reason/deleted_by na linha (trilha durável no banco).
    expect(softDeleteAtendimentoByEvent).toHaveBeenCalledWith(
      'clone_x',
      'sumiu',
      {
        reason: 'gcal_sync_absent',
        by: 'gcal-atend-sync',
      },
      expect.any(Object),
    );
    // Warn de auditoria com valor/forma/data + paga=true; NUNCA telefone/nome.
    const auditCall = logWarn.mock.calls.find((c) =>
      String(c[1]).includes('agenda é fonte da verdade'),
    );
    expect(auditCall).toBeDefined();
    const payload = auditCall?.[0] as Record<string, unknown>;
    expect(payload.valorCents).toBe(11000);
    expect(payload.formaPagamento).toBe('pix');
    expect(payload.paga).toBe(true);
    expect(payload).not.toHaveProperty('cliente_contato');
    expect(payload).not.toHaveProperty('telefone');
    expect(payload).not.toHaveProperty('clienteNome');
    // SCRUM-90 (jurídico): o LOG carrega o gcalEventId HASHEADO, nunca o id cru.
    expect(payload.gcalEventId).not.toBe('sumiu');
    expect(payload.gcalEventId).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it('evento AINDA presente não é deletado', async () => {
    getGcalForSlot.mockResolvedValue(pagedClient({ events: [ev('vivo')], complete: true }));
    listAgendaAtendimentosInWindow.mockResolvedValue([
      {
        gcal_event_id: 'vivo',
        valor_cents: 5000,
        desconto_cents: 0,
        forma_pagamento: null,
        data: '2026-07-10',
      },
    ]);

    const { runGcalAtendSync } = await loadJob();
    const res = await runGcalAtendSync();

    expect(res.deleted).toBe(0);
    expect(softDeleteAtendimentoByEvent).not.toHaveBeenCalled();
  });

  it('complete=false → softDelete NÃO chamado; upsert ainda roda', async () => {
    getGcalForSlot.mockResolvedValue(
      pagedClient({
        events: [ev('e1')],
        complete: false,
        incompleteReason: 'truncated_max_pages',
      }),
    );
    // Mesmo com candidato "sumido", a listagem incompleta bloqueia a deleção.
    listAgendaAtendimentosInWindow.mockResolvedValue([
      {
        gcal_event_id: 'sumiu',
        valor_cents: 1,
        desconto_cents: 0,
        forma_pagamento: null,
        data: '2026-07-10',
      },
    ]);

    const { runGcalAtendSync } = await loadJob();
    const res = await runGcalAtendSync();

    expect(res.upserted).toBe(1);
    expect(res.deleted).toBe(0);
    expect(res.skippedIncomplete).toBe(1);
    expect(softDeleteAtendimentoByEvent).not.toHaveBeenCalled();
    // Nem sequer lê candidatos quando incompleto (fail-safe antes de tocar o banco).
    expect(listAgendaAtendimentosInWindow).not.toHaveBeenCalled();
  });
});

describe('conjunto PRESENTE — filtros', () => {
  it('status="cancelled" e all-day não entram no presentIds nem no upsert', async () => {
    getGcalForSlot.mockResolvedValue(
      pagedClient({
        events: [ev('ok'), ev('cancel', { status: 'cancelled' }), ev('allday', { allDay: true })],
        complete: true,
      }),
    );
    // 'cancel' existe no banco: como está AUSENTE do presentIds, deve ser deletado.
    listAgendaAtendimentosInWindow.mockResolvedValue([
      {
        gcal_event_id: 'cancel',
        valor_cents: 0,
        desconto_cents: 0,
        forma_pagamento: null,
        data: '2026-07-10',
      },
      {
        gcal_event_id: 'ok',
        valor_cents: 0,
        desconto_cents: 0,
        forma_pagamento: null,
        data: '2026-07-10',
      },
    ]);

    const { runGcalAtendSync } = await loadJob();
    const res = await runGcalAtendSync();

    // Só 'ok' foi upsertado (cancelled + all-day ignorados).
    expect(res.upserted).toBe(1);
    expect(upsertAtendimentoFromEvent.mock.calls[0][0].gcalEventId).toBe('ok');
    // 'cancel' está no banco mas ausente da agenda → deletado; 'ok' presente → mantido.
    expect(softDeleteAtendimentoByEvent).toHaveBeenCalledTimes(1);
    expect(softDeleteAtendimentoByEvent).toHaveBeenCalledWith(
      'clone_x',
      'cancel',
      {
        reason: 'gcal_sync_absent',
        by: 'gcal-atend-sync',
      },
      expect.any(Object),
    );
  });
});

describe('grace / corrida com hook', () => {
  it('listAgendaAtendimentosInWindow recebe updatedBefore ≈ início do ciclo - grace', async () => {
    getGcalForSlot.mockResolvedValue(pagedClient({ events: [], complete: true }));
    const before = Date.now();
    const { runGcalAtendSync } = await loadJob();
    await runGcalAtendSync();
    const after = Date.now();

    expect(listAgendaAtendimentosInWindow).toHaveBeenCalledTimes(1);
    const [slotArg, fromIso, toIso, updatedBeforeIso] = listAgendaAtendimentosInWindow.mock
      .calls[0] as [string, string, string, string];
    expect(slotArg).toBe('clone_x');
    // grace = 120s → updatedBefore fica ~120s no passado em relação ao início do ciclo.
    const ub = new Date(updatedBeforeIso).getTime();
    expect(ub).toBeLessThanOrEqual(after - 120_000 + 5); // margem
    expect(ub).toBeGreaterThanOrEqual(before - 120_000 - 5_000);
    // Janela de deleção coerente: from < to.
    expect(new Date(fromIso).getTime()).toBeLessThan(new Date(toIso).getTime());
  });
});

describe('janela de LISTAGEM — pad aplicado (SCRUM-90; mutante padMs=0 morre)', () => {
  it('timeMin = delFrom − LIST_PAD_DAYS e timeMax = delTo + LIST_PAD_DAYS', async () => {
    // Client com listEventsPaged CAPTURADO pra inspecionar os args da listagem.
    const listEventsPaged = vi.fn().mockResolvedValue({ pages: 1, events: [], complete: true });
    getGcalForSlot.mockResolvedValue({ listEventsPaged });

    const before = Date.now();
    const { runGcalAtendSync } = await loadJob();
    await runGcalAtendSync();
    const after = Date.now();

    expect(listEventsPaged).toHaveBeenCalledTimes(1);
    const arg = listEventsPaged.mock.calls[0][0] as { timeMin: string; timeMax: string };
    const timeMin = new Date(arg.timeMin).getTime();
    const timeMax = new Date(arg.timeMax).getTime();

    const DAY = 86_400_000;
    const LOOKBACK = 62; // GCAL_ATEND_SYNC_LOOKBACK_DAYS (config do loadJob)
    const LOOKAHEAD = 60; // GCAL_ATEND_SYNC_LOOKAHEAD_DAYS
    const PAD = 7; // GCAL_ATEND_SYNC_LIST_PAD_DAYS
    const TOL = 5_000; // margem do tempo de execução

    // listFrom = (nowMs − LOOKBACK·DAY) − PAD·DAY, nowMs ∈ [before, after]. Com PAD=0 (mutante) o
    // timeMin sobe 7 dias (>> TOL) e ESTOURA o teto abaixo → teste VERMELHO.
    expect(timeMin).toBeGreaterThanOrEqual(before - (LOOKBACK + PAD) * DAY - TOL);
    expect(timeMin).toBeLessThanOrEqual(after - (LOOKBACK + PAD) * DAY + TOL);
    // listTo = (nowMs + LOOKAHEAD·DAY) + PAD·DAY. Com PAD=0 o timeMax cai 7 dias → VERMELHO.
    expect(timeMax).toBeGreaterThanOrEqual(before + (LOOKAHEAD + PAD) * DAY - TOL);
    expect(timeMax).toBeLessThanOrEqual(after + (LOOKAHEAD + PAD) * DAY + TOL);
  });
});

describe('hashEventIdForLog (SCRUM-90 — id do log nunca é cru)', () => {
  it('devolve sha256:<16 hex>, determinístico, e NUNCA contém o id cru', async () => {
    const { hashEventIdForLog } = await loadJob();
    const raw = 'abc123EventoDaAgenda_xyz';
    const h = hashEventIdForLog(raw);
    expect(h).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(h).not.toContain(raw);
    expect(hashEventIdForLog(raw)).toBe(h); // determinístico
    expect(hashEventIdForLog('outro_evento')).not.toBe(h); // ids distintos → hashes distintos
  });
});

describe('isolamento por slot (regra de ouro 7)', () => {
  it('erro em 1 slot não derruba os demais', async () => {
    listAtendSyncSlots.mockResolvedValue([slot({ slot: 'clone_a' }), slot({ slot: 'clone_b' })]);
    getGcalForSlot.mockImplementation((s: string) => {
      if (s === 'clone_a') throw new Error('boom no A');
      return Promise.resolve(pagedClient({ events: [ev('e1')], complete: true }));
    });

    const { runGcalAtendSync } = await loadJob();
    const res = await runGcalAtendSync();

    expect(res.slots).toBe(2);
    expect(res.slotsWithError).toBe(1);
    expect(res.upserted).toBe(1); // clone_b processado apesar do erro em clone_a.
  });
});

describe('estabelecimento (N calendários)', () => {
  it('1 colaborador incompleto → nenhuma deleção no slot; upsert dos presentes segue', async () => {
    listAtendSyncSlots.mockResolvedValue([slot({ product_type: 'estabelecimento' })]);
    getGcalsForSlot.mockResolvedValue([
      { colaboradorId: 10, client: pagedClient({ events: [ev('a')], complete: true }) },
      {
        colaboradorId: 20,
        client: pagedClient({ events: [ev('b')], complete: false, incompleteReason: 'timeout' }),
      },
    ]);
    listAgendaAtendimentosInWindow.mockResolvedValue([
      {
        gcal_event_id: 'sumiu',
        valor_cents: 1,
        desconto_cents: 0,
        forma_pagamento: null,
        data: '2026-07-10',
      },
    ]);

    const { runGcalAtendSync } = await loadJob();
    const res = await runGcalAtendSync();

    // 2 eventos presentes upsertados; deleção pulada (um colaborador incompleto → AND falha).
    expect(res.upserted).toBe(2);
    expect(res.skippedIncomplete).toBe(1);
    expect(res.deleted).toBe(0);
    expect(softDeleteAtendimentoByEvent).not.toHaveBeenCalled();
    // upsert do colaborador 10 carrega o colaboradorId de origem.
    const idsPorColab = upsertAtendimentoFromEvent.mock.calls.map((c) => [
      c[0].gcalEventId,
      c[0].colaboradorId,
    ]);
    expect(idsPorColab).toEqual([
      ['a', 10],
      ['b', 20],
    ]);
  });

  // ── SCRUM-111: fail-safe de deleção POR colaborador ──────────────────────────────
  // Bug de dinheiro: no estabelecimento a listagem é POR colaborador. Se UM colaborador some de
  // getGcalsForSlot (dropout parcial: gcal_status virou != active, calendarId caiu), o ciclo
  // ainda marca complete=true (todos os ENTREGUES vieram por inteiro) e o reconciler conclui que
  // TODO evento daquele colaborador "sumiu da agenda" → soft-delete em massa com motivo FALSO.
  it('dropout parcial (colaborador some de getGcalsForSlot, complete=true) → atendimento dele NÃO é deletado e o skip é logado/contado', async () => {
    listAtendSyncSlots.mockResolvedValue([slot({ product_type: 'estabelecimento' })]);
    // Só o colaborador 10 foi ENTREGUE (listagem completa). O colaborador 20 sumiu da lista.
    getGcalsForSlot.mockResolvedValue([
      { colaboradorId: 10, client: pagedClient({ events: [ev('a10')], complete: true }) },
    ]);
    // No banco há uma linha bilhetada do colaborador 20 (o que sumiu) ausente do presentIds.
    listAgendaAtendimentosInWindow.mockResolvedValue([
      {
        gcal_event_id: 'ag20',
        valor_cents: 11000,
        desconto_cents: 0,
        forma_pagamento: 'pix',
        data: '2026-07-10',
        colaborador_id: 20,
      },
    ]);

    const { runGcalAtendSync } = await loadJob();
    const res = await runGcalAtendSync();

    // Sem o fix: complete=true + evento fora do presentIds → seria DELETADO (motivo falso).
    expect(res.deleted).toBe(0);
    expect(softDeleteAtendimentoByEvent).not.toHaveBeenCalled();
    expect(res.deletionsSkippedColabAbsent).toBe(1);
    // O upsert do colaborador presente segue normal.
    expect(res.upserted).toBe(1);
    // Skip logado pra visibilidade (antes o dropout preservava em silêncio).
    const skipLog = logWarn.mock.calls.find((c) => String(c[1]).includes('fail-safe SCRUM-111'));
    expect(skipLog).toBeDefined();
    const payload = skipLog?.[0] as Record<string, unknown>;
    expect(payload.skippedRows).toBe(1);
    expect(payload.absentColabIds).toEqual([20]);
  });

  it('listagem completa dos 2 colaboradores → deleção normal do evento que sumiu DE VERDADE', async () => {
    listAtendSyncSlots.mockResolvedValue([slot({ product_type: 'estabelecimento' })]);
    getGcalsForSlot.mockResolvedValue([
      { colaboradorId: 10, client: pagedClient({ events: [ev('a10')], complete: true }) },
      { colaboradorId: 20, client: pagedClient({ events: [ev('b20')], complete: true }) },
    ]);
    // 'a10' presente → mantém; 'sumiu20' (colaborador 20) não está na agenda → deleta de verdade.
    listAgendaAtendimentosInWindow.mockResolvedValue([
      {
        gcal_event_id: 'a10',
        valor_cents: 5000,
        desconto_cents: 0,
        forma_pagamento: null,
        data: '2026-07-10',
        colaborador_id: 10,
      },
      {
        gcal_event_id: 'sumiu20',
        valor_cents: 9000,
        desconto_cents: 0,
        forma_pagamento: 'pix',
        data: '2026-07-10',
        colaborador_id: 20,
      },
    ]);

    const { runGcalAtendSync } = await loadJob();
    const res = await runGcalAtendSync();

    expect(res.deleted).toBe(1);
    expect(res.deletionsSkippedColabAbsent).toBe(0);
    expect(softDeleteAtendimentoByEvent).toHaveBeenCalledTimes(1);
    expect(softDeleteAtendimentoByEvent).toHaveBeenCalledWith(
      'clone_x',
      'sumiu20',
      {
        reason: 'gcal_sync_absent',
        by: 'gcal-atend-sync',
      },
      expect.any(Object),
    );
  });
});

describe('gate + tenant', () => {
  it('troca agenda→atendente durante await do GCal não grava nem deleta (TOCTOU)', async () => {
    let liberarSnapshot: (() => void) | undefined;
    const snapshotPendente = new Promise<void>((resolve) => {
      liberarSnapshot = resolve;
    });
    let modoAtual: 'agenda' | 'atendente' = 'agenda';
    let escritasPersistidas = 0;
    let deletesPersistidos = 0;

    getGcalForSlot.mockResolvedValue({
      listEventsPaged: vi.fn().mockImplementation(async () => {
        await snapshotPendente;
        return { pages: 1, events: [ev('presente')], complete: true };
      }),
    });
    listAgendaAtendimentosInWindow.mockResolvedValue([
      {
        gcal_event_id: 'evento-pago-preservado',
        valor_cents: 15_000,
        desconto_cents: 0,
        forma_pagamento: 'pix',
        data: '2026-08-01',
      },
    ]);
    upsertAtendimentoFromEvent.mockImplementation(async (input: Record<string, unknown>) => {
      if (input.syncModeGuard && modoAtual === 'atendente') return null;
      escritasPersistidas++;
      return { id: 1 };
    });
    softDeleteAtendimentoByEvent.mockImplementation(
      async (_slot: string, _eventId: string, _audit: unknown, syncModeGuard: unknown) => {
        if (syncModeGuard && modoAtual === 'atendente') return null;
        deletesPersistidos++;
        return { id: 2 };
      },
    );

    const { runGcalAtendSync } = await loadJob();
    const ciclo = runGcalAtendSync();
    await vi.waitFor(() => expect(getGcalForSlot).toHaveBeenCalledTimes(1));
    modoAtual = 'atendente';
    liberarSnapshot?.();
    const res = await ciclo;

    expect(escritasPersistidas).toBe(0);
    expect(deletesPersistidos).toBe(0);
    expect(res.upserted).toBe(0);
    expect(res.deleted).toBe(0);
  });

  it('modo efetivo atendente não reconcilia nem soft-delete atendimento pago', async () => {
    listAtendSyncSlots.mockResolvedValue([
      slot({ modo_atendente_enabled: true, agenda_automatica: 'false' }),
    ]);
    listAgendaAtendimentosInWindow.mockResolvedValue([
      {
        gcal_event_id: 'evento-pago-preservado',
        valor_cents: 15_000,
        desconto_cents: 0,
        forma_pagamento: 'pix',
        data: '2026-08-01',
      },
    ]);

    const { runGcalAtendSync } = await loadJob();
    const res = await runGcalAtendSync();

    expect(res.upserted).toBe(0);
    expect(res.deleted).toBe(0);
    expect(res.skippedEffectiveAtendente).toBe(1);
    expect(getGcalForSlot).not.toHaveBeenCalled();
    expect(loadSlotPricing).not.toHaveBeenCalled();
    expect(listAgendaAtendimentosInWindow).not.toHaveBeenCalled();
    expect(softDeleteAtendimentoByEvent).not.toHaveBeenCalled();
  });

  it('gate atendente vindo só da env também preserva e pula o slot', async () => {
    listAtendSyncSlots.mockResolvedValue([
      slot({ modo_atendente_enabled: false, agenda_automatica: false }),
    ]);

    const { runGcalAtendSync } = await loadJob({ MODO_ATENDENTE_SLOTS: 'clone_x' });
    const res = await runGcalAtendSync();

    expect(res.skippedEffectiveAtendente).toBe(1);
    expect(getGcalForSlot).not.toHaveBeenCalled();
    expect(upsertAtendimentoFromEvent).not.toHaveBeenCalled();
    expect(softDeleteAtendimentoByEvent).not.toHaveBeenCalled();
  });

  it('gate reconfirmado false → slot pulado (zero upsert/delete)', async () => {
    resolveAtendFromAgendaEnabledForSlot.mockResolvedValue(false);
    getGcalForSlot.mockResolvedValue(pagedClient({ events: [ev('e1')], complete: true }));

    const { runGcalAtendSync } = await loadJob();
    const res = await runGcalAtendSync();

    expect(res.upserted).toBe(0);
    expect(res.deleted).toBe(0);
    expect(getGcalForSlot).not.toHaveBeenCalled();
  });

  it('tenant_id nulo → slot pulado', async () => {
    listAtendSyncSlots.mockResolvedValue([slot({ tenant_id: null })]);
    getGcalForSlot.mockResolvedValue(pagedClient({ events: [ev('e1')], complete: true }));

    const { runGcalAtendSync } = await loadJob();
    const res = await runGcalAtendSync();

    expect(res.upserted).toBe(0);
    expect(getGcalForSlot).not.toHaveBeenCalled();
  });

  it('gcal não configurado (getGcalForSlot null) → slot pulado, zero delete', async () => {
    getGcalForSlot.mockResolvedValue(null);
    listAgendaAtendimentosInWindow.mockResolvedValue([
      {
        gcal_event_id: 'sumiu',
        valor_cents: 1,
        desconto_cents: 0,
        forma_pagamento: null,
        data: '2026-07-10',
      },
    ]);

    const { runGcalAtendSync } = await loadJob();
    const res = await runGcalAtendSync();

    expect(res.deleted).toBe(0);
    expect(softDeleteAtendimentoByEvent).not.toHaveBeenCalled();
    expect(listAgendaAtendimentosInWindow).not.toHaveBeenCalled();
  });
});

// Matcher puro (SCRUM-129) — sem I/O. normalizeServiceName vem do mock de @startap/db abaixo;
// aqui exercitamos as 4 camadas: exato → normalizado → uniforme → none.
function pricing(over: Partial<import('@startap/db').atendimentos.SlotPricing> = {}) {
  return {
    byNameLower: new Map<string, number>(),
    byNameNormalized: new Map<string, number>(),
    uniformPriceCents: null,
    ...over,
  } as import('@startap/db').atendimentos.SlotPricing;
}

describe('resolvePreco (matcher em camadas — SCRUM-129)', () => {
  it('match EXATO case-insensitive/trim', async () => {
    const { resolvePreco } = await loadJob();
    const p = pricing({ byNameLower: new Map([['corte', 5000]]) });
    expect(resolvePreco(p, '  Corte ')).toEqual({ cents: 5000, match: 'exact' });
  });

  it('match NORMALIZADO (acento + caixa + espaços internos)', async () => {
    const { resolvePreco } = await loadJob();
    const p = pricing({
      byNameLower: new Map([['corte masculino', 4500]]),
      byNameNormalized: new Map([['corte masculino', 4500]]),
    });
    // Acento diferente e espaço duplo: não bate no byNameLower, bate no normalizado.
    expect(resolvePreco(p, 'Córte  Masculino')).toEqual({ cents: 4500, match: 'normalized' });
  });

  it('serviço FORA do catálogo (não-uniforme) → 0 / none', async () => {
    const { resolvePreco } = await loadJob();
    const p = pricing({
      byNameLower: new Map([['barba', 3000]]),
      byNameNormalized: new Map([['barba', 3000]]),
    });
    expect(resolvePreco(p, 'Progressiva')).toEqual({ cents: 0, match: 'none' });
  });

  it('serviço vazio + catálogo uniforme → uniforme', async () => {
    const { resolvePreco } = await loadJob();
    const p = pricing({ uniformPriceCents: 11000 });
    expect(resolvePreco(p, '')).toEqual({ cents: 11000, match: 'uniform' });
  });

  it('exato tem prioridade sobre normalizado', async () => {
    const { resolvePreco } = await loadJob();
    const p = pricing({
      byNameLower: new Map([['corte', 5000]]),
      byNameNormalized: new Map([['corte', 9999]]),
    });
    expect(resolvePreco(p, 'corte')).toEqual({ cents: 5000, match: 'exact' });
  });
});
