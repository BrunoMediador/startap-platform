// Testes unitarios para a logica de session-based auth (Missao login-bonito).
// Nao importa server.js (evita boot com PG_PASS/etc).
// Testa: requireAuth behavior, login validation logic, logout behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Replica logica de requireAuth ────────────────────────────────────────────
function requireAuth(session, acceptHeader) {
  if (session?.userId) return 'next';
  const acceptsHtml = (acceptHeader || '').includes('text/html');
  if (acceptsHtml) return 'redirect:/login.html';
  return '401:nao autenticado';
}

test('requireAuth — usuario autenticado passa para next()', () => {
  const result = requireAuth({ userId: 'admin' }, 'application/json');
  assert.equal(result, 'next');
});

test('requireAuth — sem sessao + Accept HTML → redirect /login.html', () => {
  const result = requireAuth(null, 'text/html,application/xhtml+xml');
  assert.equal(result, 'redirect:/login.html');
});

test('requireAuth — sem sessao + Accept JSON → 401', () => {
  const result = requireAuth(null, 'application/json');
  assert.equal(result, '401:nao autenticado');
});

test('requireAuth — sessao sem userId → 401 (JSON)', () => {
  const result = requireAuth({}, 'application/json');
  assert.equal(result, '401:nao autenticado');
});

// ── Replica logica de validacao do POST /api/login ───────────────────────────
function validateLogin(body, ADMIN_USER, ADMIN_PASS) {
  const { username, password } = body ?? {};
  if (
    typeof username === 'string' &&
    typeof password === 'string' &&
    username === ADMIN_USER &&
    password === ADMIN_PASS
  ) {
    return { ok: true };
  }
  return { ok: false, status: 401, error: 'credenciais invalidas' };
}

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'senha-forte-123';

test('login — credenciais corretas retornam ok:true', () => {
  const r = validateLogin({ username: ADMIN_USER, password: ADMIN_PASS }, ADMIN_USER, ADMIN_PASS);
  assert.equal(r.ok, true);
});

test('login — senha errada retorna 401', () => {
  const r = validateLogin({ username: ADMIN_USER, password: 'errada' }, ADMIN_USER, ADMIN_PASS);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test('login — usuario errado retorna 401', () => {
  const r = validateLogin({ username: 'hacker', password: ADMIN_PASS }, ADMIN_USER, ADMIN_PASS);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test('login — body vazio retorna 401', () => {
  const r = validateLogin(null, ADMIN_USER, ADMIN_PASS);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test('login — injecao: username nao-string retorna 401', () => {
  const r = validateLogin({ username: { $gt: '' }, password: ADMIN_PASS }, ADMIN_USER, ADMIN_PASS);
  assert.equal(r.ok, false);
});
