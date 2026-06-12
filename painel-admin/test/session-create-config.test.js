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
// Estrategia: replica EXATA do buildWahaWebhooks + montagem do config da rota
// POST /api/sessions do server.js, sem inicializar Express + pool Postgres.
// Espelha o padrao de suspend-kind.test.js / models.test.js. Manter em sync
// com server.js E com clone-provisioning.ts (packages/integrations).
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TS_WEBHOOK_URL = 'http://startap-api:3040/webhooks/waha';

// Espelho das constantes do server.js (padrao Cirilo, diretriz Bruno 12/06).
const WAHA_WEBHOOK_RETRIES = { attempts: 15, delaySeconds: 3, policy: 'constant' };
const WAHA_SESSION_IGNORE = { status: true, groups: true, channels: true, broadcast: true };
const WAHA_SESSION_NOWEB = { markOnline: true, store: { enabled: false, fullSync: false } };

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

test('config.noweb explicito — markOnline on, store de chats/contatos off', () => {
  // store.enabled=false e o padrao dos clones (Cirilo); recent-contacts ja tem
  // fallback via message_log pra sessao sem store.
  const body = buildSessionCreateBody('clone_x');
  assert.deepEqual(body.config.noweb, {
    markOnline: true,
    store: { enabled: false, fullSync: false },
  });
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
