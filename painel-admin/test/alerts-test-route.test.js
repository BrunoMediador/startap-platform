import assert from 'node:assert/strict';
import http from 'node:http';
// Testes para POST /api/alerts/test (Missao 021, Onda 2 parte 1 — "Enviar teste").
// Uso: node --test painel-admin/test/alerts-test-route.test.js
//
// Estrategia: replica standalone da rota com deps injetaveis (query do pool + envio
// WAHA), num mini servidor http. NAO inicializa o Express/pool reais nem bate em
// producao — espelha a logica de server.js (rota app.post('/api/alerts/test')).
import { test } from 'node:test';

const ALERTS_PHONE_RE = /^[1-9]\d{7,14}$/;
const COOLDOWN_MS = 15_000;

function normalizePhone(raw) {
  return String(raw ?? '').replace(/\D/g, '');
}

/**
 * Constroi o handler da rota. Deps injetaveis:
 *  - queryFn(sql, params): espelha pool.query (resolve config/sessao/recipients).
 *  - sendFn(sessao, chatId, texto): espelha o envio WAHA (pode lancar).
 *  - lastSendMap: Map compartilhado p/ exercitar o cooldown.
 *  - userId: operador autenticado (req.session.userId no real).
 *  - now: relogio injetavel p/ testar cooldown deterministico.
 */
function buildRoute({
  queryFn,
  sendFn,
  lastSendMap = new Map(),
  userId = 'op1',
  now = () => Date.now(),
}) {
  return async function handler(req, res) {
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed = {};
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      /* tratado abaixo */
    }

    const t0 = now();
    const last = lastSendMap.get(userId) ?? 0;
    const waitMs = COOLDOWN_MS - (t0 - last);
    if (waitMs > 0) {
      return send(429, {
        error: 'aguarde alguns segundos antes de enviar outro teste',
        retry_after_s: Math.ceil(waitMs / 1000),
      });
    }

    try {
      await queryFn('INSERT INTO alert_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
      const cfg = await queryFn('SELECT sender_slot FROM alert_config WHERE id = 1');
      const senderSlot = cfg.rows[0]?.sender_slot || 'startap';
      const sess = await queryFn('SELECT waha_sessao FROM bot_config WHERE slot = $1', [
        senderSlot,
      ]);
      const sessao = sess.rows[0]?.waha_sessao || null;
      if (!sessao)
        return send(409, {
          error: `remetente '${senderSlot}' sem sessao WAHA configurada (bot_config.waha_sessao)`,
        });

      let targets;
      if (parsed.phone != null && String(parsed.phone).trim() !== '') {
        const phone = normalizePhone(parsed.phone);
        if (!ALERTS_PHONE_RE.test(phone))
          return send(400, {
            error: 'telefone invalido (E.164 so digitos, 8 a 15 digitos, sem +)',
          });
        targets = [{ phone, label: null }];
      } else {
        const r = await queryFn(
          'SELECT phone, label FROM alert_recipients WHERE enabled = TRUE ORDER BY created_at ASC',
        );
        targets = r.rows;
      }
      if (targets.length === 0)
        return send(400, { error: 'cadastre ao menos um numero antes de enviar o teste' });

      lastSendMap.set(userId, t0);
      const texto =
        '🔔 Teste de alerta — Startap. Se você recebeu isto, os alertas estão funcionando.';
      const results = [];
      for (const tg of targets) {
        try {
          await sendFn(sessao, `${tg.phone}@c.us`, texto);
          results.push({ phone: tg.phone, label: tg.label ?? null, ok: true });
        } catch (err) {
          results.push({
            phone: tg.phone,
            label: tg.label ?? null,
            ok: false,
            error: err?.message || 'falha no envio',
          });
        }
      }
      const sent = results.filter((r) => r.ok).length;
      return send(sent > 0 ? 200 : 502, {
        ok: sent > 0,
        sender_slot: senderSlot,
        sessao,
        sent,
        total: results.length,
        results,
      });
    } catch (e) {
      lastSendMap.delete(userId);
      return send(500, { error: 'erro ao enviar alerta de teste' });
    }
  };
}

// Stub de pool.query: roteia por trecho de SQL.
function makeQuery({ senderSlot = 'startap', sessao = 'STARTAP_AI_PROD', recipients = [] } = {}) {
  return async function queryFn(sql) {
    if (sql.includes('FROM alert_config')) return { rows: [{ sender_slot: senderSlot }] };
    if (sql.includes('FROM bot_config')) return { rows: sessao ? [{ waha_sessao: sessao }] : [] };
    if (sql.includes('FROM alert_recipients')) return { rows: recipients };
    return { rows: [] }; // INSERT idempotente
  };
}

function request(server, method, path, { body } = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path,
        method,
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => {
          let p;
          try {
            p = JSON.parse(data);
          } catch {
            p = data;
          }
          resolve({ status: res.statusCode, body: p });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function serve(handler) {
  const server = http.createServer(handler).listen(0);
  await new Promise((r) => server.once('listening', r));
  return server;
}

// ---------------------------------------------------------------------------
// Caminho feliz: 2 destinatarios habilitados, ambos enviam.
// ---------------------------------------------------------------------------
test('200 — envia pros destinatarios habilitados e retorna sucesso por item', async () => {
  const calls = [];
  const sendFn = async (sessao, chatId) => {
    calls.push({ sessao, chatId });
  };
  const queryFn = makeQuery({
    recipients: [
      { phone: '5535999990001', label: 'Bruno' },
      { phone: '5511988887777', label: null },
    ],
  });
  const server = await serve(buildRoute({ queryFn, sendFn }));
  const { status, body } = await request(server, 'POST', '/api/alerts/test', { body: {} });
  server.close();

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.sent, 2);
  assert.equal(body.total, 2);
  assert.equal(body.sessao, 'STARTAP_AI_PROD');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].chatId, '5535999990001@c.us');
  assert.ok(body.results.every((r) => r.ok === true));
});

// ---------------------------------------------------------------------------
// Repoint W3 (Missao 023): sender_slot='alertas' -> envia pela sessao 'ALERTAS'.
// Prova que a rota usa o remetente RESOLVIDO de alert_config.sender_slot ->
// bot_config.waha_sessao (NAO chumba 'startap'/'STARTAP_AI_PROD').
// ---------------------------------------------------------------------------
test('200 — repoint: sender_slot="alertas" envia pela sessao ALERTAS (sem hardcode)', async () => {
  const calls = [];
  const sendFn = async (sessao, chatId) => {
    calls.push({ sessao, chatId });
  };
  const queryFn = makeQuery({
    senderSlot: 'alertas',
    sessao: 'ALERTAS',
    recipients: [{ phone: '5535999247411', label: 'Bruno' }],
  });
  const server = await serve(buildRoute({ queryFn, sendFn }));
  const { status, body } = await request(server, 'POST', '/api/alerts/test', { body: {} });
  server.close();

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.sender_slot, 'alertas');
  assert.equal(body.sessao, 'ALERTAS');
  assert.equal(calls[0].sessao, 'ALERTAS');
});

// ---------------------------------------------------------------------------
// Body com numero especifico: envia SO pra ele, ignora os cadastrados.
// ---------------------------------------------------------------------------
test('200 — body.phone envia apenas para o numero informado', async () => {
  const calls = [];
  const sendFn = async (sessao, chatId) => {
    calls.push(chatId);
  };
  const queryFn = makeQuery({ recipients: [{ phone: '5535999990001', label: 'Bruno' }] });
  const server = await serve(buildRoute({ queryFn, sendFn }));
  const { status, body } = await request(server, 'POST', '/api/alerts/test', {
    body: { phone: '+55 (51) 98888-7777' },
  });
  server.close();

  assert.equal(status, 200);
  assert.equal(body.sent, 1);
  assert.deepEqual(calls, ['5551988887777@c.us']); // normalizado, so digitos
});

// ---------------------------------------------------------------------------
// Erro 1: sem destinatario cadastrado e sem body.phone -> 400 claro.
// ---------------------------------------------------------------------------
test('400 — sem destinatarios cadastrados', async () => {
  const sendFn = async () => {
    throw new Error('nao devia enviar');
  };
  const queryFn = makeQuery({ recipients: [] });
  const server = await serve(buildRoute({ queryFn, sendFn }));
  const { status, body } = await request(server, 'POST', '/api/alerts/test', { body: {} });
  server.close();

  assert.equal(status, 400);
  assert.match(body.error, /cadastre ao menos um numero/);
});

// ---------------------------------------------------------------------------
// Erro 2: WAHA falha pra todos -> 502, mas a rota nao derruba (resultados por item).
// ---------------------------------------------------------------------------
test('502 — WAHA falha em todos os envios, rota responde sem crashar', async () => {
  const sendFn = async () => {
    throw new Error('WAHA HTTP 500');
  };
  const queryFn = makeQuery({ recipients: [{ phone: '5535999990001', label: 'Bruno' }] });
  const server = await serve(buildRoute({ queryFn, sendFn }));
  const { status, body } = await request(server, 'POST', '/api/alerts/test', { body: {} });
  server.close();

  assert.equal(status, 502);
  assert.equal(body.ok, false);
  assert.equal(body.sent, 0);
  assert.equal(body.results[0].ok, false);
  assert.match(body.results[0].error, /WAHA HTTP 500/);
});

// ---------------------------------------------------------------------------
// Remetente sem sessao WAHA -> 409.
// ---------------------------------------------------------------------------
test('409 — sender_slot sem sessao WAHA configurada', async () => {
  const sendFn = async () => {
    throw new Error('nao devia enviar');
  };
  const queryFn = makeQuery({ sessao: null, recipients: [{ phone: '5535999990001' }] });
  const server = await serve(buildRoute({ queryFn, sendFn }));
  const { status, body } = await request(server, 'POST', '/api/alerts/test', { body: {} });
  server.close();

  assert.equal(status, 409);
  assert.match(body.error, /sem sessao WAHA/);
});

// ---------------------------------------------------------------------------
// Anti-abuso: 2o envio dentro do cooldown -> 429.
// ---------------------------------------------------------------------------
test('429 — cooldown bloqueia envio repetido do mesmo operador', async () => {
  const lastSendMap = new Map();
  const sendFn = async () => {};
  const queryFn = makeQuery({ recipients: [{ phone: '5535999990001' }] });
  // Relogio fixo: 1o e 2o request "no mesmo instante" -> cooldown ativo no 2o.
  const now = () => 1_000_000;
  const handler = buildRoute({ queryFn, sendFn, lastSendMap, now });

  let server = await serve(handler);
  const first = await request(server, 'POST', '/api/alerts/test', { body: {} });
  server.close();
  assert.equal(first.status, 200);

  server = await serve(handler);
  const second = await request(server, 'POST', '/api/alerts/test', { body: {} });
  server.close();
  assert.equal(second.status, 429);
  assert.ok(second.body.retry_after_s > 0);
});
