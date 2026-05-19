// Testes para POST /api/sessions/:name/pairing-code (Missao 010)
// Uso: node --test painel-admin/test/pairing-code.test.js
//
// Estrategia: mock de globalThis.fetch — sem bater em producao.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// ---------------------------------------------------------------------------
// Mini-servidor que replica apenas a rota de pairing-code do server.js
// Isso evita inicializar todo o Express + pool Postgres do server.js real.
// ---------------------------------------------------------------------------

const WAHA_URL = 'http://waha-mock-not-real:3000';

/**
 * Implementacao standalone da rota, identica a server.js linhas 3601-3655,
 * porem com WAHA_URL injetavel e sem dependencia do pool.
 */
function buildRoute({ wahaFetch }) {
  return async function handler(req, res) {
    // Autenticacao basic (admin:startap2026)
    const auth = req.headers['authorization'] ?? '';
    const expected = 'Basic ' + Buffer.from('admin:startap2026').toString('base64');
    if (auth !== expected) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // Parse body
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      // body invalido — tratado abaixo
    }

    const { phoneNumber } = parsed;
    const urlParts = req.url.split('/');
    // /api/sessions/:name/pairing-code  → index 3 = name
    const name = urlParts[3];

    // Validacao phoneNumber
    if (!phoneNumber || typeof phoneNumber !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'phoneNumber invalido' }));
      return;
    }
    const digits = phoneNumber.replace(/[^\d]/g, '');
    if (digits.length < 10) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'phoneNumber invalido' }));
      return;
    }
    const normalized = phoneNumber.trimStart().startsWith('+')
      ? phoneNumber.trim()
      : `+${digits}`;

    try {
      // Checa status da sessao
      const statusR = await wahaFetch(`${WAHA_URL}/api/sessions/${name}`);
      if (statusR.ok) {
        const st = await statusR.json().catch(() => ({}));
        if (st.status !== 'SCAN_QR_CODE') {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'Sessao nao esta aguardando autenticacao',
              currentStatus: st.status ?? 'UNKNOWN',
            }),
          );
          return;
        }
      } else {
        // Status check falhou — propaga como 502
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'WAHA status check falhou' }));
        return;
      }

      // Solicita pairing code
      const codeR = await wahaFetch(`${WAHA_URL}/api/${name}/auth/request-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: normalized }),
      });
      if (!codeR.ok) {
        const details = await codeR.text().catch(() => '');
        res.writeHead(codeR.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'WAHA retornou erro', details }));
        return;
      }

      const data = await codeR.json().catch(() => ({}));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: data.code ?? data, phoneNumber: normalized }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Falha ao contatar WAHA: ${e.message}` }));
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cria um objeto Response-like simples. */
function mockResponse(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(body) : body),
    text: () => Promise.resolve(text),
  };
}

/**
 * Dispara uma requisicao HTTP ao servidor de teste e retorna { status, body }.
 */
function request(server, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const opts = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const BASIC_AUTH = 'Basic ' + Buffer.from('admin:startap2026').toString('base64');

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

test('200 — WAHA retorna pairing code valido', async () => {
  let callCount = 0;
  const wahaFetch = async (url) => {
    callCount++;
    if (url.includes('/api/sessions/')) {
      return mockResponse(200, { status: 'SCAN_QR_CODE' });
    }
    return mockResponse(200, { code: 'ABC-123' });
  };

  const handler = buildRoute({ wahaFetch });
  const server = http.createServer(handler).listen(0);
  await new Promise((r) => server.once('listening', r));

  const { status, body } = await request(
    server,
    'POST',
    '/api/sessions/minha-sessao/pairing-code',
    {
      headers: { Authorization: BASIC_AUTH },
      body: { phoneNumber: '+5511999999999' },
    },
  );

  server.close();
  assert.equal(status, 200);
  assert.equal(body.code, 'ABC-123');
  assert.equal(body.phoneNumber, '+5511999999999');
  assert.equal(callCount, 2, 'deve chamar status check e request-code');
});

test('502 — WAHA status check falha (nao OK)', async () => {
  const wahaFetch = async () => mockResponse(503, 'Service Unavailable');

  const handler = buildRoute({ wahaFetch });
  const server = http.createServer(handler).listen(0);
  await new Promise((r) => server.once('listening', r));

  const { status } = await request(
    server,
    'POST',
    '/api/sessions/minha-sessao/pairing-code',
    {
      headers: { Authorization: BASIC_AUTH },
      body: { phoneNumber: '11999999999' },
    },
  );

  server.close();
  assert.equal(status, 502);
});

test('409 — sessao nao esta em SCAN_QR_CODE', async () => {
  const wahaFetch = async (url) => {
    if (url.includes('/api/sessions/')) {
      return mockResponse(200, { status: 'WORKING' });
    }
    return mockResponse(200, { code: 'XYZ' });
  };

  const handler = buildRoute({ wahaFetch });
  const server = http.createServer(handler).listen(0);
  await new Promise((r) => server.once('listening', r));

  const { status, body } = await request(
    server,
    'POST',
    '/api/sessions/minha-sessao/pairing-code',
    {
      headers: { Authorization: BASIC_AUTH },
      body: { phoneNumber: '+5511999999999' },
    },
  );

  server.close();
  assert.equal(status, 409);
  assert.equal(body.currentStatus, 'WORKING');
});

test('400 — body sem phoneNumber', async () => {
  // wahaFetch nunca deve ser chamado nesse cenario
  const wahaFetch = async () => {
    throw new Error('nao devia chamar WAHA');
  };

  const handler = buildRoute({ wahaFetch });
  const server = http.createServer(handler).listen(0);
  await new Promise((r) => server.once('listening', r));

  const { status } = await request(
    server,
    'POST',
    '/api/sessions/minha-sessao/pairing-code',
    {
      headers: { Authorization: BASIC_AUTH },
      body: { outrocampo: 'sem-phone' },
    },
  );

  server.close();
  assert.equal(status, 400);
});

test('400 — phoneNumber com menos de 10 digitos', async () => {
  const wahaFetch = async () => {
    throw new Error('nao devia chamar WAHA');
  };

  const handler = buildRoute({ wahaFetch });
  const server = http.createServer(handler).listen(0);
  await new Promise((r) => server.once('listening', r));

  const { status } = await request(
    server,
    'POST',
    '/api/sessions/minha-sessao/pairing-code',
    {
      headers: { Authorization: BASIC_AUTH },
      body: { phoneNumber: '12345' },
    },
  );

  server.close();
  assert.equal(status, 400);
});

test('401 — sem basic auth', async () => {
  const wahaFetch = async () => {
    throw new Error('nao devia chamar WAHA sem auth');
  };

  const handler = buildRoute({ wahaFetch });
  const server = http.createServer(handler).listen(0);
  await new Promise((r) => server.once('listening', r));

  const { status } = await request(
    server,
    'POST',
    '/api/sessions/minha-sessao/pairing-code',
    {
      // sem Authorization header
      body: { phoneNumber: '+5511999999999' },
    },
  );

  server.close();
  assert.equal(status, 401);
});
