import assert from 'node:assert/strict';
// Testes do fix "persona sticky" no gestao (fix/gestao-prompt-persona-sticky).
// Uso: node --test painel-admin/test/prompt-custom-sticky.test.js
//
// Bug (clone da Ingrid, 15/07): PUT /api/bots/:slot/prompt gravava bot_prompt (200 OK)
// mas NUNCA marcava flow_clones.prompt_custom=true. No proximo save de personalizacao,
// o guard de updateClone (packages/db flow-clones.ts, migration 070/SCRUM-59) re-renderizava
// bot_prompt a partir do template da matriz, apagando a edicao manual. A Meduzza escapava
// por ter prompt_custom=true. Fix: PUT e rollback ARMAM a flag; regerar-prompt (volta ao
// template) DESARMA a flag.
//
// Estrategia (espelha alerts-test-route.test.js): replica os handlers de server.js com um
// pool/client injetavel (queryFn) que registra as queries executadas. NAO inicializa o
// Express/Postgres reais — verifica que o UPDATE flow_clones acontece na MESMA transacao,
// parametrizado, e que o valor certo (true/false) e escrito. Manter em sync com server.js.
import { test } from 'node:test';

// ── Mock de client transacional (pool.connect) ──────────────────────────────
// Cada rota do server.js abre client = await pool.connect(), roda BEGIN/COMMIT.
// O mock registra (sql, params) e devolve respostas roteadas por substring da SQL.
function makeClient(routes = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      for (const [needle, result] of routes) {
        if (sql.includes(needle)) return result;
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
}

// Helpers de assercao sobre o log de queries.
function findUpdate(calls) {
  return calls.find((c) => c.sql.includes('UPDATE flow_clones SET prompt_custom'));
}
function indexOfSql(calls, needle) {
  return calls.findIndex((c) => c.sql.includes(needle));
}

// ── Copia fiel do handler PUT /api/bots/:slot/prompt (parte que importa) ─────
// So o essencial: BEGIN -> snapshot condicional -> upsert bot_prompt -> UPDATE
// flow_clones prompt_custom=true -> COMMIT. Espelha server.js.
async function putPromptHandler(client, { slot, newPrompt }) {
  await client.query('BEGIN');
  const cur = await client.query('SELECT prompt FROM bot_prompt WHERE slot = $1', [slot]);
  if (cur.rows.length && cur.rows[0].prompt !== newPrompt) {
    const maxRes = await client.query(
      'SELECT COALESCE(MAX(version), 0) AS m FROM bot_prompt_versions WHERE slot = $1',
      [slot],
    );
    const nextVersion = Number(maxRes.rows[0].m) + 1;
    await client.query(
      'INSERT INTO bot_prompt_versions (slot, version, prompt, edited_by, comment) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (slot, version) DO NOTHING RETURNING version',
      [slot, nextVersion, cur.rows[0].prompt, 'admin', 'auto-snapshot pre-edit'],
    );
  }
  await client.query(
    'INSERT INTO bot_prompt (slot, prompt, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (slot) DO UPDATE SET prompt = EXCLUDED.prompt, updated_at = NOW() RETURNING slot, prompt, updated_at',
    [slot, newPrompt],
  );
  await client.query('UPDATE flow_clones SET prompt_custom = true WHERE slot = $1', [slot]);
  await client.query('COMMIT');
}

// ── Copia fiel do handler rollback (parte que importa) ───────────────────────
async function rollbackHandler(client, { slot, version }) {
  await client.query('BEGIN');
  const v = await client.query(
    'SELECT prompt FROM bot_prompt_versions WHERE slot = $1 AND version = $2',
    [slot, version],
  );
  if (!v.rows.length) {
    await client.query('ROLLBACK');
    return { status: 404 };
  }
  await client.query('UPDATE bot_prompt SET prompt = $1, updated_at = NOW() WHERE slot = $2', [
    v.rows[0].prompt,
    slot,
  ]);
  await client.query('UPDATE flow_clones SET prompt_custom = true WHERE slot = $1', [slot]);
  await client.query('COMMIT');
  return { status: 200 };
}

// ── Copia fiel do endpoint regerar-prompt (parte que importa) ────────────────
// Aqui NAO ha transacao (pool.query direto). Espelha server.js:
//   SELECT * -> GUARD prompt_custom (SCRUM-81) -> regerarPromptClone -> reset flag.
// O GUARD (SCRUM-81): regerar e DESTRUTIVO pra persona custom e NAO versiona; se
// prompt_custom=true exige confirm explicito (body/query confirm=true), senao 409.
async function regerarHandler(pool, { id, body = {}, query = {} }) {
  const r = await pool.query('SELECT * FROM flow_clones WHERE id = $1', [id]);
  if (!r.rows[0]) return { status: 404 };
  const confirmed = body.confirm === true || body.confirm === 'true' || query.confirm === 'true';
  if (r.rows[0].prompt_custom === true && !confirmed) {
    return { status: 409, error: 'prompt_custom_confirm_required' };
  }
  // regerarPromptClone (nao mockado aqui — assumimos ok) re-renderiza da matriz.
  await pool.query('UPDATE flow_clones SET prompt_custom = false WHERE id = $1', [id]);
  return { status: 200 };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT — slot de CLONE: arma prompt_custom=true, parametrizado, dentro da transacao
// ─────────────────────────────────────────────────────────────────────────────
test('PUT prompt (clone): seta prompt_custom=true parametrizado, antes do COMMIT', async () => {
  const client = makeClient([
    // prompt atual difere -> gera snapshot; upsert retorna a linha
    ['SELECT prompt FROM bot_prompt WHERE slot', { rows: [{ prompt: 'persona antiga' }] }],
    ['COALESCE(MAX(version)', { rows: [{ m: 3 }] }],
    ['INSERT INTO bot_prompt_versions', { rows: [{ version: 4 }], rowCount: 1 }],
    [
      'INSERT INTO bot_prompt',
      { rows: [{ slot: 'clone_x', prompt: 'nova persona', updated_at: 'now' }] },
    ],
  ]);
  await putPromptHandler(client, { slot: 'clone_x', newPrompt: 'nova persona' });

  const upd = findUpdate(client.calls);
  assert.ok(upd, 'UPDATE flow_clones prompt_custom deveria ter sido executado');
  assert.match(upd.sql, /prompt_custom = true/, 'deve setar TRUE (arma o sticky)');
  assert.deepEqual(upd.params, ['clone_x'], 'slot deve ir parametrizado ($1), sem interpolacao');

  // Ordem: o UPDATE tem de estar DENTRO da transacao (depois do BEGIN, antes do COMMIT).
  const iBegin = indexOfSql(client.calls, 'BEGIN');
  const iUpd = indexOfSql(client.calls, 'UPDATE flow_clones SET prompt_custom');
  const iCommit = indexOfSql(client.calls, 'COMMIT');
  assert.ok(
    iBegin < iUpd && iUpd < iCommit,
    'UPDATE deve estar entre BEGIN e COMMIT (mesma transacao)',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT — slot de MATRIZ: UPDATE roda mas afeta 0 linhas (no-op), sem erro
// ─────────────────────────────────────────────────────────────────────────────
test('PUT prompt (matriz): UPDATE flow_clones e no-op (rowCount 0), nao lanca', async () => {
  // Matriz nao tem linha em flow_clones -> UPDATE devolve rowCount 0.
  const client = makeClient([
    ['SELECT prompt FROM bot_prompt WHERE slot', { rows: [{ prompt: 'template' }] }],
    ['COALESCE(MAX(version)', { rows: [{ m: 0 }] }],
    ['INSERT INTO bot_prompt_versions', { rows: [{ version: 1 }], rowCount: 1 }],
    [
      'INSERT INTO bot_prompt',
      { rows: [{ slot: 'teste_barbearia', prompt: 'novo', updated_at: 'now' }] },
    ],
    ['UPDATE flow_clones SET prompt_custom', { rows: [], rowCount: 0 }],
  ]);
  await assert.doesNotReject(
    putPromptHandler(client, { slot: 'teste_barbearia', newPrompt: 'novo' }),
    'matriz sem linha em flow_clones nao deve virar erro',
  );
  const upd = findUpdate(client.calls);
  assert.ok(upd, 'o UPDATE e emitido mesmo pra matriz (a semantica no-op mora no rowCount 0)');
  assert.deepEqual(upd.params, ['teste_barbearia']);
  // COMMIT ainda acontece (a transacao fecha normal apesar do no-op).
  assert.ok(indexOfSql(client.calls, 'COMMIT') > -1, 'transacao deve commitar mesmo com no-op');
});

// ─────────────────────────────────────────────────────────────────────────────
// Rollback — restaurar versao tambem arma prompt_custom=true
// ─────────────────────────────────────────────────────────────────────────────
test('rollback: seta prompt_custom=true parametrizado dentro da transacao', async () => {
  const client = makeClient([
    ['SELECT prompt FROM bot_prompt_versions WHERE slot', { rows: [{ prompt: 'v antiga' }] }],
  ]);
  const out = await rollbackHandler(client, { slot: 'clone_x', version: 2 });
  assert.equal(out.status, 200);

  const upd = findUpdate(client.calls);
  assert.ok(upd, 'rollback deveria armar prompt_custom');
  assert.match(upd.sql, /prompt_custom = true/);
  assert.deepEqual(upd.params, ['clone_x']);

  const iBegin = indexOfSql(client.calls, 'BEGIN');
  const iUpd = indexOfSql(client.calls, 'UPDATE flow_clones SET prompt_custom');
  const iCommit = indexOfSql(client.calls, 'COMMIT');
  assert.ok(iBegin < iUpd && iUpd < iCommit, 'UPDATE dentro da transacao do rollback');
});

test('rollback: versao inexistente -> 404 e NAO toca prompt_custom', async () => {
  const client = makeClient([['SELECT prompt FROM bot_prompt_versions WHERE slot', { rows: [] }]]);
  const out = await rollbackHandler(client, { slot: 'clone_x', version: 99 });
  assert.equal(out.status, 404);
  assert.equal(findUpdate(client.calls), undefined, 'nao deve armar a flag se a versao nao existe');
});

// ─────────────────────────────────────────────────────────────────────────────
// regerar-prompt — caminho de voltar ao template DESARMA prompt_custom=false
// ─────────────────────────────────────────────────────────────────────────────
test('regerar-prompt (prompt_custom=false): reseta prompt_custom=false por id, parametrizado', async () => {
  // Template (nada a perder) -> segue sem confirm.
  const pool = makeClient([
    ['SELECT * FROM flow_clones WHERE id', { rows: [{ id: 42, prompt_custom: false }] }],
  ]);
  const out = await regerarHandler(pool, { id: 42 });
  assert.equal(out.status, 200);

  const upd = findUpdate(pool.calls);
  assert.ok(upd, 'regerar-prompt deveria resetar prompt_custom');
  assert.match(upd.sql, /prompt_custom = false/, 'volta ao template = DESARMA o sticky');
  assert.deepEqual(upd.params, [42], 'id parametrizado ($1)');
});

// ─────────────────────────────────────────────────────────────────────────────
// GUARD SCRUM-81 — regerar num clone com persona custom exige confirmacao
// ─────────────────────────────────────────────────────────────────────────────
test('regerar-prompt (prompt_custom=true, SEM confirm): 409 e NAO toca o bot_prompt/flag', async () => {
  const pool = makeClient([
    ['SELECT * FROM flow_clones WHERE id', { rows: [{ id: 7, prompt_custom: true }] }],
  ]);
  const out = await regerarHandler(pool, { id: 7 });
  assert.equal(out.status, 409, 'persona custom sem confirmacao = bloqueado');
  assert.equal(out.error, 'prompt_custom_confirm_required');
  // NADA de UPDATE prompt_custom=false: a persona custom nao foi destruida.
  assert.equal(findUpdate(pool.calls), undefined, 'guard fail-closed: nao reseta a flag');
});

test('regerar-prompt (prompt_custom=true, confirm=true no body): procede e desarma a flag', async () => {
  const pool = makeClient([
    ['SELECT * FROM flow_clones WHERE id', { rows: [{ id: 7, prompt_custom: true }] }],
  ]);
  const out = await regerarHandler(pool, { id: 7, body: { confirm: true } });
  assert.equal(out.status, 200, 'com confirmacao explicita o regerar procede');
  const upd = findUpdate(pool.calls);
  assert.ok(upd, 'confirmado -> reseta prompt_custom');
  assert.match(upd.sql, /prompt_custom = false/);
  assert.deepEqual(upd.params, [7]);
});

test('regerar-prompt (prompt_custom=true, confirm=true na query): tambem procede', async () => {
  const pool = makeClient([
    ['SELECT * FROM flow_clones WHERE id', { rows: [{ id: 7, prompt_custom: true }] }],
  ]);
  const out = await regerarHandler(pool, { id: 7, query: { confirm: 'true' } });
  assert.equal(out.status, 200, 'confirm=true tambem aceito via query string');
  assert.ok(findUpdate(pool.calls), 'confirmado por query -> reseta a flag');
});

test('regerar-prompt: id inexistente -> 404 e NAO reseta nada', async () => {
  const pool = makeClient([['SELECT * FROM flow_clones WHERE id', { rows: [] }]]);
  const out = await regerarHandler(pool, { id: 999 });
  assert.equal(out.status, 404);
  assert.equal(findUpdate(pool.calls), undefined);
});
