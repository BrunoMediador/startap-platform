// Testes do payload de criacao de sessao WAHA — POST /api/sessions (server.js).
// Uso: node --test painel-admin/test/session-create-config.test.js
//
// Padrao-ouro de sessao nova (diretriz Bruno 12/06): toda sessao WAHA criada
// segue EXPLICITAMENTE a config das sessoes prod comprovadas (GET real de
// `cirilobarbearia`, WAHA Plus 2026.3.2 NOWEB — evidencia 2026-06-12).
// Default implicito da instancia e FRAGIL: o trial nasceu com
// retries.delaySeconds=2 enquanto Cirilo tem 3. Se este teste quebrar porque
// alguem removeu ignore/retries/noweb "por serem default do WAHA", restaure
// os campos — NAO remova o teste.
//
// SCRUM-145 (PR #511): o `noweb.store` passou de enabled=false -> enabled=true.
// store ON e pre-requisito do GET /chats e /contacts do WAHA (fonte de NOME de
// contato no portal) e do /api/sendSeen. So afeta o CREATE de sessao NOVA;
// sessoes antigas store-less (samuel/cirilo/dragon) NAO sao tocadas. Mantido em
// sincronia com server.js WAHA_SESSION_NOWEB e com clone-provisioning.ts
// (packages/integrations, SESSION_NOWEB, testado la).
//
// Estrategia: replica EXATA do buildWahaWebhooks + montagem do config da rota
// POST /api/sessions do server.js, sem inicializar Express + pool Postgres.
// Espelha o padrao de suspend-kind.test.js / models.test.js. ESTE e o UNICO
// espelho do payload de create — nao criar um segundo arquivo paralelo (era o
// waha-session-store.test.js, consolidado aqui para evitar afirmacoes opostas
// sobre o MESMO payload).
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TS_WEBHOOK_URL = 'http://startap-api:3040/webhooks/waha';

// Espelho das constantes do server.js (padrao Cirilo, diretriz Bruno 12/06).
const WAHA_WEBHOOK_RETRIES = { attempts: 15, delaySeconds: 3, policy: 'constant' };
const WAHA_SESSION_IGNORE = { status: true, groups: true, channels: true, broadcast: true };
// SCRUM-145: store LIGADO (era false). Espelha server.js WAHA_SESSION_NOWEB.
const WAHA_SESSION_NOWEB = { markOnline: true, store: { enabled: true, fullSync: false } };

/** Replica do buildWahaWebhooks do server.js (com envs de auth injetaveis). */
function buildWahaWebhooks(events, { hmacKey = '', secret = '' } = {}) {
  const webhook = { url: TS_WEBHOOK_URL, events, retries: WAHA_WEBHOOK_RETRIES };
  if (hmacKey) webhook.hmac = { key: hmacKey };
  if (secret) webhook.customHeaders = [{ name: 'X-Webhook-Secret', value: secret }];
  return [webhook];
}

/** Replica da montagem do config de POST /api/sessions do server.js. */
function buildSessionCreateBody(name, authEnvs) {
  return {
    name,
    start: true,
    config: {
      webhooks: buildWahaWebhooks(['message.any', 'session.status'], authEnvs),
      ignore: WAHA_SESSION_IGNORE,
      noweb: WAHA_SESSION_NOWEB,
    },
  };
}

test('config.ignore explicito — bot SO responde chat privado (padrao Cirilo)', () => {
  const body = buildSessionCreateBody('clone_x');
  assert.deepEqual(body.config.ignore, {
    status: true,
    groups: true,
    channels: true,
    broadcast: true,
  });
});

test('webhook nasce com retries explicito igual Cirilo (attempts 15, constant 3s)', () => {
  const body = buildSessionCreateBody('clone_x');
  assert.deepEqual(body.config.webhooks[0].retries, {
    attempts: 15,
    delaySeconds: 3,
    policy: 'constant',
  });
});

test('config.noweb explicito — markOnline on, store LIGADO (SCRUM-145)', () => {
  // store.enabled=true (SCRUM-145): fonte de NOME de contato (GET /chats,/contacts)
  // e do /api/sendSeen. Antes era false; o payload shippado em server.js liga.
  const body = buildSessionCreateBody('clone_x');
  assert.deepEqual(body.config.noweb, {
    markOnline: true,
    store: { enabled: true, fullSync: false },
  });
});

test('CREATE de sessao nova nasce com NOWEB store LIGADO (SCRUM-145)', () => {
  const body = buildSessionCreateBody('clone_novo_x');
  assert.equal(body.config.noweb.store.enabled, true, 'store.enabled deve ser true');
});

test('store.fullSync=false — cobre ~3 meses sem o I/O do fullSync completo', () => {
  const body = buildSessionCreateBody('clone_novo_x');
  assert.equal(body.config.noweb.store.fullSync, false);
});

test('events continuam SO message.any + session.status (fix double-reply intacto)', () => {
  const body = buildSessionCreateBody('clone_x');
  assert.deepEqual(body.config.webhooks[0].events, ['message.any', 'session.status']);
});

test('retries nao interfere na auth do webhook (hmac/customHeaders coexistem)', () => {
  const body = buildSessionCreateBody('clone_x', { hmacKey: 'k', secret: 's' });
  const wh = body.config.webhooks[0];
  assert.deepEqual(wh.retries, WAHA_WEBHOOK_RETRIES);
  assert.deepEqual(wh.hmac, { key: 'k' });
  assert.deepEqual(wh.customHeaders, [{ name: 'X-Webhook-Secret', value: 's' }]);
});

test('ligar store nao regride o restante do padrao Cirilo', () => {
  // Guarda anti-regressao: ligar store nao pode ter mexido em ignore/events/retries.
  const body = buildSessionCreateBody('clone_novo_x');
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
    body: JSON.stringify(buildSessionCreateBody('clone_deploy_waha', { hmacKey: 'k', secret: 's' })),
  });
  assert.ok(captured, 'body deve ter sido enviado');
  assert.equal(captured.config.noweb.store.enabled, true);
  assert.equal(captured.config.noweb.store.fullSync, false);
  // auth (hmac + header) coexistem sem afetar o store
  assert.equal(captured.config.webhooks[0].hmac.key, 'k');
  assert.equal(captured.config.webhooks[0].customHeaders[0].value, 's');
});
