// Testes dos helpers do DELETE /api/clones/:id (exclusão de clone + sessão WAHA + órfãos).
// Uso: node --test painel-admin/test/delete-clone-waha.test.js
//
// Estratégia (mesma de suspend-kind.test.js / pairing-code.test.js): importar
// server.js bootaria Express + pool Postgres, então replicamos AQUI os helpers
// puros — cópia EXATA do server.js — e validamos:
//   1. denylist nunca deixa deletar sessão compartilhada/crítica;
//   2. clientes manuais (sem prefixo clone_) SÃO deletáveis;
//   3. escapeLikePrefix confina o LIKE ao slot exato (curingas _ % \ escapados);
//   4. isValidChatTableName barra nome de tabela malicioso (anti SQL injection).
import assert from 'node:assert/strict';
import { test } from 'node:test';

// ── Réplica EXATA dos helpers do server.js ──────────────────────────────────

const WAHA_SESSION_DELETE_DENYLIST = new Set([
  'STARTAP_AI_PROD',
  'ALERTAS',
  'teste_barbearia',
  'teste_vendas_barbearia',
  'WHATSAPP_ROUTER_TESTE',
]);

function isProtectedWahaSession(sessao) {
  return WAHA_SESSION_DELETE_DENYLIST.has(sessao);
}

function escapeLikePrefix(value) {
  return value.replace(/([\\%_])/g, '\\$1');
}

function isValidChatTableName(table) {
  return typeof table === 'string' && /^chat_histories(_[a-z0-9_]+)?$/.test(table);
}

// ── Denylist: caminho de segurança crítico ──────────────────────────────────

test('denylist protege Lola, ALERTAS, matrizes e roteador', () => {
  for (const s of [
    'STARTAP_AI_PROD',
    'ALERTAS',
    'teste_barbearia',
    'teste_vendas_barbearia',
    'WHATSAPP_ROUTER_TESTE',
  ]) {
    assert.equal(isProtectedWahaSession(s), true, `${s} deveria ser protegida`);
  }
});

test('clientes MANUAIS (sem prefixo clone_) SÃO deletáveis — não na denylist', () => {
  // O ponto da decisão: não reusar o guard clone_ do provisioning.
  assert.equal(isProtectedWahaSession('cirilobarbearia'), false);
  assert.equal(isProtectedWahaSession('barbearia_samuel'), false);
});

test('clones self-service (clone_*) SÃO deletáveis', () => {
  assert.equal(isProtectedWahaSession('clone_edu_barbeiro_a1b2c3'), false);
});

test('denylist é case-sensitive (nome de sessão WAHA é exato)', () => {
  assert.equal(isProtectedWahaSession('alertas'), false);
  assert.equal(isProtectedWahaSession('Startap_Ai_Prod'), false);
});

// ── escapeLikePrefix: confinar a limpeza de órfãos ao slot exato ─────────────

test('escapa o _ (curinga LIKE) para não casar slot vizinho', () => {
  // Sem escapar, 'clone_a:%' casaria 'cloneXa:...'. Com escape, só o literal.
  assert.equal(escapeLikePrefix('clone_edu'), 'clone\\_edu');
});

test('escapa % e \\ além do _', () => {
  assert.equal(escapeLikePrefix('a%b_c\\d'), 'a\\%b\\_c\\\\d');
});

test('slot sem curingas passa intacto', () => {
  assert.equal(escapeLikePrefix('cirilobarbearia'), 'cirilobarbearia');
});

test('prefixo escapado forma um padrão LIKE seguro e anchored', () => {
  // Padrão usado nas queries de alert_states/chat: `${esc}:%` (ou clientalert:${esc}:%)
  assert.equal(`${escapeLikePrefix('clone_edu')}:%`, 'clone\\_edu:%');
  assert.equal(`clientalert:${escapeLikePrefix('clone_edu')}:%`, 'clientalert:clone\\_edu:%');
});

// ── isValidChatTableName: anti SQL injection no nome da tabela (vem do banco) ─

test('aceita as tabelas de chat canônicas', () => {
  for (const t of [
    'chat_histories',
    'chat_histories_ricardo',
    'chat_histories_vendas_barbearia',
    'chat_histories_startap',
  ]) {
    assert.equal(isValidChatTableName(t), true, `${t} deveria ser válida`);
  }
});

test('rejeita nome de tabela malicioso / fora do padrão', () => {
  assert.equal(isValidChatTableName('users'), false);
  assert.equal(isValidChatTableName('chat_histories; DROP TABLE flow_clones'), false);
  assert.equal(isValidChatTableName('chat_histories-evil'), false);
  assert.equal(isValidChatTableName(''), false);
  assert.equal(isValidChatTableName(null), false);
  assert.equal(isValidChatTableName(undefined), false);
});
