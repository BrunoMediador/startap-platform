// Testes do aviso de UI "validar a agenda LIGOU o modo agenda" (aba Google Calendar do
// gestão, helper `_renderGcalTab` em public/index.html).
// Uso: node --test painel-admin/test/gcal-test-aviso-agenda-ui.test.js
//
// ⚠️ NÃO rodam no CI (vitest.config.ts exclui painel-admin/test/** — SCRUM-50).
//    Rode à mão: `node --test painel-admin/test/*.test.js`.
//
// CONTEXTO: o backend (PR #491) passou a devolver `agendaAtivada: true` no
// POST /api/clones/:id/gcal/test quando a validação da agenda PROMOVE o clone de modo
// atendente pra modo agenda. O campo é OMITIDO quando não houve promoção.
//
// ARMADILHA QUE ESTES TESTES GUARDAM: `_renderGcalTab` é COMPARTILHADO com a tela de MATRIZ
// (baseUrl `/api/bots/<slot>`), e a rota da matriz NÃO devolve o campo. Uma checagem por
// truthiness/presença (`result.agendaAtivada`, `'agendaAtivada' in result`) continuaria
// passando nos casos felizes, mas afrouxaria a garantia — por isso o teste EXTRAI a
// expressão real do index.html e a AVALIA contra as respostas possíveis das duas rotas.
// Nada aqui é replicado à mão: mexer no guard sem manter a semântica deixa o teste vermelho.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const INDEX = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

// ── Extração do código real ──────────────────────────────────────────────────

/** Corpo de uma função nomeada do index.html, casando chaves até o fechamento. */
function functionSource(decl) {
  const start = INDEX.indexOf(decl);
  assert.ok(start > -1, `função não encontrada em public/index.html: ${decl}`);
  const bodyStart = INDEX.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}') {
      depth--;
      if (depth === 0) return INDEX.slice(start, i + 1);
    }
  }
  throw new Error(`chaves de ${decl} não fecham`);
}

const RUN_TEST = functionSource('async function runTest() {');
const AVISO = functionSource('function _renderAgendaAtivadaAviso() {');

/** A expressão do guard, como está escrita no arquivo. */
function guardExpression() {
  const m = RUN_TEST.match(/const promoveuAgenda\s*=\s*([^;]+);/);
  assert.ok(m, 'runTest deveria decidir o aviso numa const `promoveuAgenda`');
  return m[1].trim();
}

/** Avalia o guard extraído contra uma resposta de API simulada. */
function evalGuard(result) {
  // `new Function` é proposital: o objetivo é avaliar o código REAL extraído do index.html
  // (não uma cópia). A entrada vem do próprio arquivo do repo, não de rede/usuário.
  const fn = new Function('result', `return (${guardExpression()});`);
  return fn(result);
}

// ── O guard ──────────────────────────────────────────────────────────────────

test('resposta da MATRIZ (sem o campo) NÃO mostra o aviso', () => {
  // GET/POST /api/bots/<slot>/gcal/test — rota que não conhece `agendaAtivada`.
  assert.equal(evalGuard({ ok: true, gcal_client_email: 'sa@x.iam.gserviceaccount.com' }), false);
});

test('clone testado SEM promoção (campo omitido) NÃO mostra o aviso', () => {
  // O backend omite a chave (`undefined` some do JSON) quando não houve flip.
  assert.equal(evalGuard({ ok: true }), false);
  assert.equal(evalGuard({ ok: true, agendaAtivada: undefined }), false);
});

test('clone PROMOVIDO pra modo agenda mostra o aviso', () => {
  assert.equal(evalGuard({ ok: true, agendaAtivada: true }), true);
});

test('guard é estrito — valores truthy que não são `true` não disparam o aviso', () => {
  // Blinda contra `if (result.agendaAtivada)`: um payload alterado no futuro
  // (string, objeto, 1) não pode anunciar mudança de modo que não houve.
  for (const v of ['true', 'false', 1, {}, [], 'sim']) {
    assert.equal(
      evalGuard({ ok: true, agendaAtivada: v }),
      false,
      `agendaAtivada=${JSON.stringify(v)} não deveria disparar`,
    );
  }
  assert.equal(evalGuard({ ok: true, agendaAtivada: false }), false);
});

// ── O ramo sem promoção não regride (matriz byte-idêntica) ───────────────────

test('sem promoção, o caminho antigo é preservado (toast original + loadTab)', () => {
  const semFlip = RUN_TEST.slice(
    RUN_TEST.indexOf('if (!promoveuAgenda)'),
    RUN_TEST.indexOf('} else {'),
  );
  assert.match(semFlip, /toast\('Conexão com Google Calendar OK!', 'success'\)/);
  assert.match(semFlip, /loadTab\(\)/);
  assert.ok(
    !semFlip.includes('_renderAgendaAtivadaAviso'),
    'o aviso não pode ser renderizado no ramo sem promoção',
  );
});

// ── O ramo com promoção ──────────────────────────────────────────────────────

test('o aviso é renderizado uma única vez, e só no ramo da promoção', () => {
  const chamadas = [...RUN_TEST.matchAll(/_renderAgendaAtivadaAviso\(\)/g)];
  assert.equal(chamadas.length, 1, 'o aviso deve ser renderizado em um único ponto de runTest');
  const comFlip = RUN_TEST.slice(RUN_TEST.indexOf('} else {'));
  assert.ok(
    comFlip.includes('_renderAgendaAtivadaAviso()'),
    'a chamada deve estar no ramo `promoveuAgenda`',
  );
});

test('o aviso é anexado DEPOIS do re-render da aba (await loadTab), sem setTimeout', () => {
  const comFlip = RUN_TEST.slice(RUN_TEST.indexOf('} else {'));
  const awaitAt = comFlip.indexOf('await loadTab()');
  const avisoAt = comFlip.indexOf('_renderAgendaAtivadaAviso()');
  assert.ok(
    awaitAt > -1,
    'o re-render precisa ser aguardado, senão o aviso é apagado pelo loadTab',
  );
  assert.ok(awaitAt < avisoAt, 'o aviso deve ser anexado depois do await loadTab()');
});

// ── Conteúdo e acessibilidade do bloco ───────────────────────────────────────

test('o bloco tem id estável e não duplica em testes seguidos', () => {
  assert.match(AVISO, /id = 'gcal-agenda-ativada'/);
  assert.match(
    AVISO,
    /querySelector\('#gcal-agenda-ativada'\)/,
    'deve remover a instância anterior antes de anexar',
  );
});

test('o bloco é anunciado por leitor de tela (role=status)', () => {
  assert.match(AVISO, /setAttribute\('role', 'status'\)/);
});

test('a copy nomeia a MUDANÇA de modo, não só "ok"', () => {
  assert.match(AVISO, /modo atendente/i, 'precisa dizer de onde o cliente saiu');
  assert.match(AVISO, /marca horário sozinho/i, 'precisa dizer o que passou a acontecer');
  assert.match(AVISO, /agenda_automatica=true/, 'campo gravado, pro operador conferir');
  assert.match(AVISO, /modo_atendente_enabled=false/);
});

test('o ícone usado existe no dicionário ICONS (fallback é SVG vazio e silencioso)', () => {
  const usados = [...AVISO.matchAll(/icon\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(usados.length > 0, 'o bloco usa ao menos um ícone');
  for (const nome of usados) {
    assert.match(INDEX, new RegExp(`'${nome}':\\s*'<`), `ícone '${nome}' não existe em ICONS`);
  }
});
