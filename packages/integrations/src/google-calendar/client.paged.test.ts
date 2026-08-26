/**
 * Testes do GoogleCalendarClient.listEventsPaged (SCRUM-89 / ADR 0031).
 *
 * Foco: o paginador segue `nextPageToken` e devolve o SINAL DE COMPLETUDE que o reconciler usa pra
 * decidir se pode DELETAR (só sobre listagem completa). getAccessToken é stubado; o fetch global é
 * mockado pra controlar páginas, erro HTTP e timeout (AbortController).
 *
 * Cobre:
 *  - 1 página sem nextPageToken → complete=true, pages=1, todos os events.
 *  - 3 páginas encadeadas por token → junta tudo, complete=true, pages=3.
 *  - token ainda pendente ao atingir maxPages → complete=false ('truncated_max_pages'), events do que veio.
 *  - erro HTTP na 2ª página → complete=false (não lança), events só da 1ª.
 *  - timeout (abort) → complete=false (sentinel de timeout).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { logSpies } = vi.hoisted(() => ({
  logSpies: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => logSpies },
}));

import { GCAL_LIST_TIMEOUT_SENTINEL, GoogleCalendarClient } from './client.js';

const SA_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'sa@fake.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
});
const CAL_ID = 'cal-teste@group.calendar.google.com';
const WINDOW = { timeMin: '2026-05-01T00:00:00.000Z', timeMax: '2026-09-01T00:00:00.000Z' };

function makeClient(): GoogleCalendarClient {
  const c = new GoogleCalendarClient({ credentialsJson: SA_JSON, calendarId: CAL_ID });
  vi.spyOn(
    c as unknown as { getAccessToken: () => Promise<string> },
    'getAccessToken',
  ).mockResolvedValue('fake-token');
  return c;
}

function pageResponse(items: Array<{ id: string }>, nextPageToken?: string) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ items, ...(nextPageToken ? { nextPageToken } : {}) }),
    text: () => Promise.resolve(''),
  } as unknown as Response;
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

describe('listEventsPaged — completude natural', () => {
  it('1 página sem nextPageToken → complete=true, pages=1', async () => {
    const client = makeClient();
    fetchMock.mockResolvedValueOnce(pageResponse([{ id: 'e1' }, { id: 'e2' }]));

    const out = await client.listEventsPaged(WINDOW);

    expect(out.complete).toBe(true);
    expect(out.pages).toBe(1);
    expect(out.events.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('3 páginas encadeadas por token → junta tudo, complete=true, pages=3', async () => {
    const client = makeClient();
    fetchMock
      .mockResolvedValueOnce(pageResponse([{ id: 'a' }], 'tok1'))
      .mockResolvedValueOnce(pageResponse([{ id: 'b' }], 'tok2'))
      .mockResolvedValueOnce(pageResponse([{ id: 'c' }])); // sem token → fim

    const out = await client.listEventsPaged({ ...WINDOW, maxPages: 10 });

    expect(out.complete).toBe(true);
    expect(out.pages).toBe(3);
    expect(out.events.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    // 2ª chamada leva o pageToken da 1ª.
    const [url2] = fetchMock.mock.calls[1] as [string];
    expect(url2).toContain('pageToken=tok1');
  });
});

describe('listEventsPaged — incompletude (não deletar sobre isto)', () => {
  it('token pendente ao atingir maxPages → complete=false, truncated_max_pages', async () => {
    const client = makeClient();
    // Toda página devolve token → nunca esgota; o teto corta.
    fetchMock.mockResolvedValue(pageResponse([{ id: 'x' }], 'always-more'));

    const out = await client.listEventsPaged({ ...WINDOW, maxPages: 2 });

    expect(out.complete).toBe(false);
    expect(out.incompleteReason).toEqual({ code: 'truncated_max_pages' });
    expect(out.pages).toBe(2);
    expect(out.events).toHaveLength(2); // os itens das 2 páginas ainda vêm (upsert seguro).
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('erro HTTP na 2ª página só devolve classificação estruturada e não vaza resposta externa', async () => {
    const externalEmail = 'cliente.sensivel@example.test';
    const externalPhone = '+5511999999999';
    const externalToken = 'token-externo-nao-logar';
    const body = JSON.stringify({
      error: { message: `${externalEmail} ${externalPhone} ${externalToken}` },
    });
    const client = makeClient();
    fetchMock.mockResolvedValueOnce(pageResponse([{ id: 'p1' }], 'tok1')).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve(body),
    } as unknown as Response);

    const out = await client.listEventsPaged({ ...WINDOW, maxPages: 10 });

    expect(out.complete).toBe(false);
    expect(out.incompleteReason).toEqual({
      code: 'http_error',
      endpoint: 'events_collection',
      operation: 'read',
      httpStatus: 500,
      errorClass: 'server_error',
    });
    expect(out.events.map((e) => e.id)).toEqual(['p1']);
    const output = JSON.stringify({ out, logs: logSpies.warn.mock.calls });
    for (const marker of [
      CAL_ID,
      encodeURIComponent(CAL_ID),
      externalEmail,
      externalPhone,
      externalToken,
      'pageToken=tok1',
    ]) {
      expect(output).not.toContain(marker);
    }
    expect(logSpies.warn).toHaveBeenCalledWith(
      {
        endpoint: 'events_collection',
        operation: 'read',
        http_status: 500,
        error_class: 'server_error',
      },
      'GCal listEventsPaged: página com erro HTTP',
    );
  });

  it('falhas de token, rede e JSON não devolvem Error.message externa', async () => {
    const externalMarkers = {
      token: 'oauth-token-externo-nao-logar',
      network: 'falha-rede-cliente.sensivel@example.test',
      json: '+5511888888888',
    };
    const attempts: Array<{
      setup: (client: GoogleCalendarClient) => void;
      expectedCode: string;
    }> = [
      {
        setup: (client) => {
          vi.spyOn(
            client as unknown as { getAccessToken: () => Promise<string> },
            'getAccessToken',
          ).mockRejectedValue(new Error(externalMarkers.token));
        },
        expectedCode: 'token_error',
      },
      {
        setup: () => fetchMock.mockRejectedValue(new Error(externalMarkers.network)),
        expectedCode: 'network_error',
      },
      {
        setup: () =>
          fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: () => Promise.reject(new Error(externalMarkers.json)),
          } as unknown as Response),
        expectedCode: 'invalid_response',
      },
    ];

    for (const attempt of attempts) {
      vi.clearAllMocks();
      const client = makeClient();
      attempt.setup(client);

      const out = await client.listEventsPaged(WINDOW);
      const output = JSON.stringify({ out, logs: logSpies.warn.mock.calls });

      expect(out.incompleteReason).toEqual({ code: attempt.expectedCode });
      for (const marker of Object.values(externalMarkers)) {
        expect(output).not.toContain(marker);
      }
    }
  });

  it('resposta OAuth não-2xx não vaza o corpo para a incompletude paginada', async () => {
    const externalMarkers = ['oauth.cliente@example.test', '+5511777777777', 'token-oauth-externo'];
    vi.stubGlobal('crypto', {
      subtle: {
        importKey: vi.fn().mockResolvedValue({}),
        sign: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
      },
    });
    const client = new GoogleCalendarClient({
      credentialsJson: JSON.stringify({
        type: 'service_account',
        client_email: 'sa@fake.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
        token_uri: 'https://oauth.example.test/token?query=externa',
      }),
      calendarId: CAL_ID,
    });
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve(externalMarkers.join(' ')),
    } as unknown as Response);

    const out = await client.listEventsPaged(WINDOW);
    const output = JSON.stringify({ out, logs: logSpies.warn.mock.calls });

    expect(out.incompleteReason).toEqual({ code: 'token_error' });
    for (const marker of externalMarkers) expect(output).not.toContain(marker);
  });

  it('timeout (abort) → complete=false, sentinel de timeout', async () => {
    const client = makeClient();
    // fetch que só rejeita quando o AbortController do paginador dispara.
    fetchMock.mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError')),
          );
        }),
    );

    const out = await client.listEventsPaged({ ...WINDOW, timeoutMs: 10 });

    expect(out.complete).toBe(false);
    expect(out.incompleteReason).toEqual({ code: GCAL_LIST_TIMEOUT_SENTINEL });
    expect(out.events).toHaveLength(0);
  });
});
