// Testes dos avisos de UI do teste de Google Calendar do gestão (helper `_renderGcalTab`
// em public/index.html), pós-validação da agenda.
// Uso: node --test painel-admin/test/gcal-test-aviso-agenda-ui.test.js
//
// ⚠️ NÃO rodam no CI (vitest.config.ts exclui painel-admin/test/** — SCRUM-50).
//    Rode à mão: `node --test painel-admin/test/*.test.js`.
//
// CONTEXTO: o backend (PR #491) devolve DOIS campos no POST /api/clones/:id/gcal/test, cada
// um `true` só quando o caso ocorre (a chave some do JSON quando não), MUTUAMENTE EXCLUSIVOS:
//   • `agendaAtivada: true`          → agenda validada E clone promovido pra modo agenda.
//   • `agendaBloqueadaPersona: true` → agenda validada MAS flip barrado (fail-closed) porque
//                                       a persona do clone ainda não tem a mecânica de
//                                       agendamento (cartão + SIM + inserir_agendamento).
//                                       O clone segue em modo atendente.
//
// ARMADILHA QUE ESTES TESTES GUARDAM: `_renderGcalTab` é COMPARTILHADO com a tela de MATRIZ
// (baseUrl `/api/bots/<slot>`), cuja rota NÃO devolve nenhum dos dois campos. Uma checagem por
// truthiness/presença passaria nos casos felizes mas afrouxaria a garantia — por isso o teste
// EXTRAI as expressões reais do index.html e as AVALIA contra as respostas possíveis. Nada
// aqui é replicado à mão: mexer num guard sem manter a semântica deixa o teste vermelho.
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
const AVISO_ATIVADA = functionSource('function _renderAgendaAtivadaAviso() {');
const AVISO_BLOQUEADA = functionSource('function _renderAgendaBloqueadaPersonaAviso() {');

/** A expressão de um guard `const <nome> = ...;`, como está escrita no arquivo. */
function guardExpression(nome) {
  const m = RUN_TEST.match(new RegExp(`const ${nome}\\s*=\\s*([^;]+);`));
  assert.ok(m, `runTest deveria decidir o aviso numa const \`${nome}\``);
  return m[1].trim();
}

/** Avalia um guard extraído contra uma resposta de API simulada. */
function evalGuard(nome, result) {
  // `new Function` é proposital: o objetivo é avaliar o código REAL extraído do index.html
  // (não uma cópia). A entrada vem do próprio arquivo do repo, não de rede/usuário.
  const fn = new Function('result', `return (${guardExpression(nome)});`);
  return fn(result);
}

const promoveu = (r) => evalGuard('promoveuAgenda', r);
const bloqueada = (r) => evalGuard('bloqueadaPersona', r);

// ── Os guards: matriz e caso "nenhum" não disparam nada ──────────────────────

test('resposta da MATRIZ (sem os campos) não dispara nenhum aviso', () => {
  const r = { ok: true, gcal_client_email: 'sa@x.iam.gserviceaccount.com' };
  assert.equal(promoveu(r), false);
  assert.equal(bloqueada(r), false);
});

test('clone testado sem flip e sem bloqueio (campos omitidos) não dispara nada', () => {
  for (const r of [
    { ok: true },
    { ok: true, agendaAtivada: undefined, agendaBloqueadaPersona: undefined },
  ]) {
    assert.equal(promoveu(r), false);
    assert.equal(bloqueada(r), false);
  }
});

// ── Guard do flip (agenda ligada) ────────────────────────────────────────────

test('clone PROMOVIDO pra modo agenda dispara só o aviso de agenda ligada', () => {
  const r = { ok: true, agendaAtivada: true };
  assert.equal(promoveu(r), true);
  assert.equal(bloqueada(r), false);
});

test('guard do flip é estrito — truthy que não é `true` não dispara', () => {
  for (const v of ['true', 'false', 1, {}, [], 'sim']) {
    assert.equal(
      promoveu({ ok: true, agendaAtivada: v }),
      false,
      `agendaAtivada=${JSON.stringify(v)}`,
    );
  }
  assert.equal(promoveu({ ok: true, agendaAtivada: false }), false);
});

// ── Guard do bloqueio por persona (fail-closed) ──────────────────────────────

test('clone BARRADO por persona dispara só o aviso de pendência', () => {
  const r = { ok: true, agendaBloqueadaPersona: true };
  assert.equal(bloqueada(r), true);
  assert.equal(promoveu(r), false);
});

test('guard do bloqueio é estrito — truthy que não é `true` não dispara', () => {
  for (const v of ['true', 'false', 1, {}, [], 'sim']) {
    assert.equal(
      bloqueada({ ok: true, agendaBloqueadaPersona: v }),
      false,
      `agendaBloqueadaPersona=${JSON.stringify(v)}`,
    );
  }
  assert.equal(bloqueada({ ok: true, agendaBloqueadaPersona: false }), false);
});

// ── Mutuamente exclusivos (o backend nunca devolve os dois) ──────────────────

test('os dois casos são mutuamente exclusivos — exatamente um aviso por resposta', () => {
  const respostas = [
    { ok: true },
    { ok: true, agendaAtivada: true },
    { ok: true, agendaBloqueadaPersona: true },
  ];
  for (const r of respostas) {
    const n = (promoveu(r) ? 1 : 0) + (bloqueada(r) ? 1 : 0);
    assert.ok(n <= 1, `mais de um aviso disparou para ${JSON.stringify(r)}`);
  }
});

// ── Ramificação no runTest: ordem, unicidade e caminho antigo preservado ─────

test('cada aviso é renderizado uma única vez em runTest', () => {
  assert.equal([...RUN_TEST.matchAll(/_renderAgendaAtivadaAviso\(\)/g)].length, 1);
  assert.equal([...RUN_TEST.matchAll(/_renderAgendaBloqueadaPersonaAviso\(\)/g)].length, 1);
});

test('o ramo default (sem flip/sem bloqueio) preserva o caminho antigo intacto', () => {
  // Ramo neutro = o `else {` logo depois do ramo de bloqueio, terminando onde o `if
  // (result.ok)` fecha (`} else if (result.errorHint)`). Deve ter o toast original + loadTab
  // e NENHUM dos dois avisos (matriz e clone-sem-caso continuam byte-idênticos ao de hoje).
  const posBloqueio = RUN_TEST.indexOf('_renderAgendaBloqueadaPersonaAviso()');
  const neutroStart = RUN_TEST.indexOf('} else {', posBloqueio);
  const neutro = RUN_TEST.slice(neutroStart, RUN_TEST.indexOf('} else if (result.errorHint)'));
  assert.match(neutro, /toast\('Conexão com Google Calendar OK!', 'success'\)/);
  assert.match(neutro, /loadTab\(\)/);
  assert.ok(
    !neutro.includes('_renderAgendaAtivadaAviso'),
    'ramo neutro não renderiza aviso de flip',
  );
  assert.ok(
    !neutro.includes('_renderAgendaBloqueadaPersonaAviso'),
    'ramo neutro não renderiza aviso de bloqueio',
  );
});

test('cada aviso é anexado DEPOIS do await loadTab() (sem race, sem setTimeout)', () => {
  for (const fn of ['_renderAgendaAtivadaAviso', '_renderAgendaBloqueadaPersonaAviso']) {
    const at = RUN_TEST.indexOf(`${fn}()`);
    const awaitBefore = RUN_TEST.lastIndexOf('await loadTab()', at);
    assert.ok(awaitBefore > -1 && awaitBefore < at, `${fn} deve vir depois de um await loadTab()`);
  }
});

// ── Conteúdo e acessibilidade dos DOIS blocos ────────────────────────────────

test('cada bloco tem id estável e remove a instância anterior (sem duplicar)', () => {
  assert.match(AVISO_ATIVADA, /id = 'gcal-agenda-ativada'/);
  assert.match(AVISO_ATIVADA, /querySelector\('#gcal-agenda-ativada'\)/);
  assert.match(AVISO_BLOQUEADA, /id = 'gcal-agenda-bloqueada-persona'/);
  assert.match(AVISO_BLOQUEADA, /querySelector\('#gcal-agenda-bloqueada-persona'\)/);
});

test('os dois blocos são anunciados por leitor de tela (role=status)', () => {
  assert.match(AVISO_ATIVADA, /setAttribute\('role', 'status'\)/);
  assert.match(AVISO_BLOQUEADA, /setAttribute\('role', 'status'\)/);
});

test('copy do aviso de agenda ligada nomeia a MUDANÇA de modo, não só "ok"', () => {
  assert.match(AVISO_ATIVADA, /modo atendente/i);
  assert.match(AVISO_ATIVADA, /marca horário sozinho/i);
  assert.match(AVISO_ATIVADA, /agenda_automatica=true/);
  assert.match(AVISO_ATIVADA, /modo_atendente_enabled=false/);
});

test('copy do aviso de bloqueio é AÇÃO NECESSÁRIA (não erro): diz o porquê e o próximo passo', () => {
  assert.match(AVISO_BLOQUEADA, /não foi ligado/i, 'precisa deixar claro que o modo NÃO mudou');
  assert.match(AVISO_BLOQUEADA, /cartão de confirmação/i, 'precisa dizer o que falta na persona');
  assert.match(AVISO_BLOQUEADA, /sem confirmar/i, 'precisa dizer o risco de ligar assim');
  assert.match(AVISO_BLOQUEADA, /aba <strong>Prompt<\/strong>/i, 'precisa apontar a ação concreta');
  assert.match(AVISO_BLOQUEADA, /Testar de novo/i, 'precisa dizer que re-testa depois de ajustar');
  assert.match(
    AVISO_BLOQUEADA,
    /continua em <strong>modo atendente<\/strong>/i,
    'precisa dizer o estado atual',
  );
});

test('os ícones usados existem no dicionário ICONS (fallback é SVG vazio e silencioso)', () => {
  for (const bloco of [AVISO_ATIVADA, AVISO_BLOQUEADA]) {
    const usados = [...bloco.matchAll(/icon\('([^']+)'/g)].map((m) => m[1]);
    assert.ok(usados.length > 0, 'o bloco usa ao menos um ícone');
    for (const nome of usados) {
      assert.match(INDEX, new RegExp(`'${nome}':\\s*'<`), `ícone '${nome}' não existe em ICONS`);
    }
  }
});
