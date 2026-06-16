// Testes da validacao/normalizacao de tipo de conta (product_type/seat_cap) no
// POST /api/clones e PATCH /api/clones/:id — escolha do tipo já no wizard "Clonar".
// Uso: node --test painel-admin/test/clone-tipo-conta.test.js
//
// Regra (ADR 0023, migr 052): product_type 'individual'|'estabelecimento';
// seat_cap NULL (sem teto) ou inteiro 1..100. Validacao no app, nao por CHECK.
// Default ao criar = 'individual' (retrocompativel — clonar sem escolher = igual a hoje).
//
// Estrategia: replica SO os helpers do server.js (validarTipoConta + a
// normalizacao do POST), sem subir Express + pool Postgres. Espelha o padrao de
// servicos-duracao-multiplo5.test.js / suspend-kind.test.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * Replica EXATA de validarTipoConta do server.js — regra UNICA usada por
 * POST /api/clones e PATCH /api/clones/:id. Retorna mensagem PT-BR ou null se ok.
 * `undefined` em qualquer campo = "nao informado" e passa.
 */
function validarTipoConta(product_type, seat_cap) {
  if (product_type !== undefined && !['individual', 'estabelecimento'].includes(String(product_type))) {
    return 'product_type deve ser individual ou estabelecimento';
  }
  if (seat_cap !== undefined && seat_cap !== null) {
    const sc = Number(seat_cap);
    if (!Number.isInteger(sc) || sc < 1 || sc > 100) {
      return 'seat_cap deve ser inteiro entre 1 e 100 (ou nulo)';
    }
  }
  return null;
}

/**
 * Replica a normalizacao do POST /api/clones: default 'individual' quando ausente;
 * seat_cap so vale p/ estabelecimento, senao NULL.
 */
function normalizarTipoConta(product_type, seat_cap) {
  const productTypeFinal = product_type !== undefined ? String(product_type) : 'individual';
  const seatCapFinal =
    productTypeFinal === 'estabelecimento' && seat_cap !== undefined && seat_cap !== null
      ? Number(seat_cap)
      : null;
  return { product_type: productTypeFinal, seat_cap: seatCapFinal };
}

// ── Validacao ──────────────────────────────────────────────────────

test('validarTipoConta: ausencia total passa (retrocompativel)', () => {
  assert.equal(validarTipoConta(undefined, undefined), null);
});

test('validarTipoConta: aceita individual e estabelecimento', () => {
  assert.equal(validarTipoConta('individual', undefined), null);
  assert.equal(validarTipoConta('estabelecimento', 3), null);
});

test('validarTipoConta: rejeita product_type invalido', () => {
  assert.match(validarTipoConta('empresa', undefined), /individual ou estabelecimento/);
  assert.match(validarTipoConta('', undefined), /individual ou estabelecimento/);
});

test('validarTipoConta: seat_cap null passa (sem teto)', () => {
  assert.equal(validarTipoConta('estabelecimento', null), null);
});

test('validarTipoConta: aceita seat_cap no intervalo 1..100', () => {
  for (const sc of [1, 3, 50, 100]) {
    assert.equal(validarTipoConta('estabelecimento', sc), null, `seat_cap ${sc} deveria passar`);
  }
});

test('validarTipoConta: rejeita seat_cap fora de 1..100, zero, negativo, nao-inteiro', () => {
  for (const sc of [0, -1, 101, 3.5, 'abc', Number.NaN]) {
    assert.match(
      validarTipoConta('estabelecimento', sc),
      /entre 1 e 100/,
      `seat_cap ${sc} deveria ser rejeitado`,
    );
  }
});

test('validarTipoConta: aceita string numerica de seat_cap (leniencia Number())', () => {
  assert.equal(validarTipoConta('estabelecimento', '3'), null);
  assert.match(validarTipoConta('estabelecimento', '0'), /entre 1 e 100/);
});

// ── Normalizacao do POST (default + retrocompat) ─────────────────────

test('normalizar: sem product_type -> individual + seat_cap null (igual a hoje)', () => {
  assert.deepEqual(normalizarTipoConta(undefined, undefined), {
    product_type: 'individual',
    seat_cap: null,
  });
});

test('normalizar: individual ignora seat_cap (seat_cap so vale p/ estabelecimento)', () => {
  assert.deepEqual(normalizarTipoConta('individual', 5), {
    product_type: 'individual',
    seat_cap: null,
  });
});

test('normalizar: estabelecimento com vagas grava seat_cap numerico', () => {
  assert.deepEqual(normalizarTipoConta('estabelecimento', '3'), {
    product_type: 'estabelecimento',
    seat_cap: 3,
  });
});

test('normalizar: estabelecimento sem vagas -> seat_cap null (sem teto)', () => {
  assert.deepEqual(normalizarTipoConta('estabelecimento', null), {
    product_type: 'estabelecimento',
    seat_cap: null,
  });
  assert.deepEqual(normalizarTipoConta('estabelecimento', undefined), {
    product_type: 'estabelecimento',
    seat_cap: null,
  });
});
