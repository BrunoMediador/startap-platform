// Testes do PRESERVE de gcal_status no PATCH colaborador (estabelecimento).
// Uso: node --test painel-admin/test/colaborador-patch-gcal-status.test.js
//
// Cobre o fix da rota PATCH /api/clones/:id/colaboradores/:colabId:
//   o PATCH só reseta gcal_status para 'pending' quando o calendarId REALMENTE muda
//   (ou é limpo). Se o calendarId enviado é IGUAL ao do banco, PRESERVA o status atual
//   ('active'/'invalid' que veio do /gcal/test) — senão um "salvar" logo após o
//   "testar verde" apagava o 'active' e o colaborador voltava a 'pending' (bot ficava
//   em silêncio: "nenhum colaborador agendável").
//
// Estratégia: replica a decisão PURA do CASE SQL usado no UPDATE (sem subir Express +
// pool Postgres), espelhando colaborador-gcal-test.test.js / clone-tipo-conta.test.js.
//
// SQL real:
//   gcal_status = CASE WHEN gcal_calendar_id IS DISTINCT FROM $novo
//                      THEN 'pending' ELSE gcal_status END
import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * Replica o CASE do UPDATE. `oldCalId`/`newCalId` são o calendarId ANTIGO (linha) e o
 * NOVO (payload); `oldStatus` é o gcal_status atual no banco.
 * Semântica IS DISTINCT FROM (null-safe): NULL vs NULL = não mudou.
 */
function statusAposPatch({ oldCalId, newCalId, oldStatus }) {
  const mudou = oldCalId !== newCalId; // IS DISTINCT FROM (ambos podem ser null)
  return mudou ? 'pending' : oldStatus;
}

/**
 * Replica se o campo gcal_status entra ou não no SET. Quando o payload NÃO traz
 * gcal_calendar_id (b.gcal_calendar_id === undefined), nem o calendarId nem o status
 * são tocados pelo PATCH.
 */
function gcalStatusEntraNoUpdate(payloadTemCalendarId) {
  return payloadTemCalendarId === true;
}

// ── calendarId IGUAL: preserva o status do teste (o bug do Bruno) ────────────

test('PATCH com calendarId IGUAL + status active no banco → continua active', () => {
  assert.equal(
    statusAposPatch({ oldCalId: 'maria@group.calendar.google.com', newCalId: 'maria@group.calendar.google.com', oldStatus: 'active' }),
    'active',
  );
});

test('PATCH com calendarId IGUAL + status invalid no banco → continua invalid', () => {
  assert.equal(
    statusAposPatch({ oldCalId: 'maria@g', newCalId: 'maria@g', oldStatus: 'invalid' }),
    'invalid',
  );
});

// ── calendarId DIFERENTE/limpo: reseta pra pending (confiança só vem do /gcal/test) ──

test('PATCH com calendarId DIFERENTE → vira pending (mesmo que estava active)', () => {
  assert.equal(
    statusAposPatch({ oldCalId: 'maria@g', newCalId: 'joao@g', oldStatus: 'active' }),
    'pending',
  );
});

test('PATCH que LIMPA o calendarId (null) → vira pending', () => {
  assert.equal(
    statusAposPatch({ oldCalId: 'maria@g', newCalId: null, oldStatus: 'active' }),
    'pending',
  );
});

test('PATCH que DEFINE calendarId pela 1a vez (null → valor) → pending', () => {
  assert.equal(
    statusAposPatch({ oldCalId: null, newCalId: 'maria@g', oldStatus: 'pending' }),
    'pending',
  );
});

test('PATCH com ambos null (não muda nada) preserva o status', () => {
  assert.equal(
    statusAposPatch({ oldCalId: null, newCalId: null, oldStatus: 'invalid' }),
    'invalid',
  );
});

// ── payload sem gcal_calendar_id: status intocado ────────────────────────────

test('PATCH que nem manda gcal_calendar_id não toca o gcal_status', () => {
  assert.equal(gcalStatusEntraNoUpdate(false), false);
});

test('PATCH que manda gcal_calendar_id entra na regra do CASE', () => {
  assert.equal(gcalStatusEntraNoUpdate(true), true);
});
