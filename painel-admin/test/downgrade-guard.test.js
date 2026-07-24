// Testes da trava fail-closed contra downgrade destrutivo estabelecimento→individual
// no PATCH /api/clones/:id (SCRUM-138).
// Uso: node --test painel-admin/test/downgrade-guard.test.js
//
// ⚠️ Estes testes NÃO rodam no CI (vitest.config.ts exclui painel-admin/test/** — SCRUM-50).
//    Rode à mão: `node --test painel-admin/test/*.test.js`.
//
// CONTEXTO (matriz de transições T4): trocar product_type estabelecimento→individual pelo
// PATCH não tinha validação. Depois que o calendário é reconfigurado, o gcal-atend-sync
// soft-deleta em massa os atendimentos origem='agenda' do colaborador (FATURADO já realizado)
// e reescreve a comissão — silencioso, sem log, irrecuperável (soft-delete + comissão paga).
//
// ESTRATÉGIA (igual gcal-test-liga-agenda.test.js, diferente dos que replicam a lógica): NADA
// é replicado. O teste LÊ o server.js, EXTRAI a função pura `bloqueiaDowngradeEstab` do source
// e a EXECUTA (new Function do corpo real), e EXTRAI o handler do PATCH pra asseverar o wiring
// (409 + as duas SQL de COUNT). Se alguém remover/afrouxar o guard no server.js, estes testes
// ficam VERMELHOS: sem a função a extração lança; sem o 409/SQL as asserções de source falham.
// Teste que passa com e sem o fix não guarda nada — foi verificado removendo cada peça.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

// ── Extração do código real ──────────────────────────────────────────────────

/** Corpo do handler de uma rota (do marcador até a próxima definição `app.<verbo>(`). */
function handlerSource(routeMarker) {
  const start = SERVER.indexOf(routeMarker);
  assert.ok(start > -1, `rota não encontrada no server.js: ${routeMarker}`);
  const rest = SERVER.slice(start + routeMarker.length);
  const endRel = rest.search(/\napp\.(get|post|put|patch|delete)\(/);
  return endRel === -1 ? rest : rest.slice(0, endRel);
}

/** Recorta `function nome(...) { ... }` do source casando chaves (o corpo REAL, não uma cópia). */
function extractFunction(name) {
  const sigAt = SERVER.indexOf(`function ${name}(`);
  assert.ok(sigAt > -1, `função ${name} não existe no server.js (guard removido?)`);
  const openParen = SERVER.indexOf('(', sigAt);
  const openBrace = SERVER.indexOf('{', openParen);
  let depth = 0;
  for (let k = openBrace; k < SERVER.length; k++) {
    if (SERVER[k] === '{') depth++;
    else if (SERVER[k] === '}') {
      depth--;
      if (depth === 0) return SERVER.slice(sigAt, k + 1);
    }
  }
  throw new Error(`chaves de ${name} não fecham`);
}

/** Instancia a função REAL do source (executa a lógica de produção, sem importar o módulo). */
const bloqueiaDowngradeEstab = new Function(`${extractFunction('bloqueiaDowngradeEstab')}
  return bloqueiaDowngradeEstab;`)();

const PATCH = handlerSource("app.patch('/api/clones/:id'");

// ─────────────────────────────────────────────────────────────────────────────
// (1) Decisão pura REAL: bloqueia SÓ o caso destrutivo
// ─────────────────────────────────────────────────────────────────────────────

test('estab→individual COM colaboradores ⇒ bloqueia (409)', () => {
  assert.equal(bloqueiaDowngradeEstab('estabelecimento', 'individual', 2, 0), true);
});

test('estab→individual COM faturamento de agenda (sem colaboradores) ⇒ bloqueia', () => {
  assert.equal(bloqueiaDowngradeEstab('estabelecimento', 'individual', 0, 5), true);
});

test('estab→individual COM colaboradores E faturamento ⇒ bloqueia', () => {
  assert.equal(bloqueiaDowngradeEstab('estabelecimento', 'individual', 3, 12), true);
});

test('estab→individual SEM colaboradores nem faturamento (clone vazio) ⇒ PERMITE', () => {
  assert.equal(bloqueiaDowngradeEstab('estabelecimento', 'individual', 0, 0), false);
});

test('upgrade individual→estabelecimento ⇒ PERMITE (não é o caso destrutivo)', () => {
  assert.equal(bloqueiaDowngradeEstab('individual', 'estabelecimento', 0, 0), false);
  assert.equal(bloqueiaDowngradeEstab('individual', 'estabelecimento', 5, 9), false);
});

test('no-op individual→individual ⇒ PERMITE (prevType já não é estabelecimento)', () => {
  assert.equal(bloqueiaDowngradeEstab('individual', 'individual', 0, 0), false);
});

test('no-op estab→estab (outras edições do PATCH) ⇒ PERMITE (alvo não é individual)', () => {
  assert.equal(bloqueiaDowngradeEstab('estabelecimento', 'estabelecimento', 4, 30), false);
});

test('alvo tipo novo/futuro (ex.: franquia) ⇒ PERMITE — só barra alvo === individual', () => {
  assert.equal(bloqueiaDowngradeEstab('estabelecimento', 'franquia', 4, 30), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) Wiring do handler: gatilho, leitura do estado anterior, 409 e SQL de COUNT
//     (asserções sobre o source real — vão VERMELHAS se o guard sumir/afrouxar)
// ─────────────────────────────────────────────────────────────────────────────

test('o guard só dispara quando o alvo é individual (não onera outras edições)', () => {
  assert.match(
    PATCH,
    /product_type !== undefined && String\(product_type\) === 'individual'/,
    'o bloco de bloqueio precisa ser gateado por alvo=individual',
  );
});

test('lê o product_type/slot ANTERIOR do banco antes de decidir', () => {
  assert.match(
    PATCH,
    /SELECT product_type, slot FROM flow_clones WHERE id = \$1/,
    'sem o estado anterior não dá pra saber que é estab→individual',
  );
  assert.match(PATCH, /bloqueiaDowngradeEstab\(prevType, String\(product_type\), nColab, nAtend\)/);
});

test('conta colaboradores do slot (escopo por slot, parametrizado)', () => {
  assert.match(
    PATCH,
    /COUNT\(\*\)::int FROM clone_colaboradores WHERE slot = \$1/,
    'colaboradores devem ser contados escopados por slot',
  );
});

test('conta faturamento origem=agenda ativo e já realizado (não walk-in, não deletado)', () => {
  assert.match(PATCH, /FROM atendimentos/);
  assert.match(PATCH, /origem = 'agenda'/, 'só faturamento derivado da agenda');
  assert.match(PATCH, /deleted_at IS NULL/, 'ignora linhas já soft-deletadas');
  assert.match(
    PATCH,
    /fim_at IS NULL OR fim_at <= now\(\)/,
    'faturado = fim_at no passado (ADR 0027); futuro puro não conta',
  );
  assert.match(PATCH, /WHERE slot = \$1/, 'atendimentos escopados por slot');
});

test('bloqueio responde 409 com erro identificável e contadores pro operador', () => {
  assert.match(PATCH, /status\(409\)/, 'downgrade barrado = 409 (fail-closed, padrão SCRUM-74)');
  assert.match(PATCH, /downgrade_estabelecimento_bloqueado/, 'erro estável pro front');
  assert.match(PATCH, /migração/i, 'mensagem clara cita migração');
  assert.match(PATCH, /supervisionada/i, 'mensagem clara aponta o caminho certo (supervisionada)');
  assert.match(PATCH, /colaboradores: nColab/);
  assert.match(PATCH, /faturamento_agenda: nAtend/);
});

test('SQL parametrizada — sem interpolação de string na query do guard', () => {
  const guardSql = PATCH.slice(
    PATCH.indexOf('clone_colaboradores'),
    PATCH.indexOf('faturamento_agenda`'),
  );
  assert.doesNotMatch(guardSql, /\$\{/, 'nada de template string dentro da SQL do guard');
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) Não quebra os outros usos do PATCH: as edições parciais seguem intactas
// ─────────────────────────────────────────────────────────────────────────────

test('o PATCH continua montando o UPDATE parcial (display_name/status/etc intactos)', () => {
  assert.match(PATCH, /UPDATE flow_clones SET \$\{sets\.join\(', '\)\}/, 'a escrita parcial segue');
  for (const campo of ['display_name', 'cliente_nome', 'personalizacao', 'status', 'timezone']) {
    assert.match(PATCH, new RegExp(`${campo}`), `edição de ${campo} não pode ter sumido`);
  }
});

test('o guard fica ANTES da montagem do UPDATE (barra o clique antes de escrever)', () => {
  const guardAt = PATCH.indexOf('downgrade_estabelecimento_bloqueado');
  const updateAt = PATCH.indexOf('UPDATE flow_clones SET');
  assert.ok(guardAt > -1 && updateAt > -1 && guardAt < updateAt, 'bloqueio deve preceder o UPDATE');
});

test('a função de decisão é PURA (sem I/O) — só lê seus 4 argumentos', () => {
  const fnSrc = extractFunction('bloqueiaDowngradeEstab');
  assert.doesNotMatch(fnSrc, /pool|await|query|res\.|req\./, 'decisão não pode fazer I/O');
});
