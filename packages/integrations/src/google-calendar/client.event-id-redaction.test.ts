/**
 * LGPD — nenhum identificador, query ou corpo externo do GCal escapa pelo caminho de ERRO.
 *
 * `deleteEvent`/`patchEvent` montam a URL com calendarId e eventId, e a resposta do Google
 * pode ecoar qualquer dado externo. Como a exceção atravessa callers que logam `err`, a
 * integração só pode expor operação/endpoint categorizados, status HTTP e enum fechado.
 *
 * Este teste ataca a CLASSE no ponto de SAÍDA da integração (gcalFetch): nem a mensagem
 * lançada, nem o log do módulo podem conter o id cru — em NENHUM dos dois canais.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { logSpies } = vi.hoisted(() => ({
  logSpies: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => logSpies },
}));

import {
  GCAL_REQUEST_TIMEOUT_MS,
  GCAL_REQUEST_TIMEOUT_SENTINEL,
  GoogleCalendarClient,
} from './client.js';

const SA_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'sa@fake.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
});

const CAL_ID = 'cal-teste@group.calendar.google.com';

/** Id realista do Google: alfanumérico longo, é o identificador que re-identifica o atendimento. */
const RAW_EVENT_ID = '6k3jd9plq7v2c1hs8tnu4bgoim';

function makeClient(): GoogleCalendarClient {
  const c = new GoogleCalendarClient({ credentialsJson: SA_JSON, calendarId: CAL_ID });
  vi.spyOn(
    c as unknown as { getAccessToken: () => Promise<string> },
    'getAccessToken',
  ).mockResolvedValue('fake-token');
  return c;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  logSpies.info.mockClear();
  logSpies.warn.mockClear();
  logSpies.error.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Resposta de erro do Google. O corpo REAL do Google ecoa o recurso pedido — por isso o
 * id cru aparece DUAS vezes: no path da URL e dentro do JSON de erro.
 */
function errorResponse(status: number, body: string) {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

const GOOGLE_404_BODY = JSON.stringify({
  error: {
    code: 404,
    message: 'Not Found',
    errors: [{ domain: 'global', reason: 'notFound', message: `Event not found: ${RAW_EVENT_ID}` }],
  },
});

/** Todos os args de todos os níveis logados pelo módulo google-calendar. */
function loggedPayload(): string {
  return JSON.stringify([
    ...logSpies.info.mock.calls,
    ...logSpies.warn.mock.calls,
    ...logSpies.error.mock.calls,
  ]);
}

describe('SCRUM-148 — deleteEvent: id cru não escapa pelo erro', () => {
  it('a mensagem do erro lançado expõe só endpoint categorizado, HTTP e enum', async () => {
    fetchMock.mockResolvedValue(errorResponse(404, GOOGLE_404_BODY));
    const client = makeClient();

    const err = await client.deleteEvent(RAW_EVENT_ID).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err).toBeInstanceOf(Error);
    // A falha continua diagnosticável (status preservado)…
    expect(err?.message).toContain('404');
    // …mas o id cru sumiu — do path E do corpo ecoado pelo Google.
    expect(err?.message).not.toContain(RAW_EVENT_ID);
    expect(err?.message).not.toContain(CAL_ID);
    expect(err?.message).toContain('delete:event');
    expect(err?.message).toContain('[not_found]');
  });

  it('o log do módulo (canal 2) também não carrega o id cru', async () => {
    fetchMock.mockResolvedValue(errorResponse(404, GOOGLE_404_BODY));
    const client = makeClient();

    await client.deleteEvent(RAW_EVENT_ID).catch(() => undefined);

    const logged = loggedPayload();
    expect(logged.length).toBeGreaterThan(2);
    expect(logged).not.toContain(RAW_EVENT_ID);
  });
});

describe('SCRUM-148 — patchEvent: id cru não escapa pelo erro', () => {
  it('mensagem lançada e log do módulo ficam sem o id cru', async () => {
    fetchMock.mockResolvedValue(errorResponse(403, GOOGLE_404_BODY));
    const client = makeClient();

    const err = await client.patchEvent(RAW_EVENT_ID, { summary: 'Remarcado' }).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err?.message).toContain('403');
    expect(err?.message).not.toContain(RAW_EVENT_ID);
    expect(loggedPayload()).not.toContain(RAW_EVENT_ID);
  });
});

describe('SCRUM-148 — a redação não estraga o diagnóstico', () => {
  it('erro de coleção não registra calendarId, query nem corpo externo', async () => {
    const externalEmail = 'cliente.sensivel@example.test';
    const externalPhone = '+5511999999999';
    const externalToken = 'token-externo-nao-logar';
    const body = JSON.stringify({
      error: {
        code: 400,
        message: `${externalEmail} ${externalPhone} ${externalToken}`,
      },
    });
    fetchMock.mockResolvedValue(errorResponse(500, body));
    const client = makeClient();

    const err = await client
      .listEvents({
        timeMin: '2026-07-01T14:00:00-03:00',
        timeMax: '2026-07-01T14:30:00-03:00',
      })
      .then(
        () => null,
        (e: unknown) => e as Error,
      );

    const output = `${err?.message ?? ''}\n${loggedPayload()}`;
    for (const marker of [
      CAL_ID,
      encodeURIComponent(CAL_ID),
      externalEmail,
      externalPhone,
      externalToken,
    ]) {
      expect(output).not.toContain(marker);
    }
    expect(err?.message).toContain('read:events_collection');
    expect(err?.message).toContain('HTTP 500');
    expect(err?.message).toContain('[server_error]');
    expect(logSpies.error).toHaveBeenCalledWith(
      {
        endpoint: 'events_collection',
        operation: 'read',
        http_status: 500,
        error_class: 'server_error',
      },
      'GCal HTTP error',
    );
  });

  it('converte falha textual do tokenFn em erro seguro antes de chegar ao caller', async () => {
    const externalFailure = 'falha externa com marcador que não pode propagar';
    const client = makeClient();
    vi.spyOn(
      client as unknown as { getAccessToken: () => Promise<string> },
      'getAccessToken',
    ).mockRejectedValue(new Error(externalFailure));

    const err = await client
      .listEvents({ timeMin: '2026-07-01T14:00:00Z', timeMax: '2026-07-01T15:00:00Z' })
      .then(
        () => null,
        (e: unknown) => e as Error,
      );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(err?.message).toBe('GCal other:unknown -> [network_error]');
    expect(err?.message).not.toContain(externalFailure);
    expect(loggedPayload()).not.toContain(externalFailure);
  });
});

describe('ADR 0044 — timeout de request cercado pela lease de dispatch', () => {
  it('encerra aquisição de token pendurada sem sequer iniciar POST externo', async () => {
    vi.useFakeTimers();
    try {
      const client = makeClient();
      vi.spyOn(
        client as unknown as { getAccessToken: () => Promise<string> },
        'getAccessToken',
      ).mockImplementation(() => new Promise<string>(() => {}));
      const pending = client.createEvent({
        eventId: RAW_EVENT_ID,
        summary: 'Bloqueio',
        startISO: '2026-07-01T14:00:00-03:00',
        endISO: '2026-07-01T14:30:00-03:00',
      });
      const timeoutExpectation = expect(pending).rejects.toThrow(GCAL_REQUEST_TIMEOUT_SENTINEL);

      await vi.advanceTimersByTimeAsync(GCAL_REQUEST_TIMEOUT_MS);

      await timeoutExpectation;
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborta POST pendurado antes de uma lease de 60 segundos poder expirar', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            signal?.addEventListener('abort', () => reject(new Error('AbortError')), {
              once: true,
            });
          }),
      );
      const client = makeClient();
      const pending = client.createEvent({
        eventId: RAW_EVENT_ID,
        summary: 'Bloqueio',
        startISO: '2026-07-01T14:00:00-03:00',
        endISO: '2026-07-01T14:30:00-03:00',
      });
      const timeoutExpectation = expect(pending).rejects.toThrow(GCAL_REQUEST_TIMEOUT_SENTINEL);

      await vi.advanceTimersByTimeAsync(GCAL_REQUEST_TIMEOUT_MS);

      await timeoutExpectation;
      expect(GCAL_REQUEST_TIMEOUT_MS).toBeLessThan(60_000);
      expect(fetchMock.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({ signal: expect.objectContaining({ aborted: true }) }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('encerra parse de body pendurado antes de uma lease poder expirar', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => new Promise<unknown>(() => {}),
      } as unknown as Response);
      const client = makeClient();
      const pending = client.createEvent({
        eventId: RAW_EVENT_ID,
        summary: 'Bloqueio',
        startISO: '2026-07-01T14:00:00-03:00',
        endISO: '2026-07-01T14:30:00-03:00',
      });
      const timeoutExpectation = expect(pending).rejects.toThrow(GCAL_REQUEST_TIMEOUT_SENTINEL);

      await vi.advanceTimersByTimeAsync(GCAL_REQUEST_TIMEOUT_MS);

      await timeoutExpectation;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(GCAL_REQUEST_TIMEOUT_MS).toBeLessThan(60_000);
      expect(fetchMock.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({ signal: expect.objectContaining({ aborted: true }) }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
