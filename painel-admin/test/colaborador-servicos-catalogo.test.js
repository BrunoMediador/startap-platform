// Testes da validação de SERVIÇO contra o CATÁLOGO do clone no vínculo
// serviço↔colaborador (estabelecimento). Uso:
//   node --test painel-admin/test/colaborador-servicos-catalogo.test.js
//
// Cobre o fix das rotas POST/PATCH /api/clones/:id/colaboradores[/:colabId]:
//   ao salvar os serviços de um colaborador, todo nome TEM que existir no catálogo
//   do clone (flow_clones.servicos = [{nome,...}]), comparando por nome com
//   case/trim tolerado. Antes, um free-text ("cirurgia") entrava direto no banco.
//
// Estratégia (espelha colaborador-patch-gcal-status.test.js): replica a decisão
// PURA — chave de comparação + busca no Set do catálogo — sem subir Express+pool.
// As funções abaixo são CÓPIA fiel de _pkgServicoKey / _pkgServicosForaDoCatalogo
// do server.js (a parte que depende do banco é só montar o Set do catálogo).
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Cópia fiel de _pkgServicoKey (server.js): trim + lowercase.
function servicoKey(s) {
  return String(s ?? '').trim().toLowerCase();
}

// Cópia fiel da decisão de _pkgGetCatalogoKeys: monta o Set de chaves a partir de
// flow_clones.servicos (array de { nome } ou strings).
function catalogoKeys(servicosCatalogo) {
  const keys = new Set();
  if (!Array.isArray(servicosCatalogo)) return keys;
  for (const item of servicosCatalogo) {
    const nome = item && typeof item === 'object' ? item.nome : item;
    const key = servicoKey(nome);
    if (key) keys.add(key);
  }
  return keys;
}

// Cópia fiel da decisão de _pkgServicosForaDoCatalogo: 1º serviço fora do catálogo,
// ou null se todos existem (lista vazia -> null = fallback p/ todos).
function primeiroForaDoCatalogo(servicosVinculados, servicosCatalogo) {
  if (!Array.isArray(servicosVinculados) || servicosVinculados.length === 0) return null;
  const catalogo = catalogoKeys(servicosCatalogo);
  for (const s of servicosVinculados) {
    if (!catalogo.has(servicoKey(s))) return s;
  }
  return null;
}

const CATALOGO = [
  { nome: 'Corte', preco_cents: 4000, duracao_min: 30 },
  { nome: 'Barba', preco_cents: 2500, duracao_min: 20 },
];

// ── serviço EXISTENTE: passa ──────────────────────────────────────────────────

test('serviço que existe no catálogo → aceito (null)', () => {
  assert.equal(primeiroForaDoCatalogo(['Corte'], CATALOGO), null);
});

test('case/trim tolerado: "  corte " casa com "Corte"', () => {
  assert.equal(primeiroForaDoCatalogo(['  corte '], CATALOGO), null);
  assert.equal(primeiroForaDoCatalogo(['BARBA'], CATALOGO), null);
});

test('vários serviços, todos existentes → aceito', () => {
  assert.equal(primeiroForaDoCatalogo(['Corte', 'Barba'], CATALOGO), null);
});

// ── serviço INEXISTENTE: rejeita (o bug do Bruno) ─────────────────────────────

test('"cirurgia" (fora do catálogo) → rejeitado, devolve o nome', () => {
  assert.equal(primeiroForaDoCatalogo(['cirurgia'], CATALOGO), 'cirurgia');
});

test('mistura válido + inválido → rejeita no inválido', () => {
  assert.equal(primeiroForaDoCatalogo(['Corte', 'cirurgia'], CATALOGO), 'cirurgia');
});

test('catálogo vazio + serviço qualquer → rejeitado', () => {
  assert.equal(primeiroForaDoCatalogo(['Corte'], []), 'Corte');
});

// ── lista vazia: fallback p/ todos (comportamento legítimo, não bloquear) ──────

test('colaborador SEM serviços (lista vazia) → null (fallback p/ todos)', () => {
  assert.equal(primeiroForaDoCatalogo([], CATALOGO), null);
});

test('servicos não-array → null (nada a validar)', () => {
  assert.equal(primeiroForaDoCatalogo(undefined, CATALOGO), null);
});

// ── catálogo em formato string (defensivo) ────────────────────────────────────

test('catálogo com itens string também casa', () => {
  assert.equal(primeiroForaDoCatalogo(['corte'], ['Corte', 'Barba']), null);
  assert.equal(primeiroForaDoCatalogo(['cirurgia'], ['Corte', 'Barba']), 'cirurgia');
});
