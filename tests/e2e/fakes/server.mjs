import { createHash, createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import process from 'node:process';

const kind = process.env.FAKE_KIND ?? 'unknown';
const port = Number(process.env.PORT ?? 4010);
const journal = [];
const faults = new Map();
const state = { charges: new Map(), events: new Map(), sessions: new Map() };
const MAX_BODY_BYTES = 64 * 1024;
const MAX_JOURNAL_ENTRIES = 200;

function sanitizeString(value) {
  if (/-----BEGIN|bearer\s+|\b(?:sk|abc_(?:live|dev))_[a-z0-9_-]+/iu.test(value))
    return '[redacted]';
  return value
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, '[email-redacted]')
    .replace(/\b\d{10,15}(?=@|\b)/gu, '[number-redacted]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/gu, '[token-redacted]')
    .slice(0, 500);
}

function sanitize(value, depth = 0) {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitize(item, depth + 1));
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? sanitizeString(value) : value;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/authorization|api.?key|secret|signature|private.?key|brcode|phone|telefone/i.test(key)) {
      out[key] = '[redacted]';
    } else out[key] = sanitize(item, depth + 1);
  }
  return out;
}

function identityTag(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function sessionProjection(session) {
  return { nameTag: session.nameTag, status: session.status };
}

function routeLabel(pathname) {
  if (pathname === '/health') return '/health';
  if (pathname === '/__admin/state') return '/__admin/state';
  if (pathname === '/__admin/reset') return '/__admin/reset';
  if (pathname === '/__admin/faults') return '/__admin/faults';
  if (pathname === '/__admin/inbound') return '/__admin/inbound';
  if (kind === 'waha' && pathname === '/api/sessions') return '/api/sessions';
  if (kind === 'waha' && pathname === '/api/sendText') return '/api/sendText';
  if (kind === 'waha' && pathname.startsWith('/api/')) return '/api/:operation';
  if (kind === 'llm' && pathname.endsWith('/chat/completions')) return '/v1/chat/completions';
  if (kind === 'llm' && pathname.endsWith('/audio/transcriptions')) {
    return '/audio/transcriptions';
  }
  if (kind === 'gcal' && pathname === '/token') return '/token';
  if (kind === 'gcal' && pathname.endsWith('/events')) return '/calendar/:calendar/events';
  if (kind === 'gcal' && pathname.endsWith('/freeBusy')) return '/calendar/freeBusy';
  if (kind === 'abacatepay' && pathname === '/v2/transparents/create') {
    return '/v2/transparents/create';
  }
  if (kind === 'abacatepay' && pathname === '/v2/transparents/check') {
    return '/v2/transparents/check';
  }
  return 'unmatched';
}

function json(res, status, body) {
  const encoded = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(encoded),
  });
  res.end(encoded);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('FAKE_BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  if (raw.length === 0) return { raw, parsed: null };
  try {
    return { raw, parsed: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { raw, parsed: raw.toString('utf8') };
  }
}

function journalBody(pathname, parsed) {
  const body = parsed && typeof parsed === 'object' ? parsed : {};
  if (kind === 'llm') {
    return {
      model: typeof body.model === 'string' ? sanitizeString(body.model) : null,
      messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    };
  }
  if (kind === 'waha' && pathname === '/api/sessions') {
    const webhook = Array.isArray(body.config?.webhooks) ? body.config.webhooks[0] : null;
    return {
      nameTag: typeof body.name === 'string' ? identityTag(body.name) : null,
      start: body.start === true,
      events: Array.isArray(webhook?.events) ? webhook.events.slice(0, 10).map(sanitizeString) : [],
      hasHmac: typeof webhook?.hmac?.key === 'string',
    };
  }
  if (kind === 'waha' && pathname === '/api/sendText') {
    return {
      session: typeof body.session === 'string' ? sanitizeString(body.session) : null,
      hasText: typeof body.text === 'string' && body.text.length > 0,
      chatId: body.chatId ? '[chat-redacted]' : null,
    };
  }
  if (kind === 'gcal') {
    return {
      hasStart: !!body.start,
      hasEnd: !!body.end,
      hasSummary: typeof body.summary === 'string' && body.summary.length > 0,
    };
  }
  if (kind === 'abacatepay') {
    const data = body.data && typeof body.data === 'object' ? body.data : {};
    return {
      amount: Number.isFinite(Number(data.amount)) ? Number(data.amount) : null,
      hasExternalId: typeof data.externalId === 'string',
    };
  }
  return {};
}

function record(req, parsed) {
  const pathname = new URL(req.url ?? '/', 'http://fake').pathname;
  journal.push({
    seq: journal.length + 1,
    kind,
    method: req.method,
    path: routeLabel(pathname),
    body: journalBody(pathname, parsed),
  });
  if (journal.length > MAX_JOURNAL_ENTRIES) journal.shift();
}

function consumeFault(pathname) {
  const fault = faults.get(pathname);
  if (!fault) return null;
  if (fault.remaining <= 1) faults.delete(pathname);
  else fault.remaining -= 1;
  return fault;
}

async function admin(req, res, url, parsed) {
  if (url.pathname === '/__admin/state' && req.method === 'GET') {
    return json(res, 200, {
      kind,
      journal,
      state: {
        charges: sanitize([...state.charges.values()]),
        events: sanitize([...state.events.values()]),
        sessions: [...state.sessions.values()].map(sessionProjection),
      },
      faults: [...faults.entries()].map(([pathname, fault]) => ({
        route: routeLabel(pathname),
        status: fault.status,
        remaining: fault.remaining,
        delayMs: fault.delayMs,
        body: sanitize(fault.body),
      })),
    });
  }
  if (url.pathname === '/__admin/reset' && req.method === 'POST') {
    journal.length = 0;
    faults.clear();
    state.charges.clear();
    state.events.clear();
    state.sessions.clear();
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/__admin/faults' && req.method === 'POST') {
    const body = parsed && typeof parsed === 'object' ? parsed : {};
    const targetPath = typeof body.path === 'string' ? body.path : '/';
    if (!targetPath.startsWith('/') || targetPath.length > 200) {
      return json(res, 400, { error: 'invalid_fault_path' });
    }
    faults.set(String(body.path ?? '/'), {
      status: body.passthrough === true ? null : Number(body.status ?? 503),
      remaining: Math.max(1, Math.min(20, Number(body.times ?? 1))),
      delayMs: Math.max(0, Math.min(5_000, Number(body.delayMs ?? 0))),
      body: sanitize(body.body ?? { error: 'injected_fault' }),
    });
    return json(res, 200, { ok: true });
  }
  return false;
}

async function waha(req, res, url, parsed) {
  if (url.pathname === '/__admin/inbound' && req.method === 'POST') {
    const input = parsed && typeof parsed === 'object' ? parsed : {};
    const envelope = input.envelope ?? input;
    const signedRaw = JSON.stringify(envelope);
    const transmittedEnvelope = input.tamperAfterSign
      ? {
          ...envelope,
          payload: {
            ...(envelope && typeof envelope === 'object' && envelope.payload
              ? envelope.payload
              : {}),
            body: 'payload adulterado depois da assinatura',
          },
        }
      : envelope;
    const raw = JSON.stringify(transmittedEnvelope);
    const key = process.env.WAHA_WEBHOOK_HMAC_KEY ?? '';
    const signature = createHmac('sha512', input.invalidHmac ? `${key}-invalid` : key)
      .update(signedRaw)
      .digest('hex');
    const headers = { 'content-type': 'application/json' };
    if (input.omitHmac !== true) headers['x-webhook-hmac'] = signature;
    const response = await fetch(process.env.TARGET_API_URL ?? '', {
      method: 'POST',
      headers,
      body: raw,
    });
    return json(res, 200, { upstreamStatus: response.status, upstreamBody: await response.json() });
  }
  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    return json(res, 200, [...state.sessions.values()].map(sessionProjection));
  }
  if (url.pathname === '/api/sessions' && req.method === 'POST') {
    const input = parsed && typeof parsed === 'object' ? parsed : {};
    const rawName = typeof input.name === 'string' ? input.name : `e2e_${randomUUID()}`;
    const session = { nameTag: identityTag(rawName), status: 'STARTING' };
    state.sessions.set(rawName, session);
    return json(res, 201, sessionProjection(session));
  }
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/sendText') {
      return json(res, 200, { id: `e2e_${randomUUID()}`, timestamp: Date.now() });
    }
    return json(res, 200, { ok: true });
  }
  return false;
}

async function llm(_req, res, url) {
  if (url.pathname.endsWith('/chat/completions')) {
    return json(res, 200, {
      id: `chatcmpl_${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'gpt-e2e',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'Resposta deterministica E2E.' },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  }
  if (url.pathname.endsWith('/audio/transcriptions')) return json(res, 200, { text: 'audio e2e' });
  return false;
}

async function gcal(req, res, url, parsed) {
  if (url.pathname === '/token')
    return json(res, 200, { access_token: 'e2e_token', expires_in: 3600 });
  if (url.pathname.endsWith('/events') && req.method === 'GET') {
    return json(res, 200, { items: [...state.events.values()] });
  }
  if (url.pathname.endsWith('/events') && req.method === 'POST') {
    const responseEvent = { id: `evt_${randomUUID()}`, ...(parsed ?? {}) };
    state.events.set(responseEvent.id, {
      id: responseEvent.id,
      hasSummary: typeof responseEvent.summary === 'string',
      hasStart: !!responseEvent.start,
      hasEnd: !!responseEvent.end,
    });
    return json(res, 200, responseEvent);
  }
  if (url.pathname.endsWith('/freeBusy')) return json(res, 200, { calendars: {} });
  return false;
}

async function abacatepay(req, res, url, parsed) {
  if (url.pathname === '/v2/transparents/create') {
    const id = `pix_${randomUUID()}`;
    const input = parsed && typeof parsed === 'object' ? parsed : {};
    const data = input.data && typeof input.data === 'object' ? input.data : {};
    const responseCharge = {
      id,
      status: 'PENDING',
      brCode: 'E2E_REDACTED',
      brCodeBase64: 'E2E_REDACTED',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      amount: Number(data.amount ?? 0),
      externalId: typeof data.externalId === 'string' ? data.externalId : 'e2e-external',
    };
    state.charges.set(id, {
      id,
      status: 'PENDING',
      amount: Number(data.amount ?? 0),
      hasExternalId: typeof data.externalId === 'string',
    });
    return json(res, 200, { data: responseCharge });
  }
  if (url.pathname === '/v2/transparents/check') {
    return json(res, 200, {
      data: state.charges.get(url.searchParams.get('id')) ?? {
        id: url.searchParams.get('id'),
        status: 'PENDING',
      },
    });
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (url.pathname === '/health') return json(res, 200, { status: 'ok', kind });
    const { parsed } = await readBody(req);
    const adminResult = await admin(req, res, url, parsed);
    if (adminResult !== false) return;
    record(req, parsed);
    const fault = consumeFault(url.pathname);
    if (fault) {
      if (fault.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
      if (fault.status !== null) return json(res, fault.status, fault.body);
    }
    const handled =
      kind === 'waha'
        ? await waha(req, res, url, parsed)
        : kind === 'llm'
          ? await llm(req, res, url, parsed)
          : kind === 'gcal'
            ? await gcal(req, res, url, parsed)
            : kind === 'abacatepay'
              ? await abacatepay(req, res, url, parsed)
              : false;
    if (handled === false) {
      json(res, 404, { error: 'fake_route_not_found', kind, route: routeLabel(url.pathname) });
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'FAKE_BODY_TOO_LARGE') {
      return json(res, 413, { error: 'body_too_large' });
    }
    return json(res, 500, { error: 'fake_internal_error' });
  }
});

server.listen(port, '0.0.0.0', () => {
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  process.stdout.write(`${kind} fake ready on ${boundPort}\n`);
});
