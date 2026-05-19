// Testes para GET /api/models e PUT /api/bots/:slot/model (Missao 019).
// Uso: node --test painel-admin/test/models.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Espelha a allowlist definida em server.js — manter em sync.
const MODEL_ALLOWLIST = ['gpt-5.4', 'gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo', 'deepseek-chat'];

// Espelha MODEL_PRICING definido em server.js (subconjunto dos itens da allowlist).
const MODEL_PRICING = {
  'gpt-4o':        { in: 2.5,  out: 10.0 },
  'gpt-4o-mini':   { in: 0.15, out: 0.6  },
  'gpt-3.5-turbo': { in: 0.5,  out: 1.5  },
  'gpt-5.4':       { in: 5.0,  out: 20.0, isEstimate: true },
  'deepseek-chat': { in: 0.27, out: 1.1  },
};

// Replica a lógica de GET /api/models do server.js
function buildModelList() {
  return MODEL_ALLOWLIST.map((id) => {
    const pricing = MODEL_PRICING[id] ?? { in: null, out: null };
    return {
      id,
      label: id === 'gpt-5.4' ? 'GPT-5.4 (mais inteligente, ~estimado)' : id,
      isEstimate: pricing.isEstimate ?? false,
      in: pricing.in,
      out: pricing.out,
    };
  });
}

test('GET /api/models — retorna lista com todos os modelos da allowlist', () => {
  const models = buildModelList();
  assert.equal(models.length, MODEL_ALLOWLIST.length);
  for (const m of models) {
    assert.ok(MODEL_ALLOWLIST.includes(m.id), `id desconhecido: ${m.id}`);
    assert.equal(typeof m.label, 'string');
    assert.equal(typeof m.isEstimate, 'boolean');
  }
});

test('GET /api/models — gpt-5.4 tem isEstimate=true e label especial', () => {
  const models = buildModelList();
  const gpt54 = models.find((m) => m.id === 'gpt-5.4');
  assert.ok(gpt54, 'gpt-5.4 deve estar na lista');
  assert.equal(gpt54.isEstimate, true);
  assert.ok(gpt54.label.includes('estimado'), 'label deve conter "estimado"');
});

test('GET /api/models — todos os outros modelos têm isEstimate=false', () => {
  const models = buildModelList();
  for (const m of models.filter((m) => m.id !== 'gpt-5.4')) {
    assert.equal(m.isEstimate, false, `${m.id} não deve ter isEstimate=true`);
  }
});

test('PUT /api/bots/:slot/model — valida allowlist corretamente', () => {
  const isValid = (model) => MODEL_ALLOWLIST.includes(model);
  assert.equal(isValid('gpt-5.4'), true);
  assert.equal(isValid('gpt-4o'), true);
  assert.equal(isValid('gpt-4o-mini'), true);
  assert.equal(isValid('gpt-3.5-turbo'), true);
  assert.equal(isValid('deepseek-chat'), true);
  // modelos fora da allowlist devem ser rejeitados
  assert.equal(isValid('gpt-999'), false);
  assert.equal(isValid(''), false);
  assert.equal(isValid(undefined), false);
  assert.equal(isValid(null), false);
  assert.equal(isValid('deepseek-reasoner'), false, 'deepseek-reasoner fora da allowlist por ora');
});
