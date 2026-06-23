// Testes dos helpers PUROS do LIFECYCLE de pacotes no painel (ADR 0025 BLOCO 2c):
//  - validacao de recarga (sessoes 1..1000; validade data XOR dias; datas AAAA-MM-DD)
//  - validacao de mudar-vencimento (EXATAMENTE um: data OU dias)
//  - chave sintetica de idempotencia 'recharge:<creditId>:<key>'
//  - builder do SET de nova validade (data => $N::date; dias => CURRENT_DATE + $N::int)
//
// Uso: node --test painel-admin/test/pacotes-lifecycle.test.js
//
// Estrategia: replica a logica deterministica das rotas /recarregar e PATCH /creditos/:id
// do server.js (sem subir Express + pool), mesmo padrao de pacotes-phone.test.js. As rotas
// que escrevem no ledger (transacao) sao cobertas por unit no @startap/db (packages-lifecycle
// .test.ts) — o painel ESPELHA aquela logica. Se o server.js mudar, ESTES espelhos mudam junto.
import assert from 'node:assert/strict';
import { test } from 'node:test';

// ── Espelho da validacao de RECARGA (server.js POST .../recarregar) ────────────
function validarRecarga(body) {
  const sessoes = Number(body?.sessoes);
  if (!Number.isInteger(sessoes) || sessoes < 1 || sessoes > 1000) return { error: 'sessoes' };
  const hasData =
    body?.data_expiracao !== undefined &&
    body.data_expiracao !== null &&
    body.data_expiracao !== '';
  const hasDias =
    body?.adicionar_dias !== undefined &&
    body.adicionar_dias !== null &&
    body.adicionar_dias !== '';
  if (hasData && hasDias) return { error: 'validade-dupla' };
  if (hasData) {
    const d = String(body.data_expiracao).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { error: 'data' };
    return { value: { sessoes, novaData: d, novaDias: null } };
  }
  if (hasDias) {
    const dias = Number(body.adicionar_dias);
    if (!Number.isInteger(dias) || dias < 1 || dias > 3650) return { error: 'dias' };
    return { value: { sessoes, novaData: null, novaDias: dias } };
  }
  return { value: { sessoes, novaData: null, novaDias: null } };
}

// ── Espelho da validacao de MUDAR VENCIMENTO (server.js PATCH /creditos/:id) ────
function validarVencimento(body) {
  const hasData =
    body?.data_expiracao !== undefined &&
    body.data_expiracao !== null &&
    body.data_expiracao !== '';
  const hasDias =
    body?.adicionar_dias !== undefined &&
    body.adicionar_dias !== null &&
    body.adicionar_dias !== '';
  if (hasData === hasDias) return { error: 'precisa-de-exatamente-um' };
  if (hasData) {
    const d = String(body.data_expiracao).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { error: 'data' };
    return { value: { kind: 'data', d } };
  }
  const dias = Number(body.adicionar_dias);
  if (!Number.isInteger(dias) || dias < 1 || dias > 3650) return { error: 'dias' };
  return { value: { kind: 'dias', dias } };
}

// ── Espelho do builder de SET de nova validade na recarga ──────────────────────
function buildSetValidade(creditId, sessoes, novaData, novaDias) {
  const setVal = ['sessoes_total = sessoes_total + $2'];
  const upParams = [creditId, sessoes];
  if (novaData) {
    upParams.push(novaData);
    setVal.push(`data_expiracao = $${upParams.length}::date`);
  } else if (novaDias != null) {
    upParams.push(novaDias);
    setVal.push(`data_expiracao = CURRENT_DATE + ($${upParams.length}::int)`);
  }
  return { sql: setVal.join(', '), params: upParams };
}

const syntheticEventId = (creditId, key) => `recharge:${creditId}:${key}`;

// ─────────────────────────────────────────────────────────────────────────────
test('recarga: sessoes fora da faixa = erro', () => {
  for (const s of [0, -1, 1001, 1.5, 'x']) {
    assert.equal(validarRecarga({ sessoes: s }).error, 'sessoes');
  }
});

test('recarga: caminho feliz sem validade (mantem a atual)', () => {
  const v = validarRecarga({ sessoes: 5 });
  assert.deepEqual(v.value, { sessoes: 5, novaData: null, novaDias: null });
});

test('recarga: data E dias juntos = erro validade-dupla', () => {
  assert.equal(
    validarRecarga({ sessoes: 5, data_expiracao: '2027-01-01', adicionar_dias: 30 }).error,
    'validade-dupla',
  );
});

test('recarga: data fixa valida', () => {
  assert.deepEqual(validarRecarga({ sessoes: 4, data_expiracao: '2027-12-31' }).value, {
    sessoes: 4,
    novaData: '2027-12-31',
    novaDias: null,
  });
});

test('recarga: data malformada = erro', () => {
  assert.equal(validarRecarga({ sessoes: 4, data_expiracao: '31/12/2027' }).error, 'data');
});

test('recarga: dias na faixa', () => {
  assert.deepEqual(validarRecarga({ sessoes: 4, adicionar_dias: 60 }).value, {
    sessoes: 4,
    novaData: null,
    novaDias: 60,
  });
});

test('vencimento: nenhum dos dois OU os dois = erro', () => {
  assert.equal(validarVencimento({}).error, 'precisa-de-exatamente-um');
  assert.equal(
    validarVencimento({ data_expiracao: '2027-01-01', adicionar_dias: 30 }).error,
    'precisa-de-exatamente-um',
  );
});

test('vencimento: data fixa OK; dias OK', () => {
  assert.deepEqual(validarVencimento({ data_expiracao: '2028-01-01' }).value, {
    kind: 'data',
    d: '2028-01-01',
  });
  assert.deepEqual(validarVencimento({ adicionar_dias: 45 }).value, { kind: 'dias', dias: 45 });
});

test('chave sintetica de idempotencia: recharge:<creditId>:<key>', () => {
  assert.equal(syntheticEventId(7, 'abc-123'), 'recharge:7:abc-123');
});

test('SET builder: data => $N::date no placeholder certo', () => {
  const { sql, params } = buildSetValidade(1, 5, '2027-12-31', null);
  assert.match(sql, /sessoes_total = sessoes_total \+ \$2/);
  assert.match(sql, /data_expiracao = \$3::date/);
  assert.deepEqual(params, [1, 5, '2027-12-31']);
});

test('SET builder: dias => CURRENT_DATE + $N::int', () => {
  const { sql, params } = buildSetValidade(1, 3, null, 90);
  assert.match(sql, /data_expiracao = CURRENT_DATE \+ \(\$3::int\)/);
  assert.deepEqual(params, [1, 3, 90]);
});

test('SET builder: sem validade => so cresce sessoes_total', () => {
  const { sql, params } = buildSetValidade(2, 4, null, null);
  assert.equal(sql, 'sessoes_total = sessoes_total + $2');
  assert.deepEqual(params, [2, 4]);
});
