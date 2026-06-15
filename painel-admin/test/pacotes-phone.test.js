// Testes dos helpers PUROS do CRUD de pacotes (Bloco 3, frontend-engineer):
//  - _pkgCanonicalE164 / _pkgPhoneHint / _pkgPhoneHmac  (espelho de packages/core)
//  - _pkgNormalizeServicos
//  - _validatePacoteTemplate (validade dias XOR data fixa, etc.)
//
// Uso: node --test painel-admin/test/pacotes-phone.test.js
//
// Estrategia: replica os helpers do server.js (sem subir Express + pool), mesmo
// padrao de servicos-duracao-multiplo5.test.js / media-unlink.test.js. Se o server.js
// mudar a logica, ESTES helpers precisam mudar junto (sao espelho — manter em sync).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

// ── Espelho de server.js ──────────────────────────────────────────────────────
function _pkgCanonicalE164(raw) {
  if (!raw) return null;
  const base = String(raw).split('@')[0]?.split(':')[0] ?? '';
  let digits = base.replace(/\D/g, '').replace(/^0+/, '');
  if (digits.length < 10 || digits.length > 15) return null;
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  if (digits.startsWith('55')) {
    if (digits.length === 13 && digits[4] === '9') return digits.slice(0, 4) + digits.slice(5);
    if (digits.length === 12) return digits;
    if (digits.length === 13) return digits;
    return null;
  }
  return digits;
}
function _pkgPhoneHint(canonical) {
  const digits = String(canonical).replace(/\D/g, '');
  const last2 = digits.slice(-2);
  if (digits.startsWith('55') && digits.length >= 12) {
    const ddd = digits.slice(2, 4);
    return `+55 ${ddd} •••••-••${last2}`;
  }
  return `+${digits.slice(0, 2)} •••••-••${last2}`;
}
function _pkgPhoneHmac(canonicalPhone, pepper) {
  return crypto.createHmac('sha256', pepper).update(canonicalPhone, 'utf8').digest('hex');
}
function _pkgNormalizeServicos(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const s = String(raw ?? '').trim().slice(0, 80);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 50) break;
  }
  return out;
}
function _validatePacoteTemplate(b, { partial = false } = {}) {
  const out = {};
  const need = (k) => !partial || b[k] !== undefined;
  if (need('nome')) {
    const nome = String(b?.nome ?? '').trim().slice(0, 160);
    if (!nome) return { error: 'nome do pacote obrigatorio' };
    out.nome = nome;
  }
  if (need('total_sessoes')) {
    const tot = Number(b?.total_sessoes);
    if (!Number.isInteger(tot) || tot < 1 || tot > 1000) return { error: 'total de sessoes deve ser inteiro entre 1 e 1000' };
    out.total_sessoes = tot;
  }
  const hasDias = b?.validade_dias !== undefined && b.validade_dias !== null && b.validade_dias !== '';
  const hasData = b?.data_validade_fixa !== undefined && b.data_validade_fixa !== null && b.data_validade_fixa !== '';
  if (hasDias && hasData) return { error: 'use validade em DIAS ou DATA FIXA, nao os dois' };
  if (hasDias) {
    const dias = Number(b.validade_dias);
    if (!Number.isInteger(dias) || dias < 1 || dias > 3650) return { error: 'validade em dias deve ser inteiro entre 1 e 3650' };
    out.validade_dias = dias; out.data_validade_fixa = null;
  } else if (hasData) {
    const d = String(b.data_validade_fixa).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { error: 'data de validade deve ser AAAA-MM-DD' };
    out.data_validade_fixa = d; out.validade_dias = null;
  } else if (!partial) {
    return { error: 'informe a validade: dias OU data fixa' };
  }
  return { value: out };
}

// ── canonicalE164 ─────────────────────────────────────────────────────────────
test('canonicalE164: mascara BR com 9 vira 12 digitos sem o 9 (identidade estavel)', () => {
  assert.equal(_pkgCanonicalE164('(31) 99999-8842'), '553199998842');
});
test('canonicalE164: me.id do WAHA (sufixo :device@dominio) e limpo', () => {
  assert.equal(_pkgCanonicalE164('5531999998842:12@s.whatsapp.net'), '553199998842');
});
test('canonicalE164: numero ja sem o 9 (12 digitos) fica igual', () => {
  assert.equal(_pkgCanonicalE164('553199998842'), '553199998842');
});
test('canonicalE164: com e sem o 9 colapsam na MESMA identidade', () => {
  assert.equal(_pkgCanonicalE164('5531999998842'), _pkgCanonicalE164('553199998842'));
});
test('canonicalE164: lixo curto demais retorna null', () => {
  assert.equal(_pkgCanonicalE164('123'), null);
  assert.equal(_pkgCanonicalE164(''), null);
  assert.equal(_pkgCanonicalE164(null), null);
});

// ── phoneHint (LGPD) ──────────────────────────────────────────────────────────
test('phoneHint: mascara mantendo so DDD + 2 ultimos digitos', () => {
  assert.equal(_pkgPhoneHint('553199998842'), '+55 31 •••••-••42');
});
test('phoneHint: nunca expoe o numero do meio', () => {
  const hint = _pkgPhoneHint('553199998842');
  assert.ok(!hint.includes('9999'), 'hint nao pode conter o miolo do numero');
});

// ── HMAC ──────────────────────────────────────────────────────────────────────
test('packagePhoneHmac: deterministico (mesmo numero+pepper => mesmo hash)', () => {
  const p = 'pepper-de-teste-1234567890';
  assert.equal(_pkgPhoneHmac('553199998842', p), _pkgPhoneHmac('553199998842', p));
});
test('packagePhoneHmac: pepper diferente => hash diferente (isolamento cross-tabela)', () => {
  assert.notEqual(
    _pkgPhoneHmac('553199998842', 'pepper-pacotes-aaaaaaaaaa'),
    _pkgPhoneHmac('553199998842', 'pepper-trial-bbbbbbbbbbbb'),
  );
});
test('packagePhoneHmac: nunca contem o numero cru', () => {
  const h = _pkgPhoneHmac('553199998842', 'pepper-de-teste-1234567890');
  assert.ok(!h.includes('99998842'));
});

// ── normalizeServicos ─────────────────────────────────────────────────────────
test('normalizeServicos: trim, remove vazios e deduplica case-insensitive', () => {
  assert.deepEqual(_pkgNormalizeServicos([' Corte ', 'corte', '', 'Barba', null]), ['Corte', 'Barba']);
});
test('normalizeServicos: nao-array => []', () => {
  assert.deepEqual(_pkgNormalizeServicos('Corte'), []);
  assert.deepEqual(_pkgNormalizeServicos(undefined), []);
});

// ── validatePacoteTemplate ────────────────────────────────────────────────────
test('template: exige nome, sessoes e validade no create', () => {
  assert.match(_validatePacoteTemplate({}).error, /nome/);
  assert.match(_validatePacoteTemplate({ nome: 'X' }).error, /sessoes/);
  assert.match(_validatePacoteTemplate({ nome: 'X', total_sessoes: 5 }).error, /validade/);
});
test('template: validade em dias XOR data fixa (os dois juntos = erro)', () => {
  const r = _validatePacoteTemplate({ nome: 'X', total_sessoes: 5, validade_dias: 30, data_validade_fixa: '2026-12-31' });
  assert.match(r.error, /nao os dois/);
});
test('template: create valido com dias', () => {
  const r = _validatePacoteTemplate({ nome: 'Combo', total_sessoes: 5, validade_dias: 90 });
  assert.equal(r.error, undefined);
  assert.equal(r.value.validade_dias, 90);
  assert.equal(r.value.data_validade_fixa, null);
});
test('template: create valido com data fixa (AAAA-MM-DD)', () => {
  const r = _validatePacoteTemplate({ nome: 'Promo', total_sessoes: 10, data_validade_fixa: '2026-12-31' });
  assert.equal(r.error, undefined);
  assert.equal(r.value.data_validade_fixa, '2026-12-31');
});
test('template: data fixa em formato errado e rejeitada', () => {
  assert.match(_validatePacoteTemplate({ nome: 'P', total_sessoes: 5, data_validade_fixa: '31/12/2026' }).error, /AAAA-MM-DD/);
});
test('template: total de sessoes fora da faixa e rejeitado', () => {
  assert.match(_validatePacoteTemplate({ nome: 'P', total_sessoes: 0, validade_dias: 30 }).error, /sessoes/);
  assert.match(_validatePacoteTemplate({ nome: 'P', total_sessoes: 1001, validade_dias: 30 }).error, /sessoes/);
});
test('template: patch parcial nao exige validade (so valida o que veio)', () => {
  const r = _validatePacoteTemplate({ nome: 'Novo nome' }, { partial: true });
  assert.equal(r.error, undefined);
  assert.equal(r.value.nome, 'Novo nome');
});
