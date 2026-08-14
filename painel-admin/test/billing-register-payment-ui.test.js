// Contrato da UI de pagamento manual no painel legado (SCRUM-170).
// Uso: node --test painel-admin/test/billing-register-payment-ui.test.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function loadOutcomeResolver() {
  const match = source.match(
    / {2}function _manualPaymentOutcome\(result\) \{[\s\S]*?\n {2}\}\n\n {2}function _renderManualPaymentOutcome/,
  );
  assert.ok(match, '_manualPaymentOutcome não localizado');
  const functionSource = match[0].replace(/\n\n {2}function _renderManualPaymentOutcome$/, '');
  return new Function(`${functionSource}\nreturn _manualPaymentOutcome;`)();
}

const outcome = loadOutcomeResolver();

function loadFailurePolicy() {
  const match = source.match(
    / {2}function _manualPaymentFailurePolicy\(err\) \{[\s\S]*?\n {2}\}\n\n {2}function _openRegisterPayment/,
  );
  assert.ok(match, '_manualPaymentFailurePolicy não localizado');
  const functionSource = match[0].replace(/\n\n {2}function _openRegisterPayment$/, '');
  return new Function(`${functionSource}\nreturn _manualPaymentFailurePolicy;`)();
}

const failurePolicy = loadFailurePolicy();

test('pagamento que remove billing comunica cada efeito sem prometer bot reativado', () => {
  const result = outcome({
    ok: true,
    resumed: true,
    billing: { next_due_date: '2026-09-13' },
    final_state: { flow_enabled: true, suspended_kind: null, suspension_preserved: null },
  });
  assert.match(result.payment, /Registrado/);
  assert.match(result.billingSuspension, /^Sim/);
  assert.match(result.otherPause, /^Não/);
  assert.match(result.atendimento, /Habilitado no fluxo/);
  assert.match(result.atendimento, /WhatsApp não foi verificada/);
  assert.doesNotMatch(JSON.stringify(result), /bot reativado/i);
});

test('pagamento preserva owner_request e comunica que atendimento continua pausado', () => {
  const result = outcome({
    ok: true,
    resumed: false,
    final_state: {
      flow_enabled: false,
      suspended_kind: 'owner_request',
      suspension_preserved: 'owner_request',
    },
  });
  assert.match(result.billingSuspension, /^Não/);
  assert.match(result.otherPause, /^Sim/);
  assert.match(result.otherPause, /cliente continua ativa/);
  assert.match(result.atendimento, /Continua pausado pelo cliente/);
});

test('pagamento preserva manual_other e abuse como suspensões da Startap', () => {
  for (const kind of ['manual_other', 'abuse']) {
    const result = outcome({
      ok: true,
      resumed: false,
      final_state: { flow_enabled: false, suspended_kind: kind, suspension_preserved: kind },
    });
    assert.match(result.billingSuspension, /^Não/);
    assert.match(result.otherPause, /^Sim/);
    assert.match(result.atendimento, /Continua suspenso pela Startap/);
  }
});

test('estado final ausente falha fechado e impede conclusão otimista', () => {
  const result = outcome({ ok: true, resumed: false, billing: {} });
  assert.match(result.billingSuspension, /Não confirmado/);
  assert.match(result.otherPause, /Não confirmado/);
  assert.match(result.atendimento, /não confirmado/i);
  assert.equal(result.requiresReview, true);
});

test('handler impede dupla submissão antes do PUT e usa a resposta final real', () => {
  const handler = source.match(
    /function _openRegisterPayment\(slot, billing, labels\) \{[\s\S]*?\n {2}\}\n\n {2}function _openEditBilling/,
  );
  assert.ok(handler, '_openRegisterPayment não localizado');
  const code = handler[0];
  assert.match(code, /if \(submitting \|\| retryBlocked\) return;/);
  const busy = code.indexOf('setBusy(true)');
  const put = code.indexOf('await api(`/api/billing/');
  assert.ok(busy >= 0 && put > busy, 'controles devem ser travados antes do PUT');
  assert.match(code, /const result = await api/);
  assert.match(code, /_renderManualPaymentOutcome\(result\)/);
  assert.match(
    code,
    /requestAnimationFrame\(\(\) => document\.getElementById\('pa-pay-result'\)\?\.focus\(\)\)/,
  );
});

test('500 e 503 são resultado não confirmado e exigem releitura sem retry', () => {
  for (const status of [500, 503]) {
    const result = failurePolicy({ status });
    assert.equal(result.retrySafe, false);
    assert.equal(result.requiresReread, true);
    assert.match(result.message, /Resultado não confirmado/);
    assert.doesNotMatch(result.message, /nenhuma alteração|rollback|registrado com sucesso/i);
  }
});

test('falha de rede é resultado não confirmado e exige releitura sem retry', () => {
  const result = failurePolicy(new Error('network'));
  assert.equal(result.retrySafe, false);
  assert.equal(result.requiresReread, true);
  assert.match(result.message, /confira o vencimento antes de repetir/i);
});

test('4xx pré-transação permanece corrigível e permite nova tentativa', () => {
  for (const status of [400, 401, 403, 404, 409, 422, 429]) {
    const result = failurePolicy({ status });
    assert.equal(result.retrySafe, true);
    assert.equal(result.requiresReread, false);
    assert.match(result.message, /recusada antes do registro/i);
  }
});

test('desfecho ambíguo bloqueia novo PUT, relê lista e mantém fechar acessível', () => {
  const handler = source.match(
    /function _openRegisterPayment\(slot, billing, labels\) \{[\s\S]*?\n {2}\}\n\n {2}function _openEditBilling/,
  );
  assert.ok(handler, '_openRegisterPayment não localizado');
  const code = handler[0];
  assert.match(code, /const failure = _manualPaymentFailurePolicy\(err\)/);
  assert.match(code, /if \(failure\.requiresReread\)[\s\S]*?retryBlocked = true/);
  assert.match(code, /if \(failure\.requiresReread\)[\s\S]*?void renderClientes\(\)/);
  assert.match(code, /cancelBtn\.disabled = false/);
  assert.match(code, /closeBtn\.disabled = false/);
  assert.doesNotMatch(code, /transactionRejected/);
  assert.doesNotMatch(code, /nenhuma alteração foi aplicada/);
});

test('resultado persistente é acessível e responsivo', () => {
  assert.match(source, /id="pa-pay-result"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/);
  assert.match(source, /id="pa-pay-error"[\s\S]*?role="alert"[\s\S]*?aria-live="assertive"/);
  assert.match(source, /\.pa-payment-result__actions \.btn \{ min-height: 44px; \}/);
  assert.match(
    source,
    /@media \(max-width: 480px\)[\s\S]*?\.pa-payment-result__row \{ grid-template-columns: 1fr/,
  );
});
