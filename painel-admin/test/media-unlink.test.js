// Testes do fix de vazamento de disco em uploads (fix/painel-admin-uploads-disk-leak).
// Uso: node --test painel-admin/test/media-unlink.test.js
//
// Estrategia (igual a models.test.js): replica a logica PURA de server.js aqui
// — "espelha a logica em server.js, manter em sync" — e exercita o FS real em
// diretorio temporario. Sem boot do Express/Postgres.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Copias fieis dos helpers de server.js ────────────────────────────────────
// resolveLocalMediaPath: so retorna path absoluto se a url for upload local
// nosso e estiver contida em storageDir (anti path-traversal).
function resolveLocalMediaPath(url, storageDir, publicBase) {
  if (!url || typeof url !== 'string') return null;
  if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(url)) return null; // url externa
  const prefix = `${publicBase}/`;
  if (!url.startsWith(prefix)) return null;
  let filename;
  try {
    filename = decodeURIComponent(url.slice(prefix.length));
  } catch {
    return null;
  }
  if (!filename) return null;
  if (filename.includes('/') || filename.includes('\\') || filename.includes('\0')) return null;
  const baseAbs = path.resolve(storageDir);
  const candidate = path.resolve(baseAbs, filename);
  const rel = path.relative(baseAbs, candidate);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return candidate;
}

// unlinkLocalMedia: idempotente; ENOENT = sucesso; url externa/fora = skipped.
async function unlinkLocalMedia(url, storageDir, publicBase) {
  const abs = resolveLocalMediaPath(url, storageDir, publicBase);
  if (!abs) return 'skipped';
  try {
    await fs.promises.unlink(abs);
    return 'deleted';
  } catch (e) {
    if (e && e.code === 'ENOENT') return 'missing';
    return 'error';
  }
}

function computeOrphans(filesOnDisk, referenced) {
  return filesOnDisk.filter((name) => !referenced.has(name));
}

// ── Fixture: diretorio temporario de uploads ─────────────────────────────────
const PUBLIC_BASE = '/uploads';
let TMP;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-test-'));
});
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function writeFixture(name, content = 'x') {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, content);
  return p;
}

// ── resolveLocalMediaPath ────────────────────────────────────────────────────
test('resolveLocalMediaPath — url local nossa resolve dentro do storage', () => {
  const abs = resolveLocalMediaPath('/uploads/1700000000-abc.png', TMP, PUBLIC_BASE);
  assert.equal(abs, path.join(TMP, '1700000000-abc.png'));
});

test('resolveLocalMediaPath — url externa http/https retorna null (nao apaga)', () => {
  assert.equal(resolveLocalMediaPath('https://cdn.exemplo.com/foto.png', TMP, PUBLIC_BASE), null);
  assert.equal(resolveLocalMediaPath('http://waha:3000/api/files/x.jpg', TMP, PUBLIC_BASE), null);
  assert.equal(resolveLocalMediaPath('//host/x.png', TMP, PUBLIC_BASE), null);
});

test('resolveLocalMediaPath — prefixo diferente retorna null', () => {
  assert.equal(resolveLocalMediaPath('/static/x.png', TMP, PUBLIC_BASE), null);
  assert.equal(resolveLocalMediaPath('x.png', TMP, PUBLIC_BASE), null);
});

test('resolveLocalMediaPath — path-traversal eh bloqueado', () => {
  // separador explicito no nome
  assert.equal(resolveLocalMediaPath('/uploads/../server.js', TMP, PUBLIC_BASE), null);
  // traversal encodado (decodeURIComponent revela a barra)
  assert.equal(resolveLocalMediaPath('/uploads/..%2F..%2Fetc%2Fpasswd', TMP, PUBLIC_BASE), null);
  assert.equal(resolveLocalMediaPath('/uploads/sub%2Ffile.png', TMP, PUBLIC_BASE), null);
  // backslash (windows-style)
  assert.equal(resolveLocalMediaPath('/uploads/..\\secret', TMP, PUBLIC_BASE), null);
});

test('resolveLocalMediaPath — entradas invalidas retornam null', () => {
  assert.equal(resolveLocalMediaPath(null, TMP, PUBLIC_BASE), null);
  assert.equal(resolveLocalMediaPath('', TMP, PUBLIC_BASE), null);
  assert.equal(resolveLocalMediaPath('/uploads/', TMP, PUBLIC_BASE), null);
  assert.equal(resolveLocalMediaPath(123, TMP, PUBLIC_BASE), null);
});

// ── unlinkLocalMedia (FS real) ───────────────────────────────────────────────
test('unlinkLocalMedia — apaga o arquivo fisico de um upload local', async () => {
  const name = 'del-me.png';
  const p = writeFixture(name);
  assert.ok(fs.existsSync(p), 'fixture deve existir antes');
  const r = await unlinkLocalMedia(`/uploads/${name}`, TMP, PUBLIC_BASE);
  assert.equal(r, 'deleted');
  assert.equal(fs.existsSync(p), false, 'arquivo deve ter sido removido');
});

test('unlinkLocalMedia — arquivo ja inexistente nao quebra (idempotente)', async () => {
  const r = await unlinkLocalMedia('/uploads/nunca-existiu.png', TMP, PUBLIC_BASE);
  assert.equal(r, 'missing');
});

test('unlinkLocalMedia — url externa nao tenta apagar nada (skipped)', async () => {
  const r = await unlinkLocalMedia('https://cdn.exemplo.com/x.png', TMP, PUBLIC_BASE);
  assert.equal(r, 'skipped');
});

test('unlinkLocalMedia — path-traversal nao apaga fora do storage', async () => {
  // cria um arquivo "sensivel" FORA do storage e garante que ele sobrevive
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  const sensitive = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(sensitive, 'nao apague');
  try {
    // qualquer tentativa de escapar deve ser skipped (resolve para null)
    const r = await unlinkLocalMedia('/uploads/..%2F..%2Fsecret.txt', TMP, PUBLIC_BASE);
    assert.equal(r, 'skipped');
    assert.ok(fs.existsSync(sensitive), 'arquivo fora do storage NAO pode ser apagado');
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

// ── computeOrphans + GC dry-run ──────────────────────────────────────────────
test('computeOrphans — retorna so arquivos nao referenciados', () => {
  const onDisk = ['a.png', 'b.png', 'c.png'];
  const referenced = new Set(['b.png']);
  assert.deepEqual(computeOrphans(onDisk, referenced).sort(), ['a.png', 'c.png']);
});

test('computeOrphans — nada orfao quando tudo referenciado', () => {
  const onDisk = ['a.png', 'b.png'];
  const referenced = new Set(['a.png', 'b.png']);
  assert.deepEqual(computeOrphans(onDisk, referenced), []);
});

test('GC dry-run — lista orfaos mas NAO apaga sem confirm', async () => {
  // monta um storage com 2 arquivos; so 1 esta "referenciado"
  const gcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-'));
  try {
    fs.writeFileSync(path.join(gcDir, 'ref.png'), 'r');
    fs.writeFileSync(path.join(gcDir, 'orfao.png'), 'o');
    const referenced = new Set(['ref.png']);

    // replica o nucleo da rota: dry-run (confirm=false) NAO apaga.
    const confirm = false;
    const filesOnDisk = fs
      .readdirSync(gcDir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
    const orphans = computeOrphans(filesOnDisk, referenced);

    let deleted = 0;
    if (confirm) {
      for (const n of orphans) {
        fs.unlinkSync(path.join(gcDir, n));
        deleted++;
      }
    }

    assert.deepEqual(orphans, ['orfao.png']);
    assert.equal(deleted, 0, 'dry-run nao deve apagar');
    assert.ok(fs.existsSync(path.join(gcDir, 'orfao.png')), 'orfao deve continuar no disco em dry-run');
    assert.ok(fs.existsSync(path.join(gcDir, 'ref.png')), 'referenciado nunca eh apagado');
  } finally {
    fs.rmSync(gcDir, { recursive: true, force: true });
  }
});

test('GC confirm=true — apaga orfao mas preserva referenciado', async () => {
  const gcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-'));
  try {
    fs.writeFileSync(path.join(gcDir, 'ref.png'), 'r');
    fs.writeFileSync(path.join(gcDir, 'orfao.png'), 'o');
    const referenced = new Set(['ref.png']);
    const filesOnDisk = fs
      .readdirSync(gcDir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
    const orphans = computeOrphans(filesOnDisk, referenced);

    let deleted = 0;
    for (const n of orphans) {
      fs.unlinkSync(path.join(gcDir, n));
      deleted++;
    }

    assert.equal(deleted, 1);
    assert.equal(fs.existsSync(path.join(gcDir, 'orfao.png')), false, 'orfao apagado');
    assert.ok(fs.existsSync(path.join(gcDir, 'ref.png')), 'referenciado preservado');
  } finally {
    fs.rmSync(gcDir, { recursive: true, force: true });
  }
});
