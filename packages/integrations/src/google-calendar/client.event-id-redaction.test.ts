/**
 * SCRUM-148 (LGPD, art. 12 §2) — o gcal_event_id NUNCA escapa CRU pelo caminho de ERRO.
 *
 * O SCRUM-91 hasheou o `eventId` nos ~16 pontos de log do portal, mas hasheou o CAMPO
 * `eventId` — e não a MENSAGEM DE ERRO que viaja ao lado dele. Como `deleteEvent`/`patchEvent`
 * montam a URL com o eventId CRU no path (`/calendars/<cal>/events/<eventId>`) e o erro HTTP
 * é construído como `GCal ${path} -> HTTP ${status}: ${text}`, todo log do tipo
 * `{ eventId: hashEventIdForLog(id), err: msg }` publicava o hash no campo certo e o ID CRU
 * dentro do `err`. O corpo de resposta do Google (`text`) também ecoa o id.
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

import { hashEventIdForLog } from '@startap/core/gcal-event-log';
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
  it('a mensagem do erro lançado NÃO contém o eventId cru (vai hasheado)', async () => {
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
    // E o hash determinístico do SCRUM-91 continua permitindo correlação cross-serviço.
    expect(err?.message).toContain(hashEventIdForLog(RAW_EVENT_ID));
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
  it('erro SEM event id no path (createEvent/list) permanece intacto', async () => {
    const body = JSON.stringify({ error: { code: 500, message: 'Backend Error' } });
    fetchMock.mockResolvedValue(errorResponse(500, body));
    const client = makeClient();

    const err = await client
      .createEvent({
        summary: 'Corte',
        startISO: '2026-07-01T14:00:00-03:00',
        endISO: '2026-07-01T14:30:00-03:00',
      })
      .then(
        () => null,
        (e: unknown) => e as Error,
      );

    // Nada a redigir aqui: a mensagem do Google chega inteira pro debug.
    expect(err?.message).toContain('Backend Error');
    expect(err?.message).toContain('500');
  });
});

describe('ADR 0044 — timeout de request cercado pela lease de dispatch', () => {
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
});
