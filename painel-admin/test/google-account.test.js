// Testes da Conta Google do cliente (login do Google Agenda) no painel de gestão.
// Uso: node --test painel-admin/test/google-account.test.js
//
// Cobre:
//   - round-trip da SENHA com o MESMO AES-256-GCM (formato enc:v2:) usado pro gcal:
//     encrypt → string opaca → decrypt devolve o claro. (a senha NUNCA fica em claro
//     na coluna; o GET decifra server-side só pro operador.)
//   - os gates de validação do PUT /api/clones/:id/google-account (email/password
//     obrigatórios, formato de e-mail, id inválido).
//   - a garantia de que a senha em claro NÃO aparece no ciphertext gravado.
//
// Estratégia: replica SÓ os helpers de decisão/cripto do server.js (sem subir
// Express + pool Postgres), espelhando colaborador-gcal-test.test.js. Sem hit em DB.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

// ── Cripto AES-256-GCM enc:v2: — espelho 1:1 do server.js (encryptGcalCredentials/
//    decryptGcalCredentials). Usa uma chave de teste, não a de produção. ─────────
const PREFIX_V2 = 'enc:v2:';
const KEY = crypto.randomBytes(32); // chave de teste local (32 bytes)

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${PREFIX_V2}${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decrypt(stored) {
  if (!stored.startsWith(PREFIX_V2)) return stored; // claro legado
  const parts = stored.slice(PREFIX_V2.length).split(':');
  assert.equal(parts.length, 3, 'formato enc:v2 deve ter 3 partes');
  const [ivB64, authTagB64, ctB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64'), {
    authTagLength: 16,
  });
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

// ── Gates do PUT /api/clones/:id/google-account (réplica pura da validação) ─────
//   Retorna { status, error } (HTTP) ou { ok: true } quando passa para o UPDATE.
function gatesPutGoogleAccount({ id, email, password }) {
  if (!Number.isFinite(id)) return { status: 400, error: 'id inválido' };
  if (!email || typeof email !== 'string' || email.trim() === '') {
    return { status: 400, error: 'email obrigatório' };
  }
  if (!password || typeof password !== 'string' || password === '') {
    return { status: 400, error: 'password obrigatório' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return { status: 400, error: 'email inválido' };
  }
  return { ok: true };
}

// ── round-trip da senha ────────────────────────────────────────────────────────

test('senha cifrada faz round-trip encrypt → decrypt (caminho feliz)', () => {
  const senha = 'S3nh@-do-cliente!2026';
  const stored = encrypt(senha);
  assert.ok(stored.startsWith(PREFIX_V2), 'deve gravar no formato enc:v2:');
  assert.equal(decrypt(stored), senha);
});

test('a senha em claro NÃO aparece no ciphertext gravado', () => {
  const senha = 'minhasenhasecreta';
  const stored = encrypt(senha);
  assert.ok(!stored.includes(senha), 'ciphertext não pode conter a senha em claro');
});

test('cada gravação usa IV novo (ciphertext difere para a mesma senha)', () => {
  const senha = 'repetida';
  assert.notEqual(encrypt(senha), encrypt(senha));
});

test('senha com unicode/emoji sobrevive ao round-trip', () => {
  const senha = 'çãõ-🔐-pão';
  assert.equal(decrypt(encrypt(senha)), senha);
});

test('authTag adulterado faz a decifragem falhar (integridade)', () => {
  const stored = encrypt('abc');
  const parts = stored.slice(PREFIX_V2.length).split(':');
  const tag = Buffer.from(parts[1], 'base64');
  tag[0] ^= 0xff; // corrompe 1 byte do authTag
  parts[1] = tag.toString('base64');
  const corrupted = `${PREFIX_V2}${parts.join(':')}`;
  assert.throws(() => decrypt(corrupted));
});

// ── gates de validação do PUT ──────────────────────────────────────────────────

test('id inválido rejeita com 400', () => {
  const r = gatesPutGoogleAccount({ id: Number('abc'), email: 'a@b.com', password: 'x' });
  assert.equal(r.status, 400);
  assert.equal(r.error, 'id inválido');
});

test('email ausente rejeita com 400', () => {
  const r = gatesPutGoogleAccount({ id: 1, email: '', password: 'x' });
  assert.equal(r.status, 400);
  assert.equal(r.error, 'email obrigatório');
});

test('password ausente rejeita com 400', () => {
  const r = gatesPutGoogleAccount({ id: 1, email: 'a@b.com', password: '' });
  assert.equal(r.status, 400);
  assert.equal(r.error, 'password obrigatório');
});

test('email malformado rejeita com 400', () => {
  const r = gatesPutGoogleAccount({ id: 1, email: 'nao-eh-email', password: 'x' });
  assert.equal(r.status, 400);
  assert.equal(r.error, 'email inválido');
});

test('email + password válidos passam para o UPDATE', () => {
  const r = gatesPutGoogleAccount({
    id: 42,
    email: ' agenda.cliente@gmail.com ',
    password: 'senha123',
  });
  assert.equal(r.ok, true);
});
