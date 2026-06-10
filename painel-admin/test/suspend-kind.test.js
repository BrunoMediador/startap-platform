// Testes da validacao de categoria (suspended_kind) em POST /api/clones/:id/suspend (ADR 0014, F1).
// Uso: node --test painel-admin/test/suspend-kind.test.js
//
// Decisao do Bruno (ADR 0014): a categoria da suspensao e OBRIGATORIA — removido o
// default 'billing'. Sem categoria valida, rejeita com 400 ANTES de tocar o banco.
// Isso evita auto-resume indevido (so kind='billing' reativa ao pagar PIX).
//
// Estrategia: replica SO o trecho de validacao do kind do server.js (linhas ~4028-4032),
// sem inicializar Express + pool Postgres. Espelha o padrao de pairing-code.test.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const VALID_KINDS = ['billing', 'owner_request', 'manual_other', 'abuse'];

/**
 * Replica EXATA da validacao do server.js apos a mudanca do ADR 0014:
 *   const kind = typeof body?.kind === 'string' ? body.kind.trim() : '';
 *   if (!VALID_KINDS.includes(kind)) -> 400 (rejeita).
 * Retorna { ok, kind } ou { ok:false, status:400 }.
 */
function validateSuspendKind(body) {
  const kind = typeof body?.kind === 'string' ? body.kind.trim() : '';
  if (!VALID_KINDS.includes(kind)) {
    return {
      ok: false,
      status: 400,
      error: 'kind obrigatório (billing|owner_request|manual_other|abuse)',
    };
  }
  return { ok: true, kind };
}

test('rejeita 400 quando kind ausente (sem default billing) — ADR 0014', () => {
  const r = validateSuspendKind({ reason: 'inadimplente' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('rejeita 400 quando kind vazio/whitespace', () => {
  assert.equal(validateSuspendKind({ kind: '' }).ok, false);
  assert.equal(validateSuspendKind({ kind: '   ' }).ok, false);
});

test('rejeita 400 quando kind invalido', () => {
  assert.equal(validateSuspendKind({ kind: 'qualquer' }).ok, false);
  assert.equal(validateSuspendKind({ kind: 'BILLING' }).ok, false); // case-sensitive
});

test('aceita cada kind valido explicito', () => {
  for (const k of VALID_KINDS) {
    const r = validateSuspendKind({ kind: k });
    assert.equal(r.ok, true, `kind ${k} deveria ser aceito`);
    assert.equal(r.kind, k);
  }
});

test('NUNCA assume billing silenciosamente (anti auto-resume indevido)', () => {
  // O ponto da decisao: sem kind, o resultado NAO e { ok:true, kind:'billing' }.
  const r = validateSuspendKind({});
  assert.notEqual(r.kind, 'billing');
  assert.equal(r.ok, false);
});
