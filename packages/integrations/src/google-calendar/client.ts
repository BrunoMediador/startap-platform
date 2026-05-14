/**
 * Cliente Google Calendar — consulta e cria eventos.
 *
 * Substitui os workflows Cirilo_Consultar_Agendamento e Cirilo_Inserir_Agendamento.
 *
 * Usa OAuth2 refresh token (mais simples que service account para n8n migration).
 */
import { logger } from '@startap/core/logger';

const log = logger.child({ module: 'google-calendar' });

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '';
const REFRESH_TOKEN = process.env.GOOGLE_OAUTH_REFRESH_TOKEN ?? '';
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID ?? 'primary';

// Cache de access token em memória
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
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

async function gcalFetch<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
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
  return (await res.json()) as T;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  status?: string;
}

/** Lista eventos entre duas datas. */
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

/** Cria um evento. */
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

/** Deleta um evento. */
export async function deleteEvent(eventId: string, calendarId?: string): Promise<void> {
  const cal = calendarId ?? CALENDAR_ID;
  await gcalFetch(`/calendars/${encodeURIComponent(cal)}/events/${eventId}`, {
    method: 'DELETE',
  });
}
