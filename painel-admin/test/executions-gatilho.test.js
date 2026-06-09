// Testes para GET /api/executions — campo `gatilho` (1o evento da execucao)
// Uso: node --test painel-admin/test/executions-gatilho.test.js
//
// Estrategia: implementacao standalone da rota (espelho de server.js), com mock
// de pool.query. Sem bater em Postgres de producao. Foca no contrato da resposta:
// o `gatilho` (event_type do PRIMEIRO evento) deve fluir do SELECT agregado pro JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// ---------------------------------------------------------------------------
// maskPhone — copia minima do helper de server.js (so pra o espelho rodar)
// ---------------------------------------------------------------------------
function maskPhone(p) {
  if (!p) return '';
  const s = String(p);
  if (s.length <= 4) return s;
  return s.slice(0, 4) + '****' + s.slice(-2);
}

// ---------------------------------------------------------------------------
// Implementacao standalone da rota GET /api/executions (espelho de server.js).
// O SELECT real roda no Postgres; aqui injetamos `pool` mockado retornando as
// linhas agregadas que o SQL produziria (incluindo a coluna `gatilho`).
// O teste valida a etapa de map/filtro em JS — que e onde `gatilho` e exposto.
// ---------------------------------------------------------------------------
function buildHandler({ pool }) {
  return async function handler(req, res) {
    const urlObj = new URL(req.url, 'http://localhost');
    const statusFilterRaw = urlObj.searchParams.get('status');
    const statusFilter = ['error', 'success', 'running', 'ignored'].includes(statusFilterRaw)
      ? statusFilterRaw
      : null;

    const r = await pool.query('SELECT ... AS gatilho ...', []);

    const rows = r.rows
      .filter((row) => !statusFilter || row.status_final === statusFilter)
      .map((row) => ({
        id: row.id,
        slot: row.slot,
        telefone_mascarado: maskPhone(row.telefone_masked),
        started_at: row.started_at,
        finished_at: row.finished_at,
        duration_ms: row.duration_ms ?? 0,
        status_final: row.status_final ?? 'running',
        events_count: row.events_count,
        gatilho: row.gatilho ?? null,
      }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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

async function withServer(handler, fn) {
  const server = http.createServer(handler).listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(server); } finally { server.close(); }
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

test('200 — caminho feliz: gatilho preenchido com event_type do 1o evento', async () => {
  const pool = {
    query: async () => ({
      rows: [
        {
          id: 'exec-aaa',
          slot: 'startap',
          telefone_masked: '5511999998888',
          started_at: '2026-06-09T10:00:00.000Z',
          finished_at: '2026-06-09T10:00:02.000Z',
          duration_ms: 2000,
          events_count: 5,
          status_final: 'success',
          gatilho: 'message',
        },
      ],
    }),
  };

  const { status, body } = await withServer(buildHandler({ pool }), (s) =>
    request(s, '/api/executions'),
  );

  assert.equal(status, 200);
  assert.equal(body.length, 1);
  assert.equal(body[0].gatilho, 'message');
  // demais campos nao mudam
  assert.equal(body[0].id, 'exec-aaa');
  assert.equal(body[0].status_final, 'success');
  assert.equal(body[0].events_count, 5);
});

test('200 — edge: execucao sem 1o evento resolvivel → gatilho null (gracioso)', async () => {
  const pool = {
    query: async () => ({
      rows: [
        {
          id: 'exec-bbb',
          slot: 'startap',
          telefone_masked: '5511999990000',
          started_at: '2026-06-09T11:00:00.000Z',
          finished_at: '2026-06-09T11:00:00.000Z',
          duration_ms: 0,
          events_count: 1,
          status_final: 'running',
          gatilho: null, // ARRAY_AGG retornou NULL — sem event_type
        },
      ],
    }),
  };

  const { status, body } = await withServer(buildHandler({ pool }), (s) =>
    request(s, '/api/executions'),
  );

  assert.equal(status, 200);
  assert.equal(body.length, 1);
  assert.equal(body[0].gatilho, null);
});

test('200 — gatilho preservado apos filtro de status em memoria', async () => {
  const pool = {
    query: async () => ({
      rows: [
        {
          id: 'exec-ok',
          slot: 'cirilobarbearia',
          telefone_masked: '5511111112222',
          started_at: '2026-06-09T12:00:00.000Z',
          finished_at: '2026-06-09T12:00:01.000Z',
          duration_ms: 1000,
          events_count: 3,
          status_final: 'success',
          gatilho: 'webhook',
        },
        {
          id: 'exec-err',
          slot: 'cirilobarbearia',
          telefone_masked: '5511333334444',
          started_at: '2026-06-09T12:05:00.000Z',
          finished_at: '2026-06-09T12:05:01.000Z',
          duration_ms: 1000,
          events_count: 2,
          status_final: 'error',
          gatilho: 'message',
        },
      ],
    }),
  };

  const { status, body } = await withServer(buildHandler({ pool }), (s) =>
    request(s, '/api/executions?status=success'),
  );

  assert.equal(status, 200);
  assert.equal(body.length, 1);
  assert.equal(body[0].id, 'exec-ok');
  assert.equal(body[0].gatilho, 'webhook');
});
