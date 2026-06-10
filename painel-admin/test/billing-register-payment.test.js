// Testes do avanco de vencimento no register_payment de PUT /api/billing/:slot (ADR 0014, A1).
// Uso: node --test painel-admin/test/billing-register-payment.test.js
//
// Achado do security (P1): o register_payment manual usava
//   COALESCE(client_billing.next_due_date, CURRENT_DATE) + interval
// que, para um cliente VENCIDO (next_due_date no passado), renova pro PASSADO.
// Correcao: GREATEST(COALESCE(next_due_date, CURRENT_DATE), CURRENT_DATE) + interval
// — avanca a partir de max(vencimento, hoje), espelhando advanceFromMaxDue (packages/db)
// e o avanco do webhook (billing-webhook-events). Aplicado INCONDICIONALMENTE (o painel
// nao le a flag; GREATEST e seguro/correto nos DOIS modelos).
//
// Estrategia: replica a SEMANTICA da SQL (GREATEST(due, hoje) + N meses) em JS puro, sem
// Express nem Postgres. Espelha o padrao de suspend-kind.test.js (testa a regra, nao a infra).
// A aritmetica de meses do PG (date + interval 'N months') faz clamp de fim de mes
// (31/jan + 1 mes = 28/fev), reproduzido aqui por addMonthsClamped.
import assert from 'node:assert/strict';
import { test } from 'node:test';

/** Avanca uma data UTC 'YYYY-MM-DD' em N meses com clamp de fim de mes (igual ao PG). */
function addMonthsClamped(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const total = (y - 1) * 12 + (m - 1) + months;
  const ty = Math.floor(total / 12) + 1;
  const tm = (total % 12) + 1; // 1-12
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const td = Math.min(d, lastDay);
  const pad = (n) => String(n).padStart(2, '0');
  return `${ty}-${pad(tm)}-${pad(td)}`;
}

/**
 * Replica EXATA da semantica do register_payment apos a correcao A1:
 *   next_due_date = GREATEST(COALESCE(currentDue, hoje), hoje) + cycleMonths meses.
 * Compara strings 'YYYY-MM-DD' (ordenacao lexicografica == cronologica) para o GREATEST.
 */
function advanceRegisterPayment(currentDue, today, cycleMonths = 1) {
  const base = currentDue && currentDue > today ? currentDue : today;
  return addMonthsClamped(base, cycleMonths);
}

test('cliente VENCIDO (due no passado) -> novo vencimento parte de HOJE, nao do passado', () => {
  const today = '2026-06-10';
  // Venceu ha um mes. Antes do fix: 2026-05-04 + 1 mes = 2026-06-04 (no passado!).
  const novo = advanceRegisterPayment('2026-05-04', today, 1);
  // Com GREATEST(due, hoje): parte de hoje -> 2026-07-10.
  assert.equal(novo, '2026-07-10');
  // Invariante central: NUNCA renova pro passado.
  assert.ok(novo > today, `novo vencimento ${novo} deve ser futuro (> ${today})`);
});

test('cliente VENCIDO ha muito tempo -> ainda assim cai no futuro', () => {
  const today = '2026-06-10';
  const novo = advanceRegisterPayment('2020-01-10', today, 1);
  assert.equal(novo, '2026-07-10');
  assert.ok(novo > today);
});

test('cliente EM DIA (due no futuro) -> avanca a partir do vencimento (nao perde tempo pago)', () => {
  const today = '2026-06-10';
  // Due em 2026-07-04 (futuro). max(due, hoje) = due. due + 1 mes = 2026-08-04.
  const novo = advanceRegisterPayment('2026-07-04', today, 1);
  assert.equal(novo, '2026-08-04');
});

test('sem vencimento previo (COALESCE -> hoje) -> hoje + 1 mes', () => {
  const today = '2026-06-10';
  const novo = advanceRegisterPayment(null, today, 1);
  assert.equal(novo, '2026-07-10');
});

test('clamp de fim de mes igual ao PG (31/jan + 1 mes = 28/fev em ano nao bissexto)', () => {
  // Em dia: 2027-01-31 + 1 mes -> clamp para 2027-02-28.
  assert.equal(advanceRegisterPayment('2027-01-31', '2026-06-10', 1), '2027-02-28');
});

test('cycle_months > 1 respeitado (vencido, 3 meses, parte de hoje)', () => {
  const today = '2026-06-10';
  const novo = advanceRegisterPayment('2026-01-10', today, 3);
  assert.equal(novo, '2026-09-10');
  assert.ok(novo > today);
});
