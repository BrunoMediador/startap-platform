// Testes para GET /api/sessions/:name/recent-contacts?days=N
// Uso: node --test painel-admin/test/recent-contacts.test.js
//
// Estrategia: implementacao standalone da logica da rota, com mock de fetch.
// Sem bater em producao, sem inicializar pool Postgres.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// ---------------------------------------------------------------------------
// Implementacao standalone da rota (espelho de server.js)
// Injetamos wahaFetch e wahaUrl pra permitir mock total sem tocar em fetch global.
// ---------------------------------------------------------------------------

const ENRICH_LIMIT = 30;
const RESPONSE_LIMIT = 100;

function buildHandler({ wahaUrl = 'http://waha-mock:3000', wahaApiKey = '', wahaFetch = fetch } = {}) {
  return async function handler(req, res) {
    // Parse URL
    const urlObj = new URL(req.url, `http://localhost`);
    const parts = urlObj.pathname.split('/'); // ['', 'api', 'sessions', name, 'recent-contacts']
    const name = parts[3] ?? '';

    if (!name || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'name invalido' }));
      return;
    }

    const rawDays = urlObj.searchParams.has('days') ? Number(urlObj.searchParams.get('days')) : 7;
    if (!Number.isFinite(rawDays) || rawDays < 1 || rawDays > 30 || !Number.isInteger(rawDays)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'days deve ser inteiro entre 1 e 30' }));
      return;
    }
    const days = rawDays;

    const TIMEOUT_MS = 8_000;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      let chatsRaw;
      try {
        const r = await wahaFetch(`${wahaUrl}/api/${name}/chats`, {
          headers: wahaApiKey ? { 'X-Api-Key': wahaApiKey } : {},
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!r.ok) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'nao foi possivel buscar contatos agora' }));
          return;
        }
        chatsRaw = await r.json().catch(() => []);
      } catch (fetchErr) {
        clearTimeout(timer);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'nao foi possivel buscar contatos agora' }));
        return;
      }

      if (!Array.isArray(chatsRaw)) chatsRaw = [];

      const nowSec = Math.floor(Date.now() / 1000);
      const cutoffSec = nowSec - days * 86400;

      const filtered = chatsRaw.filter((chat) => {
        const id = chat?.id ?? '';
        if (id.endsWith('@g.us')) return false;
        if (!id.endsWith('@s.whatsapp.net') && !id.endsWith('@c.us')) return false;
        let ts = chat?.conversationTimestamp ?? chat?.timestamp ?? 0;
        if (ts > 1e12) ts = Math.floor(ts / 1000);
        return ts >= cutoffSec;
      });

      const mapped = filtered.map((chat) => {
        const id = chat?.id ?? '';
        const phone = id.replace(/@s\.whatsapp\.net$|@c\.us$/, '');
        let ts = chat?.conversationTimestamp ?? chat?.timestamp ?? 0;
        if (ts > 1e12) ts = Math.floor(ts / 1000);
        return { phone, chatId: id, ts, name: chat?.name ?? null };
      });

      mapped.sort((a, b) => b.ts - a.ts);
      const limited = mapped.slice(0, RESPONSE_LIMIT);

      const enrichBatch = limited.slice(0, ENRICH_LIMIT);
      const enrichResults = await Promise.allSettled(
        enrichBatch.map(async (item) => {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 3_000);
          try {
            const r = await wahaFetch(
              `${wahaUrl}/api/${name}/chats/${encodeURIComponent(item.chatId)}`,
              {
                headers: wahaApiKey ? { 'X-Api-Key': wahaApiKey } : {},
                signal: ctrl.signal,
              },
            );
            clearTimeout(t);
            if (!r.ok) return null;
            const data = await r.json().catch(() => null);
            return data?.name ?? data?.pushName ?? null;
          } catch {
            clearTimeout(t);
            return null;
          }
        }),
      );

      const contacts = limited.map((item, idx) => {
        let resolvedName = item.name;
        if (idx < ENRICH_LIMIT) {
          const settled = enrichResults[idx];
          if (settled?.status === 'fulfilled' && settled.value) {
            resolvedName = settled.value;
          }
        }
        return {
          phone: item.phone,
          name: resolvedName ?? null,
          last_interaction: new Date(item.ts * 1000).toISOString(),
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session: name, days, count: contacts.length, contacts }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'nao foi possivel buscar contatos agora' }));
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResponse(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(text) : body),
    text: () => Promise.resolve(text),
  };
}

function request(server, path) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const opts = { hostname: '127.0.0.1', port: addr.port, path, method: 'GET' };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function nowSec() { return Math.floor(Date.now() / 1000); }

async function withServer(handler, fn) {
  const server = http.createServer(handler).listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(server); } finally { server.close(); }
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

test('200 — retorna contatos individuais com pushName enriquecido', async () => {
  const ts = nowSec() - 3600; // 1h atras — dentro dos 7 dias

  const wahaFetch = async (url) => {
    if (url.includes('/chats/')) {
      // enrich endpoint
      return mockResponse(200, { name: 'Fulano Silva' });
    }
    // lista de chats
    return mockResponse(200, [
      { id: '5511999998888@s.whatsapp.net', conversationTimestamp: ts },
      { id: '5511111112222@g.us', conversationTimestamp: ts }, // grupo — deve ser excluido
    ]);
  };

  const handler = buildHandler({ wahaFetch });
  const { status, body } = await withServer(handler, (s) =>
    request(s, '/api/sessions/STARTAP_AI_PROD/recent-contacts?days=7'),
  );

  assert.equal(status, 200);
  assert.equal(body.session, 'STARTAP_AI_PROD');
  assert.equal(body.days, 7);
  assert.equal(body.count, 1);
  assert.equal(body.contacts[0].phone, '5511999998888');
  assert.equal(body.contacts[0].name, 'Fulano Silva');
  assert.ok(body.contacts[0].last_interaction.endsWith('Z'));
});

test('200 — name null quando enrich falha (404)', async () => {
  const ts = nowSec() - 3600;

  const wahaFetch = async (url) => {
    if (url.includes('/chats/')) return mockResponse(404, { message: 'not found' });
    return mockResponse(200, [{ id: '5511999998888@s.whatsapp.net', conversationTimestamp: ts }]);
  };

  const handler = buildHandler({ wahaFetch });
  const { status, body } = await withServer(handler, (s) =>
    request(s, '/api/sessions/STARTAP_AI_PROD/recent-contacts?days=7'),
  );

  assert.equal(status, 200);
  assert.equal(body.contacts[0].name, null);
});

test('200 — exclui grupos @g.us', async () => {
  const ts = nowSec() - 3600;

  const wahaFetch = async (url) => {
    if (url.includes('/chats/')) return mockResponse(200, { name: 'Alguem' });
    return mockResponse(200, [
      { id: '120363xxx@g.us', conversationTimestamp: ts },
      { id: '5511999990000@s.whatsapp.net', conversationTimestamp: ts },
    ]);
  };

  const handler = buildHandler({ wahaFetch });
  const { status, body } = await withServer(handler, (s) =>
    request(s, '/api/sessions/MY_SESSION/recent-contacts'),
  );

  assert.equal(status, 200);
  assert.equal(body.count, 1);
  assert.equal(body.contacts[0].phone, '5511999990000');
});

test('200 — filtra chats fora da janela de tempo', async () => {
  const nowS = nowSec();
  const inside = nowS - 86400 * 3;    // 3 dias atras — dentro de 7d
  const outside = nowS - 86400 * 10;  // 10 dias atras — fora de 7d

  const wahaFetch = async (url) => {
    if (url.includes('/chats/')) return mockResponse(200, { name: 'X' });
    return mockResponse(200, [
      { id: '5511111111111@s.whatsapp.net', conversationTimestamp: inside },
      { id: '5511222222222@s.whatsapp.net', conversationTimestamp: outside },
    ]);
  };

  const handler = buildHandler({ wahaFetch });
  const { status, body } = await withServer(handler, (s) =>
    request(s, '/api/sessions/SES/recent-contacts?days=7'),
  );

  assert.equal(status, 200);
  assert.equal(body.count, 1);
  assert.equal(body.contacts[0].phone, '5511111111111');
});

test('200 — timestamp em milissegundos e normalizado corretamente', async () => {
  const tsMs = (nowSec() - 7200) * 1000; // 2h atras em ms

  const wahaFetch = async (url) => {
    if (url.includes('/chats/')) return mockResponse(200, { name: 'Teste' });
    return mockResponse(200, [{ id: '5511000000000@c.us', conversationTimestamp: tsMs }]);
  };

  const handler = buildHandler({ wahaFetch });
  const { status, body } = await withServer(handler, (s) =>
    request(s, '/api/sessions/SES/recent-contacts?days=7'),
  );

  assert.equal(status, 200);
  assert.equal(body.count, 1);
  assert.equal(body.contacts[0].phone, '5511000000000');
});

test('200 — ordenado por last_interaction DESC', async () => {
  const nowS = nowSec();

  const wahaFetch = async (url) => {
    if (url.includes('/chats/')) return mockResponse(404, {});
    return mockResponse(200, [
      { id: '5511000000001@s.whatsapp.net', conversationTimestamp: nowS - 7200 },  // mais antigo
      { id: '5511000000002@s.whatsapp.net', conversationTimestamp: nowS - 1800 },  // mais recente
      { id: '5511000000003@s.whatsapp.net', conversationTimestamp: nowS - 3600 },
    ]);
  };

  const handler = buildHandler({ wahaFetch });
  const { status, body } = await withServer(handler, (s) =>
    request(s, '/api/sessions/SES/recent-contacts?days=7'),
  );

  assert.equal(status, 200);
  assert.equal(body.contacts[0].phone, '5511000000002'); // mais recente primeiro
  assert.equal(body.contacts[1].phone, '5511000000003');
  assert.equal(body.contacts[2].phone, '5511000000001');
});

test('400 — days=0 invalido', async () => {
  const handler = buildHandler({ wahaFetch: async () => { throw new Error('nao devia chamar'); } });
  const { status } = await withServer(handler, (s) =>
    request(s, '/api/sessions/SES/recent-contacts?days=0'),
  );
  assert.equal(status, 400);
});

test('400 — days=31 excede maximo', async () => {
  const handler = buildHandler({ wahaFetch: async () => { throw new Error('nao devia chamar'); } });
  const { status } = await withServer(handler, (s) =>
    request(s, '/api/sessions/SES/recent-contacts?days=31'),
  );
  assert.equal(status, 400);
});

test('400 — days fracionado invalido', async () => {
  const handler = buildHandler({ wahaFetch: async () => { throw new Error('nao devia chamar'); } });
  const { status } = await withServer(handler, (s) =>
    request(s, '/api/sessions/SES/recent-contacts?days=3.5'),
  );
  assert.equal(status, 400);
});

test('502 — WAHA retorna status nao-ok', async () => {
  const wahaFetch = async (url) => {
    if (url.includes('/chats/')) return mockResponse(200, {});
    return mockResponse(503, { message: 'Service Unavailable' });
  };

  const handler = buildHandler({ wahaFetch });
  const { status, body } = await withServer(handler, (s) =>
    request(s, '/api/sessions/SES/recent-contacts'),
  );

  assert.equal(status, 502);
  assert.equal(body.error, 'nao foi possivel buscar contatos agora' );
});

test('502 — WAHA timeout dispara AbortError', async () => {
  const wahaFetch = async (_url, opts) => {
    // Simula abort imediato
    return new Promise((_resolve, reject) => {
      if (opts?.signal) {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('The operation was aborted');
          e.name = 'AbortError';
          reject(e);
        });
        // Forca abort
        opts.signal.dispatchEvent(new Event('abort'));
      }
    });
  };

  const handler = buildHandler({ wahaFetch });
  const { status } = await withServer(handler, (s) =>
    request(s, '/api/sessions/SES/recent-contacts'),
  );

  assert.equal(status, 502);
});

test('200 — lista vazia quando nenhum chat na janela', async () => {
  const tsFora = nowSec() - 86400 * 20; // 20 dias atras

  const wahaFetch = async (url) => {
    if (url.includes('/chats/')) return mockResponse(200, {});
    return mockResponse(200, [
      { id: '5511999990001@s.whatsapp.net', conversationTimestamp: tsFora },
    ]);
  };

  const handler = buildHandler({ wahaFetch });
  const { status, body } = await withServer(handler, (s) =>
    request(s, '/api/sessions/SES/recent-contacts?days=7'),
  );

  assert.equal(status, 200);
  assert.equal(body.count, 0);
  assert.deepEqual(body.contacts, []);
});
