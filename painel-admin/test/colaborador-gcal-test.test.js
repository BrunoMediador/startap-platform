// Testes da lógica do teste de Google Calendar POR COLABORADOR (estabelecimento).
// Uso: node --test painel-admin/test/colaborador-gcal-test.test.js
//
// Cobre as decisões puras que governam:
//   - POST /api/clones/:id/colaboradores/:colabId/gcal/test
//   - o status gravado em POST/PATCH colaborador (fim do "badge verde mentiroso")
//   - o PUT /api/clones/:id/gcal aceitar SA sem calendar_id no estabelecimento
//
// Estratégia: replica SÓ os helpers de decisão do server.js (sem subir Express +
// pool Postgres), espelhando clone-tipo-conta.test.js / suspend-kind.test.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * Replica a decisão de gcal_status ao GRAVAR um colaborador (POST/PATCH).
 * Regra nova: presença de calendarId NÃO promove a 'active' — sempre 'pending'.
 * Só o endpoint /gcal/test (que bate no Google) promove a 'active'.
 */
function statusAoGravarColaborador() {
  return 'pending';
}

/**
 * Replica a decisão de status APÓS o teste real no Google.
 * testOk=true → 'active'; testOk=false → 'invalid'.
 */
function statusAposTeste(testOk) {
  return testOk ? 'active' : 'invalid';
}

/**
 * Replica os GATES do endpoint de teste por colaborador. Retorna { status, error }
 * (status HTTP) ou { ok: true } quando passa para o teste real no Google.
 *  - product_type != 'estabelecimento' → 409
 *  - colabId inválido                  → 400
 *  - colaborador não pertence ao clone → 404
 *  - clone sem Service Account         → 422 clone_sem_service_account
 *  - colaborador sem calendarId        → 400
 */
function gatesTesteColaborador({ productType, colabId, colabExisteNoClone, cloneCreds, colabCalendarId }) {
  if (productType !== 'estabelecimento') return { status: 409, error: 'estabelecimento' };
  if (!Number.isInteger(colabId) || colabId <= 0) return { status: 400, error: 'colabId invalido' };
  if (!colabExisteNoClone) return { status: 404, error: 'colaborador nao encontrado neste clone' };
  if (!cloneCreds) return { status: 422, error: 'clone_sem_service_account' };
  if (!colabCalendarId) return { status: 400, error: 'colaborador sem gcal_calendar_id' };
  return { ok: true };
}

/**
 * Replica a obrigatoriedade de calendar_id no PUT /api/clones/:id/gcal:
 * individual exige calendar_id; estabelecimento aceita só a SA (calendar_id NULL).
 */
function calendarIdObrigatorioNoPut(productType) {
  return productType !== 'estabelecimento';
}

/**
 * Replica a decisão do BACKFILL no GET colaboradores: estabelecimento sem SA →
 * qualquer colaborador 'active' é verde-falso e deve voltar a 'pending'.
 * Retorna true se a linha deve ser resetada.
 */
function deveResetarActiveFake(productType, cloneHasSa, colabStatus) {
  return productType === 'estabelecimento' && !cloneHasSa && colabStatus === 'active';
}

/**
 * Replica a decisão do BADGE no front: clone sem SA nunca mostra "Agenda OK".
 * Retorna o rótulo lógico do badge.
 */
function badgeColaborador(cloneHasSa, hasCalId, gcalStatus) {
  if (!hasCalId) return 'sem-agenda';
  if (!cloneHasSa) return 'precisa-testar';
  if (gcalStatus === 'active') return 'agenda-ok';
  if (gcalStatus === 'invalid') return 'agenda-erro';
  return 'nao-testada';
}

// ── status ao gravar colaborador (fim do badge verde mentiroso) ──────────────

test('gravar colaborador com calendarId NÃO promove a active (fica pending)', () => {
  assert.equal(statusAoGravarColaborador(), 'pending');
});

test('gravar colaborador sem calendarId também fica pending', () => {
  assert.equal(statusAoGravarColaborador(), 'pending');
});

// ── status após teste real ───────────────────────────────────────────────────

test('teste OK promove a active', () => {
  assert.equal(statusAposTeste(true), 'active');
});

test('teste falho marca invalid', () => {
  assert.equal(statusAposTeste(false), 'invalid');
});

// ── gates do endpoint de teste por colaborador ───────────────────────────────

test('individual não pode testar por colaborador (409)', () => {
  const r = gatesTesteColaborador({ productType: 'individual', colabId: 5, colabExisteNoClone: true, cloneCreds: 'x', colabCalendarId: 'a@g' });
  assert.equal(r.status, 409);
});

test('colabId inválido rejeita com 400', () => {
  const r = gatesTesteColaborador({ productType: 'estabelecimento', colabId: 0, colabExisteNoClone: true, cloneCreds: 'x', colabCalendarId: 'a@g' });
  assert.equal(r.status, 400);
});

test('colaborador de outro clone/tenant não é encontrado (404 anti-IDOR)', () => {
  const r = gatesTesteColaborador({ productType: 'estabelecimento', colabId: 5, colabExisteNoClone: false, cloneCreds: 'x', colabCalendarId: 'a@g' });
  assert.equal(r.status, 404);
});

test('clone sem Service Account devolve 422 clone_sem_service_account', () => {
  const r = gatesTesteColaborador({ productType: 'estabelecimento', colabId: 5, colabExisteNoClone: true, cloneCreds: null, colabCalendarId: 'a@g' });
  assert.equal(r.status, 422);
  assert.equal(r.error, 'clone_sem_service_account');
});

test('colaborador sem calendarId não dá pra testar (400)', () => {
  const r = gatesTesteColaborador({ productType: 'estabelecimento', colabId: 5, colabExisteNoClone: true, cloneCreds: 'x', colabCalendarId: null });
  assert.equal(r.status, 400);
});

test('estabelecimento com SA + calendarId passa para o teste real', () => {
  const r = gatesTesteColaborador({ productType: 'estabelecimento', colabId: 5, colabExisteNoClone: true, cloneCreds: 'x', colabCalendarId: 'a@g' });
  assert.equal(r.ok, true);
});

// ── PUT /gcal: calendar_id opcional no estabelecimento ───────────────────────

test('individual exige calendar_id no PUT /gcal', () => {
  assert.equal(calendarIdObrigatorioNoPut('individual'), true);
});

test('estabelecimento aceita salvar só a SA sem calendar_id', () => {
  assert.equal(calendarIdObrigatorioNoPut('estabelecimento'), false);
});

// ── backfill do "active mentiroso" (clone sem SA) ────────────────────────────

test('clone sem SA: colaborador active vira pending (backfill)', () => {
  assert.equal(deveResetarActiveFake('estabelecimento', false, 'active'), true);
});

test('clone com SA: colaborador active permanece (não reseta)', () => {
  assert.equal(deveResetarActiveFake('estabelecimento', true, 'active'), false);
});

test('clone sem SA: colaborador pending não é tocado', () => {
  assert.equal(deveResetarActiveFake('estabelecimento', false, 'pending'), false);
});

test('individual nunca entra no backfill de colaborador', () => {
  assert.equal(deveResetarActiveFake('individual', false, 'active'), false);
});

// ── badge nunca verde sem o robô do salão ────────────────────────────────────

test('badge: clone sem SA + calendarId presente = precisa-testar (nunca ok)', () => {
  assert.equal(badgeColaborador(false, true, 'active'), 'precisa-testar');
});

test('badge: clone com SA + active = agenda-ok', () => {
  assert.equal(badgeColaborador(true, true, 'active'), 'agenda-ok');
});

test('badge: sem calendarId = sem-agenda independente de SA', () => {
  assert.equal(badgeColaborador(true, false, 'active'), 'sem-agenda');
  assert.equal(badgeColaborador(false, false, 'pending'), 'sem-agenda');
});

test('badge: clone com SA + invalid = agenda-erro', () => {
  assert.equal(badgeColaborador(true, true, 'invalid'), 'agenda-erro');
});
