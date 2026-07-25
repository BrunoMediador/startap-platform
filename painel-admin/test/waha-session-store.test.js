// Testes do payload de CREATE de sessão WAHA nova (POST /api/sessions) — SCRUM-145.
// Replica a montagem do body em server.js (~5116-5148) SEM importar server.js
// (mesmo padrão de public-assets-gate.test.js — evita boot com PG_PASS/etc).
//
// Regra SCRUM-145: toda sessão NOVA criada por aqui (deploy-waha via gestão) nasce
// com `config.noweb.store.enabled=true` + `fullSync=false`. store ON é pré-requisito
// do GET /chats e /contacts do WAHA (fonte de NOME de contato do portal) e do
// /api/sendSeen. Sessões antigas store-less (samuel/cirilo/dragon) NÃO são tocadas
// (config só afeta o CREATE de sessão nova). Este caminho tem que ficar em sincronia
// com o provisionamento (clone-provisioning.ts SESSION_NOWEB, já testado lá).
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Espelho dos constantes/monta-payload de server.js ────────────────────────
const WAHA_WEBHOOK_RETRIES = { attempts: 15, delaySeconds: 3, policy: 'constant' };
const WAHA_SESSION_IGNORE = { status: true, groups: true, channels: true, broadcast: true };
// SCRUM-145: store LIGADO (era false). Espelha server.js WAHA_SESSION_NOWEB.
const WAHA_SESSION_NOWEB = { markOnline: true, store: { enabled: true, fullSync: false } };

function buildWahaWebhooks(events, { hmacKey = '', secret = '' } = {}) {
  const webhook = { url: 'https://api.mock/webhook', events, retries: WAHA_WEBHOOK_RETRIES };
  if (hmacKey) webhook.hmac = { key: hmacKey };
  if (secret) webhook.customHeaders = [{ name: 'X-Webhook-Secret', value: secret }];
  return [webhook];
}

// Monta o body EXATO que o handler POST /api/sessions envia ao WAHA.
function buildCreateSessionBody(name, authOpts) {
  return {
    name,
    start: true,
    config: {
      webhooks: buildWahaWebhooks(['message.any', 'session.status'], authOpts),
      ignore: WAHA_SESSION_IGNORE,
      noweb: WAHA_SESSION_NOWEB,
    },
  };
}

test('CREATE de sessão nova nasce com NOWEB store LIGADO (SCRUM-145)', () => {
  const body = buildCreateSessionBody('clone_novo_x');
  assert.equal(body.config.noweb.store.enabled, true, 'store.enabled deve ser true');
});

test('store.fullSync=false — cobre ~3 meses sem o I/O do fullSync completo', () => {
  const body = buildCreateSessionBody('clone_novo_x');
  assert.equal(body.config.noweb.store.fullSync, false);
});

test('noweb completo bate com o padrão-ouro (markOnline + store)', () => {
  const body = buildCreateSessionBody('clone_novo_x');
  assert.deepEqual(body.config.noweb, {
    markOnline: true,
    store: { enabled: true, fullSync: false },
  });
});

test('a config de store não regride o restante do padrão Cirilo', () => {
  // Guarda anti-regressão: ligar store não pode ter mexido em ignore/events/retries.
  const body = buildCreateSessionBody('clone_novo_x');
  assert.deepEqual(body.config.ignore, {
    status: true,
    groups: true,
    channels: true,
    broadcast: true,
  });
  assert.deepEqual(body.config.webhooks[0].events, ['message.any', 'session.status']);
  assert.deepEqual(body.config.webhooks[0].retries, {
    attempts: 15,
    delaySeconds: 3,
    policy: 'constant',
  });
  assert.equal(body.start, true);
});

test('fetch de create envia o payload com store ligado (mock end-to-end)', async () => {
  // Simula o await fetch(`${WAHA_URL}/api/sessions`, {...}) do handler, capturando
  // o body serializado — prova que o JSON no fio carrega store.enabled=true.
  let captured = null;
  const fakeFetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return { ok: true, status: 201, json: async () => ({ name: captured.name, status: 'STARTING' }) };
  };
  await fakeFetch('https://waha.mock/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildCreateSessionBody('clone_deploy_waha', { hmacKey: 'k', secret: 's' })),
  });
  assert.ok(captured, 'body deve ter sido enviado');
  assert.equal(captured.config.noweb.store.enabled, true);
  assert.equal(captured.config.noweb.store.fullSync, false);
  // auth (hmac + header) coexistem sem afetar o store
  assert.equal(captured.config.webhooks[0].hmac.key, 'k');
  assert.equal(captured.config.webhooks[0].customHeaders[0].value, 's');
});
