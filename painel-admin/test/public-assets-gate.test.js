// Testes da liberação de assets públicos no auth-gate (rebrand F4).
// Replica a decisão do middleware em server.js (não importa server.js — mesmo
// padrão de session-auth.test.js, evita boot com PG_PASS/etc).
//
// Regra: /fonts/* (F1) e os favicons da marca (F4) são servidos PRÉ-SESSÃO
// (o /login.html público os referencia). Qualquer outra rota exige requireAuth.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Espelho da decisão do gate (server.js ~568-580) ──────────────────────────
const PUBLIC_PATHS = ['/api/login', '/api/logout', '/login.html'];
const PUBLIC_ICONS = ['/favicon.svg', '/favicon.ico', '/favicon-16.png', '/favicon-32.png', '/apple-touch-icon.png'];

// Retorna 'public' se passa sem auth; 'auth' se cai no requireAuth.
function gate(method, path) {
  if (PUBLIC_PATHS.includes(path)) return 'public';
  if (method === 'GET' && path.startsWith('/fonts/')) return 'public';
  if (method === 'GET' && PUBLIC_ICONS.includes(path)) return 'public';
  return 'auth';
}

test('favicons da marca (F4) são públicos em GET', () => {
  for (const p of ['/favicon.svg', '/favicon-16.png', '/favicon-32.png', '/apple-touch-icon.png']) {
    assert.equal(gate('GET', p), 'public', p + ' deveria ser servido pré-sessão');
  }
});

test('fontes (F1) continuam públicas em GET', () => {
  assert.equal(gate('GET', '/fonts/sora-latin-700-normal.woff2'), 'public');
});

test('favicon não é liberado em método não-GET (só leitura)', () => {
  assert.equal(gate('POST', '/favicon.svg'), 'auth');
  assert.equal(gate('DELETE', '/apple-touch-icon.png'), 'auth');
});

test('allowlist é exata — caminho de ícone não listado exige auth', () => {
  assert.equal(gate('GET', '/icon-192.png'), 'auth');
  assert.equal(gate('GET', '/favicon-180.png'), 'auth');
  assert.equal(gate('GET', '/public/favicon.svg'), 'auth'); // prefixo diferente
});

test('rotas sensíveis continuam atrás do auth-gate', () => {
  assert.equal(gate('GET', '/api/bots'), 'auth');
  assert.equal(gate('GET', '/index.html'), 'auth');
  assert.equal(gate('GET', '/api/executions'), 'auth');
});

test('rotas públicas pré-existentes preservadas', () => {
  assert.equal(gate('POST', '/api/login'), 'public');
  assert.equal(gate('GET', '/login.html'), 'public');
});
