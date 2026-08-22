/**
 * Cliente Google Calendar — consulta e cria eventos via Service Account per-clone.
 *
 * Único modo de operação: instanciar GoogleCalendarClient com { credentialsJson, calendarId }.
 * O JSON deve ter type === "service_account". Token obtido via JWT/SA direto no token endpoint.
 */
import { hashEventIdForLog } from '@startap/core/gcal-event-log';
import { logger } from '@startap/core/logger';

const log = logger.child({ module: 'google-calendar' });

/** Mensagem de um erro `unknown` (sem vazar stack/objeto cru em log). */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * SCRUM-148 (LGPD art. 12 §2) — extrai o gcal_event_id do path de um endpoint POR EVENTO
 * (`/calendars/<calendarId>/events/<eventId>`, usado por deleteEvent/patchEvent).
 *
 * Endpoints de COLEÇÃO (`.../events`, `.../events?<qs>`, `/freeBusy`) não têm id e devolvem
 * null — nada a redigir, a mensagem do Google chega inteira pro debug.
 */
function eventIdFromPath(path: string): string | null {
  const m = /\/calendars\/[^/]+\/events\/([^/?#]+)/.exec(path);
  if (!m) return null;
  const raw = m[1];
  // O path é montado com o eventId CRU (sem encode) nos dois call sites; decodificar mesmo
  // assim cobre um id que já venha percent-encoded, pra redigir a forma que o Google ecoa.
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Escapa metacaracteres para montar um RegExp literal a partir de um id arbitrário. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * SCRUM-148 — ponto ÚNICO de saída da redação do event id.
 *
 * O SCRUM-91 hasheou o CAMPO `eventId` nos logs do portal, mas o caminho de ERRO escapava:
 * a mensagem `GCal ${path} -> HTTP ${status}: ${text}` carrega o id cru DUAS vezes — no path
 * e dentro do corpo que o Google ecoa (`"Event not found: <id>"`). Como o portal loga
 * `{ eventId: hashEventIdForLog(id), err: msg }`, o hash ia no campo certo e o id cru ia no
 * `err` ao lado. Aqui o id é substituído pelo MESMO hash do SCRUM-91 em TODAS as ocorrências
 * do texto, então a correlação cross-serviço continua funcionando e nada cru sai da integração.
 */
function redactEventId(text: string, eventId: string | null): string {
  if (!eventId) return text;
  const hashed = hashEventIdForLog(eventId);
  let out = text.split(eventId).join(hashed);
  // O Google pode ecoar a forma percent-encoded do id; redigir as duas grafias.
  const encoded = encodeURIComponent(eventId);
  if (encoded !== eventId) out = out.split(encoded).join(hashed);
  // Defesa em profundidade: se o id ainda aparecer com case diferente, pega também.
  const re = new RegExp(escapeRegExp(eventId), 'gi');
  return out.replace(re, hashed);
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  status?: string;
  /**
   * Metadado privado do evento, invisível na UI do Google (SCRUM — agenda recorrente).
   * Usado hoje só para `serieId` (vínculo de uma série de ocorrências independentes —
   * ver createEvent). Chaves/valores são sempre string (contrato da API do Google).
   */
  extendedProperties?: { private?: Record<string, string> };
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

/** Janela de ocupação (busy) de UM calendário, retornada pelo freebusy.query. */
export interface FreeBusyInterval {
  start: string; // ISO 8601
  end: string; // ISO 8601
}

/**
 * Resultado do freebusy.query batched: mapa calendarId -> intervalos ocupados.
 * Um calendarId que o Google não pôde resolver (sem permissão/erro) NÃO aparece
 * no mapa (ou vem com `errors`); o caller deve tratar ausência como "não sei a
 * ocupação" e ser conservador. ADR 0024 §5.
 */
export type FreeBusyResult = Record<string, FreeBusyInterval[]>;

export type TestConnectionResult = { ok: true } | { ok: false; error: string };

/**
 * Resultado da listagem PAGINADA de eventos (SCRUM-89, reconciliação GCal→atendimentos).
 *
 * `complete=true` SÓ quando a paginação esgotou NATURALMENTE (sem `nextPageToken` pendente)
 * dentro do teto de páginas, sem erro HTTP e sem timeout — ou seja, o conjunto devolvido é o
 * conhecimento COMPLETO da agenda naquela janela. Qualquer erro de página, timeout, ou teto de
 * páginas atingido COM token pendente → `complete=false` (conjunto PARCIAL). O reconciler NUNCA
 * deleta sobre `complete=false` (fail-safe: deletar exige conhecimento total).
 */
export interface ListEventsPagedResult {
  events: CalendarEvent[];
  complete: boolean;
  /** Quantas páginas foram efetivamente buscadas (HTTP round-trips bem-sucedidos). */
  pages: number;
  /**
   * Motivo da incompletude (só quando `complete=false`), pra log/observabilidade do caller:
   *   'truncated_max_pages' | GCAL_LIST_TIMEOUT_SENTINEL | mensagem de erro HTTP/rede.
   * O caller classifica (403 rate-limit vs forbidden etc.) reusando a taxonomia do gcal-healthcheck.
   */
  incompleteReason?: string;
}

/** Sentinela de timeout de PÁGINA do listEventsPaged (não é mensagem do Google) — o caller o trata como incompleto. */
export const GCAL_LIST_TIMEOUT_SENTINEL = '__gcal_list_timeout__';

// ─── Per-clone (Service Account) ─────────────────────────────────────────────

async function gcalFetch<T = unknown>(
  path: string,
  opts: RequestInit,
  tokenFn: () => Promise<string>,
): Promise<T> {
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
    // SCRUM-148: nem o log nem a mensagem lançada podem carregar o event id CRU — os dois
    // canais passam pela MESMA redação (o `err` que o portal loga é esta mensagem).
    const eventId = eventIdFromPath(path);
    const safePath = redactEventId(path, eventId);
    const safeBody = redactEventId(text, eventId);
    log.error({ path: safePath, status: res.status, body: safeBody }, 'GCal error');
    throw new Error(`GCal ${safePath} -> HTTP ${res.status}: ${safeBody}`);
  }
  // DELETE retorna 204 sem corpo
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

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
  const keyData = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

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
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

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
    if (c.type !== 'service_account') {
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

  /**
   * Lista TODOS os eventos de uma janela seguindo `nextPageToken` (SCRUM-89). Diferente do
   * `listEvents` (acima, byte-idêntico e capado em 100 resultados), este pagina até esgotar e
   * devolve um SINAL DE COMPLETUDE — a agenda gigante da Ingrid (~1000 instâncias de recorrência
   * semanal em ±60d) trunca em 1 página no `listEvents`. O reconciler PRECISA saber se viu tudo:
   * só deleta linha "sumida da agenda" quando a listagem é COMPLETA (regra de segurança do ADR 0031).
   *
   * COMPLETUDE (`complete=true`) SÓ se: a paginação chegou a uma página SEM `nextPageToken`
   * (esgotou naturalmente), dentro de `maxPages`, sem erro HTTP e sem timeout. Do contrário,
   * `complete=false` + `incompleteReason` — o conjunto devolvido é PARCIAL (o caller ainda pode
   * fazer upsert do que veio, mas NUNCA deletar).
   *
   * TIMEOUT DURO POR PÁGINA (regra de ouro 7): cada `fetch` corre contra `timeoutMs` via
   * AbortController — nunca aguardar o Google infinito. Timeout = página incompleta = não deleta.
   *
   * NÃO reusa `gcalFetch` (que não expõe AbortController nem o corpo de erro/nextPageToken de
   * forma paginável) — faz o fetch localmente. `listEvents` fica intocado.
   */
  async listEventsPaged(opts: {
    timeMin: string;
    timeMax: string;
    maxPages?: number;
    timeoutMs?: number;
  }): Promise<ListEventsPagedResult> {
    const maxPages = Math.max(1, Math.trunc(opts.maxPages ?? 20));
    const timeoutMs = Math.max(1, Math.trunc(opts.timeoutMs ?? 15_000));
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    let pages = 0;

    while (pages < maxPages) {
      // Token da SA por página (cacheado internamente); falha ao obter token = incompleto.
      let token: string;
      try {
        token = await this.getAccessToken();
      } catch (err: unknown) {
        return { events, complete: false, pages, incompleteReason: errMessage(err) };
      }

      const qs = new URLSearchParams({
        timeMin: opts.timeMin,
        timeMax: opts.timeMax,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '100',
      });
      if (pageToken) qs.set('pageToken', pageToken);
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
        this.calendarId,
      )}/events?${qs}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          signal: controller.signal,
        });
      } catch (err: unknown) {
        // AbortController.abort() → fetch rejeita: timeout se foi o nosso timer; senão erro de rede.
        const reason = controller.signal.aborted ? GCAL_LIST_TIMEOUT_SENTINEL : errMessage(err);
        return { events, complete: false, pages, incompleteReason: reason };
      } finally {
        clearTimeout(timer);
      }

      pages++;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        log.warn({ status: res.status }, 'GCal listEventsPaged: página com erro HTTP');
        return {
          events,
          complete: false,
          pages,
          incompleteReason: `GCal listEventsPaged -> HTTP ${res.status}: ${text}`,
        };
      }

      let json: { items?: CalendarEvent[]; nextPageToken?: string };
      try {
        json = (await res.json()) as { items?: CalendarEvent[]; nextPageToken?: string };
      } catch (err: unknown) {
        return { events, complete: false, pages, incompleteReason: errMessage(err) };
      }
      for (const item of json.items ?? []) events.push(item);

      if (!json.nextPageToken) {
        // Esgotou naturalmente: conhecimento COMPLETO da janela.
        return { events, complete: true, pages };
      }
      pageToken = json.nextPageToken;
    }

    // Saiu do while porque bateu no teto de páginas COM token ainda pendente → PARCIAL.
    return { events, complete: false, pages, incompleteReason: 'truncated_max_pages' };
  }

  /**
   * Consulta a ocupação (busy) de VÁRIOS calendários numa única chamada
   * freebusy.query (ADR 0024 §5 — até 50 calendarId/chamada). Usado pelo
   * estabelecimento para montar a disponibilidade rotulada por colaborador sem
   * N chamadas listEvents por turno.
   *
   * Importante: a credencial (SA) deste client precisa ter acesso a TODOS os
   * calendarIds passados — no modelo estabelecimento todos os calendários dos
   * colaboradores são da MESMA SA do clone (ADR 0024 §2), então qualquer client
   * de colaborador daquele clone serve para emitir o batch.
   *
   * Calendários que o Google não conseguiu resolver vêm com `errors` no item e
   * são OMITIDOS do resultado — o caller trata ausência como "ocupação
   * desconhecida" (conservador), nunca como "livre".
   */
  async freeBusy(opts: {
    calendarIds: string[];
    timeMin: string;
    timeMax: string;
    timeZone?: string;
  }): Promise<FreeBusyResult> {
    if (opts.calendarIds.length === 0) return {};
    if (opts.calendarIds.length > 50) {
      // Limite duro da API (ADR 0024 §5). Estabelecimento até-10 nunca chega aqui;
      // falha alta e explícita em vez de cortar silenciosamente.
      throw new Error(
        `freeBusy: até 50 calendarId por chamada (recebeu ${opts.calendarIds.length})`,
      );
    }
    const json = await gcalFetch<{
      calendars?: Record<string, { busy?: FreeBusyInterval[]; errors?: unknown[] }>;
    }>(
      '/freeBusy',
      {
        method: 'POST',
        body: JSON.stringify({
          timeMin: opts.timeMin,
          timeMax: opts.timeMax,
          timeZone: opts.timeZone ?? 'America/Sao_Paulo',
          items: opts.calendarIds.map((id) => ({ id })),
        }),
      },
      () => this.getAccessToken(),
    );
    const out: FreeBusyResult = {};
    const calendars = json.calendars ?? {};
    for (const [id, entry] of Object.entries(calendars)) {
      // Calendário com erro (sem acesso etc.) NÃO entra no mapa — o caller é
      // conservador e trata ausência como ocupação desconhecida.
      if (entry.errors && entry.errors.length > 0) continue;
      out[id] = entry.busy ?? [];
    }
    return out;
  }

  async createEvent(opts: {
    eventId?: string;
    summary: string;
    description?: string;
    startISO: string;
    endISO: string;
    timeZone?: string;
    /**
     * Metadado privado (SCRUM — agenda recorrente): hoje só usado para carimbar
     * `serieId` (uuid) e ligar as N ocorrências independentes de uma série sem RRULE
     * (ver ADR 0027 — RRULE quebraria o anti-IDOR do DELETE/PATCH, que casa por
     * eventId de INSTÂNCIA). Chaves/valores string (contrato da API do Google).
     */
    extendedPropertiesPrivate?: Record<string, string>;
  }): Promise<CalendarEvent> {
    const tz = opts.timeZone ?? 'America/Sao_Paulo';
    return gcalFetch<CalendarEvent>(
      `/calendars/${encodeURIComponent(this.calendarId)}/events`,
      {
        method: 'POST',
        body: JSON.stringify({
          ...(opts.eventId ? { id: opts.eventId } : {}),
          summary: opts.summary,
          description: opts.description,
          start: { dateTime: opts.startISO, timeZone: tz },
          end: { dateTime: opts.endISO, timeZone: tz },
          ...(opts.extendedPropertiesPrivate
            ? { extendedProperties: { private: opts.extendedPropertiesPrivate } }
            : {}),
        }),
      },
      () => this.getAccessToken(),
    );
  }

  /** Consulta uma ocorrência determinística durante recuperação, sem listar janelas amplas. */
  async getEvent(eventId: string): Promise<CalendarEvent> {
    return gcalFetch<CalendarEvent>(
      `/calendars/${encodeURIComponent(this.calendarId)}/events/${eventId}`,
      { method: 'GET' },
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

  /**
   * Edita campos de um evento EXISTENTE via HTTP PATCH (events.patch) — preserva
   * o MESMO eventId. Usado para remarcar/editar pelo portal sem delete+create.
   *
   * Mandar só os campos que mudaram: a API faz merge parcial (PATCH semantics).
   * start/end vão como { dateTime, timeZone }; se startISO ou endISO vier, o
   * timeZone (default America/Sao_Paulo) acompanha aquele lado. summary só vai se
   * informado. Não passar nenhum campo é no-op no chamador (a rota exige ≥1).
   *
   * IMPORTANTE (ADR 0025, dívida 5): manter o MESMO eventId é o que evita a dupla
   * baixa no ledger de pacotes — o vínculo do ledger é UNIQUE(gcal_event_id,reason),
   * então editar o evento existente NÃO gera novo redeem. NUNCA trocar isto por
   * delete+create.
   */
  async patchEvent(
    eventId: string,
    fields: { summary?: string; startISO?: string; endISO?: string; timeZone?: string },
  ): Promise<CalendarEvent> {
    const tz = fields.timeZone ?? 'America/Sao_Paulo';
    const body: Record<string, unknown> = {};
    if (fields.summary !== undefined) body.summary = fields.summary;
    if (fields.startISO !== undefined) body.start = { dateTime: fields.startISO, timeZone: tz };
    if (fields.endISO !== undefined) body.end = { dateTime: fields.endISO, timeZone: tz };
    return gcalFetch<CalendarEvent>(
      `/calendars/${encodeURIComponent(this.calendarId)}/events/${eventId}`,
      { method: 'PATCH', body: JSON.stringify(body) },
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
