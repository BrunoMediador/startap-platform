/**
 * Testes do job runGcalHealthcheck (health-check do Google Calendar — SCRUM-27).
 *
 * `@startap/db` (gcalHealth), `@startap/integrations` (gcal.GoogleCalendarClient),
 * `@startap/core` (decryptSecret + logger) e `../config.js` são MOCKADOS — sem banco,
 * sem rede, sem chave de cripto real. A orquestração (classificação do erro, guarda do
 * UPDATE, teto/orçamento por ciclo, fail-safe por item) é coberta de ponta a ponta.
 *
 * Cobre:
 *  - caminho feliz: agenda 'active' que valida OK -> setIndividualGcalStatus('active') + healthy.
 *  - DEMOÇÃO: HTTP 403 forbidden REAL (SA sem permissão) -> setIndividualGcalStatus('invalid') + demoted.
 *  - INCONCLUSIVO conservador: HTTP 503 (transitório) -> NÃO escreve status (preserva), inconclusive.
 *  - SCRUM-41: HTTP 403 rate-limit/quota (rateLimitExceeded/userRateLimitExceeded/quotaExceeded) e
 *    HTTP 429 -> NÃO demovem (o `reason` do corpo distingue rate-limit de forbidden), inconclusive.
 *  - colaborador (estabelecimento) demovido por 404; e preservado em 403 rate-limit.
 *  - fail-safe: erro num item NÃO derruba o ciclo nem afeta os outros.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks dos módulos externos ao job ───────────────────────────────────────────
const listActiveIndividualGcals = vi.fn();
const listActiveColaboradorGcals = vi.fn();
const setIndividualGcalStatus = vi.fn();
const setColaboradorGcalStatus = vi.fn();
const testConnection = vi.fn();

vi.mock('@startap/db', () => ({
  gcalHealth: {
    listActiveIndividualGcals,
    listActiveColaboradorGcals,
    setIndividualGcalStatus,
    setColaboradorGcalStatus,
  },
}));

vi.mock('@startap/integrations', () => ({
  gcal: {
    // Client fake: construtor default aceita { credentialsJson, calendarId } e o
    // testConnection delega ao mock controlado pelos testes.
    GoogleCalendarClient: class {
      testConnection() {
        return testConnection();
      }
    },
  },
}));

// decryptSecret devolve a entrada (sem cripto real). logger.child -> no-op.
vi.mock('@startap/core', () => ({
  decryptSecret: (s: string) => s,
}));
vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

async function loadJob() {
  vi.resetModules();
  vi.doMock('../config.js', () => ({
    config: {
      GCAL_HEALTHCHECK_ENABLED: true,
      GCAL_HEALTHCHECK_CRON: '23 */2 * * *',
      GCAL_HEALTHCHECK_MAX_PER_RUN: 50,
      GCAL_HEALTHCHECK_TIMEOUT_MS: 8000,
    },
  }));
  return import('./gcal-healthcheck.js');
}

function individual(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    slot: 'clone_barbearia_xyz',
    gcal_credentials_json: 'enc:creds',
    gcal_calendar_id: 'cal@group.calendar.google.com',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // defaults: nenhuma agenda; UPDATEs reportam 1 linha mudada.
  listActiveIndividualGcals.mockResolvedValue([]);
  listActiveColaboradorGcals.mockResolvedValue([]);
  setIndividualGcalStatus.mockResolvedValue(1);
  setColaboradorGcalStatus.mockResolvedValue(1);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runGcalHealthcheck', () => {
  it('caminho feliz: agenda active valida OK -> mantém active e carimba (healthy)', async () => {
    listActiveIndividualGcals.mockResolvedValue([individual()]);
    testConnection.mockResolvedValue({ ok: true });

    const { runGcalHealthcheck } = await loadJob();
    const r = await runGcalHealthcheck();

    expect(setIndividualGcalStatus).toHaveBeenCalledWith(1, 'active');
    expect(r).toMatchObject({ scanned: 1, healthy: 1, demoted: 0, inconclusive: 0 });
  });

  it('DEMOÇÃO: falha definitiva (HTTP 403) -> status vira invalid (active mentiroso corrigido)', async () => {
    listActiveIndividualGcals.mockResolvedValue([individual()]);
    testConnection.mockResolvedValue({
      ok: false,
      error: 'GCal /calendars/cal/events -> HTTP 403: forbidden',
    });

    const { runGcalHealthcheck } = await loadJob();
    const r = await runGcalHealthcheck();

    expect(setIndividualGcalStatus).toHaveBeenCalledWith(1, 'invalid');
    expect(r).toMatchObject({ scanned: 1, healthy: 0, demoted: 1, inconclusive: 0 });
  });

  it('CONSERVADOR: falha transitória (HTTP 503) NÃO demove — status preservado (inconclusive)', async () => {
    listActiveIndividualGcals.mockResolvedValue([individual()]);
    testConnection.mockResolvedValue({
      ok: false,
      error: 'GCal /calendars/cal/events -> HTTP 503: backend error',
    });

    const { runGcalHealthcheck } = await loadJob();
    const r = await runGcalHealthcheck();

    expect(setIndividualGcalStatus).not.toHaveBeenCalled();
    expect(r).toMatchObject({ scanned: 1, healthy: 0, demoted: 0, inconclusive: 1 });
  });

  // ── SCRUM-41: 403 rate-limit é TRANSITÓRIO (não pode rebaixar agenda boa num pico) ──
  it('SCRUM-41: HTTP 403 rateLimitExceeded NÃO demove — status preservado (inconclusive)', async () => {
    listActiveIndividualGcals.mockResolvedValue([individual()]);
    testConnection.mockResolvedValue({
      ok: false,
      error:
        'GCal /calendars/cal/events -> HTTP 403: {"error":{"errors":[{"domain":"usageLimits","reason":"rateLimitExceeded","message":"Rate Limit Exceeded"}],"code":403,"message":"Rate Limit Exceeded"}}',
    });

    const { runGcalHealthcheck } = await loadJob();
    const r = await runGcalHealthcheck();

    // NÃO escreve status: um 403 de rate-limit não é sinal de agenda quebrada.
    expect(setIndividualGcalStatus).not.toHaveBeenCalled();
    expect(r).toMatchObject({ scanned: 1, healthy: 0, demoted: 0, inconclusive: 1 });
  });

  it('SCRUM-148: enum seguro rate_limited em HTTP 403 NÃO demove — status preservado', async () => {
    listActiveIndividualGcals.mockResolvedValue([individual()]);
    testConnection.mockResolvedValue({
      ok: false,
      error: 'GCal read:events_collection -> HTTP 403 [rate_limited]',
    });

    const { runGcalHealthcheck } = await loadJob();
    const r = await runGcalHealthcheck();

    expect(setIndividualGcalStatus).not.toHaveBeenCalled();
    expect(r).toMatchObject({ scanned: 1, healthy: 0, demoted: 0, inconclusive: 1 });
  });

  it('SCRUM-41: HTTP 403 userRateLimitExceeded / quotaExceeded NÃO demovem (inconclusive)', async () => {
    for (const reason of ['userRateLimitExceeded', 'quotaExceeded']) {
      vi.clearAllMocks();
      listActiveIndividualGcals.mockResolvedValue([individual()]);
      setIndividualGcalStatus.mockResolvedValue(1);
      testConnection.mockResolvedValue({
        ok: false,
        error: `GCal /calendars/cal/events -> HTTP 403: {"error":{"errors":[{"domain":"usageLimits","reason":"${reason}"}],"code":403}}`,
      });

      const { runGcalHealthcheck } = await loadJob();
      const r = await runGcalHealthcheck();

      expect(setIndividualGcalStatus).not.toHaveBeenCalled();
      expect(r).toMatchObject({ scanned: 1, demoted: 0, inconclusive: 1 });
    }
  });

  it('SCRUM-41: HTTP 403 forbidden REAL (SA sem permissão) SEGUE demovendo pra invalid', async () => {
    listActiveIndividualGcals.mockResolvedValue([individual()]);
    testConnection.mockResolvedValue({
      ok: false,
      error:
        'GCal /calendars/cal/events -> HTTP 403: {"error":{"errors":[{"domain":"global","reason":"forbidden","message":"Forbidden"}],"code":403,"message":"Forbidden"}}',
    });

    const { runGcalHealthcheck } = await loadJob();
    const r = await runGcalHealthcheck();

    expect(setIndividualGcalStatus).toHaveBeenCalledWith(1, 'invalid');
    expect(r).toMatchObject({ scanned: 1, demoted: 1, inconclusive: 0 });
  });

  it('SCRUM-41: HTTP 429 (Too Many Requests) NÃO demove — transitório (inconclusive)', async () => {
    listActiveIndividualGcals.mockResolvedValue([individual()]);
    testConnection.mockResolvedValue({
      ok: false,
      error: 'GCal /calendars/cal/events -> HTTP 429: rate limited',
    });

    const { runGcalHealthcheck } = await loadJob();
    const r = await runGcalHealthcheck();

    expect(setIndividualGcalStatus).not.toHaveBeenCalled();
    expect(r).toMatchObject({ scanned: 1, demoted: 0, inconclusive: 1 });
  });

  it('SCRUM-41: colaborador com 403 rateLimitExceeded NÃO é demovido (inconclusive)', async () => {
    listActiveColaboradorGcals.mockResolvedValue([
      {
        colaborador_id: 7,
        slot: 'clone_barber_dragon_caly8b',
        gcal_calendar_id: 'colab@group.calendar.google.com',
        clone_credentials_json: 'enc:clonecreds',
      },
    ]);
    testConnection.mockResolvedValue({
      ok: false,
      error:
        'GCal /calendars/colab/events -> HTTP 403: {"error":{"errors":[{"reason":"userRateLimitExceeded"}],"code":403}}',
    });

    const { runGcalHealthcheck } = await loadJob();
    const r = await runGcalHealthcheck();

    expect(setColaboradorGcalStatus).not.toHaveBeenCalled();
    expect(r).toMatchObject({ scanned: 1, demoted: 0, inconclusive: 1 });
  });

  it('colaborador (estabelecimento) com 404 -> invalid', async () => {
    listActiveColaboradorGcals.mockResolvedValue([
      {
        colaborador_id: 7,
        slot: 'clone_barber_dragon_caly8b',
        gcal_calendar_id: 'colab@group.calendar.google.com',
        clone_credentials_json: 'enc:clonecreds',
      },
    ]);
    testConnection.mockResolvedValue({
      ok: false,
      error: 'GCal /calendars/colab/events -> HTTP 404: notFound',
    });

    const { runGcalHealthcheck } = await loadJob();
    const r = await runGcalHealthcheck();

    expect(setColaboradorGcalStatus).toHaveBeenCalledWith(7, 'invalid');
    expect(r).toMatchObject({ scanned: 1, demoted: 1 });
  });

  it('fail-safe: erro no UPDATE de um item NÃO derruba o ciclo nem afeta os outros', async () => {
    listActiveIndividualGcals.mockResolvedValue([individual({ id: 1 }), individual({ id: 2 })]);
    testConnection.mockResolvedValue({ ok: true });
    // O 1º UPDATE explode; o 2º segue normal.
    setIndividualGcalStatus.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(1);

    const { runGcalHealthcheck } = await loadJob();
    const r = await runGcalHealthcheck();

    expect(r.scanned).toBe(2);
    expect(r.healthy).toBe(1); // o 2º item passou
    expect(r.inconclusive).toBe(1); // o 1º caiu no catch do item
  });
});
