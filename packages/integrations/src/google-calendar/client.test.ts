/**
 * Testes do GoogleCalendarClient.patchEvent (events.patch).
 *
 * Foco: HTTP PATCH no MESMO eventId, body só com os campos mudados, start/end
 * como { dateTime, timeZone }. getAccessToken é stubado (não chama o token
 * endpoint real); o fetch global é mockado pra inspecionar method/url/body.
 *
 * patchEvent PRESERVA o eventId — é o caminho que evita a dupla baixa do ledger
 * (ADR 0025 dívida 5). Nunca delete+create.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { GoogleCalendarClient } from './client.js';

const SA_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'sa@fake.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
});

const CAL_ID = 'cal-teste@group.calendar.google.com';

function makeClient(): GoogleCalendarClient {
  const c = new GoogleCalendarClient({ credentialsJson: SA_JSON, calendarId: CAL_ID });
  // Stub do token: evita assinar JWT / bater no token endpoint.
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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function okResponse(json: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(json),
    text: () => Promise.resolve(''),
  } as unknown as Response;
}

describe('GoogleCalendarClient.patchEvent — happy path', () => {
  it('PATCH no mesmo eventId com start/end como {dateTime,timeZone} e summary', async () => {
    const client = makeClient();
    const returned = {
      id: 'evt_123',
      summary: 'Novo Nome - Corte | WhatsApp: 5511999990000',
      start: { dateTime: '2026-07-01T14:00:00-03:00' },
      end: { dateTime: '2026-07-01T14:30:00-03:00' },
    };
    fetchMock.mockResolvedValue(okResponse(returned));

    const out = await client.patchEvent('evt_123', {
      summary: 'Novo Nome - Corte | WhatsApp: 5511999990000',
      startISO: '2026-07-01T17:00:00.000Z',
      endISO: '2026-07-01T17:30:00.000Z',
      timeZone: 'America/Sao_Paulo',
    });

    expect(out.id).toBe('evt_123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    // MESMO eventId na URL (preserva o vínculo do ledger).
    expect(url).toContain('/events/evt_123');
    expect(url).toContain(encodeURIComponent(CAL_ID));
    expect(opts.method).toBe('PATCH');
    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({
      summary: 'Novo Nome - Corte | WhatsApp: 5511999990000',
      start: { dateTime: '2026-07-01T17:00:00.000Z', timeZone: 'America/Sao_Paulo' },
      end: { dateTime: '2026-07-01T17:30:00.000Z', timeZone: 'America/Sao_Paulo' },
    });
  });

  it('manda SÓ os campos informados (PATCH parcial: só summary, sem start/end)', async () => {
    const client = makeClient();
    fetchMock.mockResolvedValue(
      okResponse({ id: 'evt_abc', summary: 'X - Barba', start: {}, end: {} }),
    );

    await client.patchEvent('evt_abc', { summary: 'X - Barba' });

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({ summary: 'X - Barba' });
    expect(body).not.toHaveProperty('start');
    expect(body).not.toHaveProperty('end');
  });

  it('default timeZone America/Sao_Paulo quando só startISO/endISO mudam', async () => {
    const client = makeClient();
    fetchMock.mockResolvedValue(okResponse({ id: 'e', summary: '', start: {}, end: {} }));

    await client.patchEvent('e', {
      startISO: '2026-07-01T17:00:00.000Z',
      endISO: '2026-07-01T17:30:00.000Z',
    });

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.start.timeZone).toBe('America/Sao_Paulo');
    expect(body.end.timeZone).toBe('America/Sao_Paulo');
    expect(body).not.toHaveProperty('summary');
  });
});

describe('GoogleCalendarClient.patchEvent — erro', () => {
  it('propaga erro HTTP do GCal (ex.: 404 evento inexistente)', async () => {
    const client = makeClient();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
    } as unknown as Response);

    await expect(client.patchEvent('sumiu', { summary: 'x' })).rejects.toThrow(/HTTP 404/);
  });
});
