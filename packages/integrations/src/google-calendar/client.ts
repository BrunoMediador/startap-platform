/**
 * Cliente Google Calendar — consulta e cria eventos.
 *
 * Dois modos de operação:
 *
 * 1. Legacy (env global): usado pelos bots não-clone (startap, matrizes).
 *    Ativado via funções exportadas listEvents/createEvent/deleteEvent sem instância.
 *    Continua funcionando enquanto as env vars GOOGLE_OAUTH_* estiverem presentes.
 *
 * 2. Per-clone (Service Account JSON): instanciar GoogleCalendarClient com
 *    { credentialsJson, calendarId }. Detecta automaticamente se o JSON tem
 *    type === "service_account" e usa JWT/SA via fetch direto no token endpoint.
 */
import { logger } from '@startap/core/logger';

const log = logger.child({ module: 'google-calendar' });

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  status?: string;
}

interface ServiceAccountCredentials {
  type: 'service_account';
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface PerCloneOptions {
  credentialsJson: string; // JSON string da Service Account
  calendarId: string;
}

export type TestConnectionResult =
  | { ok: true }
  | { ok: false; error: string };

// ─── Legacy (OAuth env global) ────────────────────────────────────────────────

const CLIENT_ID      = process.env.GOOGLE_OAUTH_CLIENT_ID      ?? '';
const CLIENT_SECRET  = process.env.GOOGLE_OAUTH_CLIENT_SECRET  ?? '';
const REFRESH_TOKEN  = process.env.GOOGLE_OAUTH_REFRESH_TOKEN  ?? '';
const CALENDAR_ID    = process.env.GOOGLE_CALENDAR_ID          ?? 'primary';

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getLegacyAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google OAuth refresh failed: HTTP ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return json.access_token;
}

async function gcalFetch<T = unknown>(path: string, opts: RequestInit = {}, tokenFn: () => Promise<string> = getLegacyAccessToken): Promise<T> {
  const token = await tokenFn();
  const url = `https://www.googleapis.com/calendar/v3${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log.error({ path, status: res.status, body: text }, 'GCal error');
    throw new Error(`GCal ${path} -> HTTP ${res.status}: ${text}`);
  }
  // DELETE retorna 204 sem corpo
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

/** Lista eventos entre duas datas (modo legacy). */
export async function listEvents(opts: {
  timeMin: string; // ISO
  timeMax: string; // ISO
  calendarId?: string;
}): Promise<CalendarEvent[]> {
  const cal = opts.calendarId ?? CALENDAR_ID;
  const qs = new URLSearchParams({
    timeMin: opts.timeMin,
    timeMax: opts.timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '100',
  });
  const json = await gcalFetch<{ items: CalendarEvent[] }>(
    `/calendars/${encodeURIComponent(cal)}/events?${qs}`,
  );
  return json.items ?? [];
}

/** Cria um evento (modo legacy). */
export async function createEvent(opts: {
  summary: string;
  description?: string;
  startISO: string;
  endISO: string;
  timeZone?: string;
  calendarId?: string;
}): Promise<CalendarEvent> {
  const cal = opts.calendarId ?? CALENDAR_ID;
  const tz = opts.timeZone ?? 'America/Sao_Paulo';
  return await gcalFetch<CalendarEvent>(`/calendars/${encodeURIComponent(cal)}/events`, {
    method: 'POST',
    body: JSON.stringify({
      summary: opts.summary,
      description: opts.description,
      start: { dateTime: opts.startISO, timeZone: tz },
      end: { dateTime: opts.endISO, timeZone: tz },
    }),
  });
}

/** Deleta um evento (modo legacy). */
export async function deleteEvent(eventId: string, calendarId?: string): Promise<void> {
  const cal = calendarId ?? CALENDAR_ID;
  await gcalFetch(`/calendars/${encodeURIComponent(cal)}/events/${eventId}`, {
    method: 'DELETE',
  });
}

// ─── Per-clone (Service Account) ─────────────────────────────────────────────

/**
 * Gera um JWT assinado para Service Account usando apenas Web Crypto API
 * (sem dependência de googleapis SDK, mantém bundle leve).
 */
async function signJwt(payload: Record<string, unknown>, privateKeyPem: string): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT' };
  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const signingInput = `${encode(header)}.${encode(payload)}`;

  // Importa chave privada PEM
  const pemBody = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const keyData = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );

  const sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  return `${signingInput}.${sig}`;
}

export class GoogleCalendarClient {
  private readonly creds: ServiceAccountCredentials;
  private readonly calendarId: string;
  private saTokenCache: { token: string; expiresAt: number } | null = null;

  constructor(opts: PerCloneOptions) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(opts.credentialsJson);
    } catch {
      throw new Error('GoogleCalendarClient: credentialsJson inválido (JSON malformado)');
    }
    const c = parsed as Record<string, unknown>;
    if (c['type'] !== 'service_account') {
      throw new Error('GoogleCalendarClient: credentialsJson deve ser do tipo service_account');
    }
    this.creds = parsed as ServiceAccountCredentials;
    this.calendarId = opts.calendarId;
  }

  private async getAccessToken(): Promise<string> {
    if (this.saTokenCache && this.saTokenCache.expiresAt > Date.now() + 60_000) {
      return this.saTokenCache.token;
    }

    const now = Math.floor(Date.now() / 1000);
    const tokenUri = this.creds.token_uri ?? 'https://oauth2.googleapis.com/token';

    const jwt = await signJwt(
      {
        iss: this.creds.client_email,
        scope: 'https://www.googleapis.com/auth/calendar',
        aud: tokenUri,
        iat: now,
        exp: now + 3600,
      },
      this.creds.private_key,
    );

    const res = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SA token request failed: HTTP ${res.status}: ${text}`);
    }

    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.saTokenCache = {
      token: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    return this.saTokenCache.token;
  }

  async listEvents(opts: { timeMin: string; timeMax: string }): Promise<CalendarEvent[]> {
    const qs = new URLSearchParams({
      timeMin: opts.timeMin,
      timeMax: opts.timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '100',
    });
    const json = await gcalFetch<{ items: CalendarEvent[] }>(
      `/calendars/${encodeURIComponent(this.calendarId)}/events?${qs}`,
      {},
      () => this.getAccessToken(),
    );
    return json.items ?? [];
  }

  async createEvent(opts: {
    summary: string;
    description?: string;
    startISO: string;
    endISO: string;
    timeZone?: string;
  }): Promise<CalendarEvent> {
    const tz = opts.timeZone ?? 'America/Sao_Paulo';
    return gcalFetch<CalendarEvent>(
      `/calendars/${encodeURIComponent(this.calendarId)}/events`,
      {
        method: 'POST',
        body: JSON.stringify({
          summary: opts.summary,
          description: opts.description,
          start: { dateTime: opts.startISO, timeZone: tz },
          end: { dateTime: opts.endISO, timeZone: tz },
        }),
      },
      () => this.getAccessToken(),
    );
  }

  async deleteEvent(eventId: string): Promise<void> {
    await gcalFetch(
      `/calendars/${encodeURIComponent(this.calendarId)}/events/${eventId}`,
      { method: 'DELETE' },
      () => this.getAccessToken(),
    );
  }

  /** Testa a conexão tentando listar 1 evento na agenda. */
  async testConnection(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const now = new Date();
      const tomorrow = new Date(now.getTime() + 86_400_000);
      await this.listEvents({
        timeMin: now.toISOString(),
        timeMax: tomorrow.toISOString(),
      });
      return { ok: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }
}
