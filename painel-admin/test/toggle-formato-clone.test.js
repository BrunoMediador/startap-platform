// Testes do toggle EXPLÍCITO e IDEMPOTENTE de formato do clone
// (POST /api/clones/:id/formato — achado 30/07).
// Uso: node --test painel-admin/test/toggle-formato-clone.test.js
//
// ⚠️ Estes testes NÃO rodam no CI (vitest.config.ts exclui painel-admin/test/** — SCRUM-50).
//    Rode à mão: `node --test painel-admin/test/*.test.js`.
//
// CONTEXTO: a ÚNICA escrita de agenda_automatica + modo_atendente_enabled pelo gestão era
// efeito colateral do botão "Testar conexão" do GCal (POST /api/clones/:id/gcal/test), e só
// disparava na TRANSIÇÃO de gcal_status. Clone já `active` ⇒ UPDATE sem SET (rowCount 0) ⇒
// HTTP 200 idêntico a um teste de rotina — o operador clicava, nada mudava, nada avisava.
// Este endpoint dá um caminho explícito, e a regra de negócio 13-bis (SIMETRIA DO CARTÃO)
// exige que ligar/desligar agenda entre/saia da mecânica de agendamento nos dois sentidos.
//
// ESTRATÉGIA (igual gcal-test-liga-agenda.test.js / downgrade-guard.test.js): a função de
// decisão `decideFormatoClone` é PURA (sem I/O) — o teste EXTRAI o corpo real do server.js e
// EXECUTA a função de produção (new Function), nunca uma cópia à mão. Se alguém afrouxar o
// guard no server.js, estes testes ficam VERMELHOS.
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

/** Recorta `function nome(...) { ... }` do source casando chaves (o corpo REAL). */
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

/** Instancia a função REAL do source (executa a lógica de produção). */
const decideFormatoClone = new Function(`${extractFunction('decideFormatoClone')}
  return decideFormatoClone;`)();

const HANDLER = handlerSource("app.post('/api/clones/:id/formato'");

// ─────────────────────────────────────────────────────────────────────────────
// (1) Decisão pura REAL: idempotência (nunca 200 mudo)
// ─────────────────────────────────────────────────────────────────────────────

const CLONE_AGENDA = {
  product_type: 'individual',
  personalizacao: { agenda_automatica: 'true' },
  modoAtendenteEnabled: false,
  cartaoMode: 'baked',
  personaTemMecanicaBaked: true,
};

const CLONE_ATENDENTE = {
  product_type: 'individual',
  personalizacao: { agenda_automatica: 'false' },
  modoAtendenteEnabled: true,
  cartaoMode: 'baked',
  personaTemMecanicaBaked: false,
};

test('idempotência: pedir "agenda" num clone já em agenda ⇒ mudou:false, motivo explícito', () => {
  const d = decideFormatoClone(CLONE_AGENDA, 'agenda', { personaTemMecanica: true });
  assert.equal(d.ok, true);
  assert.equal(d.mudou, false);
  assert.equal(d.motivo, 'ja_estava');
});

test('idempotência: pedir "atendente" num clone já atendente ⇒ mudou:false, motivo explícito', () => {
  const d = decideFormatoClone(CLONE_ATENDENTE, 'atendente', { personaTemMecanica: false });
  assert.equal(d.ok, true);
  assert.equal(d.mudou, false);
  assert.equal(d.motivo, 'ja_estava');
});

test('2 chamadas idênticas seguidas dão o MESMO resultado (idempotência de verdade)', () => {
  const d1 = decideFormatoClone(CLONE_AGENDA, 'agenda', { personaTemMecanica: true });
  const d2 = decideFormatoClone(CLONE_AGENDA, 'agenda', { personaTemMecanica: true });
  assert.deepEqual(d1, d2);
});

test('nunca retorna {mudou:false} sem `motivo` (é o bug que este endpoint mata)', () => {
  const d = decideFormatoClone(CLONE_AGENDA, 'agenda', { personaTemMecanica: true });
  assert.ok(d.motivo, 'toda resposta idempotente precisa dizer POR QUÊ nada mudou');
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) SIMETRIA DO CARTÃO (regra 13-bis) — ligar exige mecânica; desligar avisa
// ─────────────────────────────────────────────────────────────────────────────

test('ligar agenda COM mecânica garantida (cartao_mode=runtime) ⇒ muda', () => {
  const d = decideFormatoClone(CLONE_ATENDENTE, 'agenda', { personaTemMecanica: true });
  assert.equal(d.ok, true);
  assert.equal(d.mudou, true);
  assert.equal(d.motivo, 'ligou_agenda');
  assert.equal(d.formato, 'agenda');
});

test('FAIL-CLOSED: ligar agenda SEM mecânica garantida ⇒ barra (409), nunca entrega bot sem cartão', () => {
  const d = decideFormatoClone(CLONE_ATENDENTE, 'agenda', { personaTemMecanica: false });
  assert.equal(d.ok, false);
  assert.equal(d.http, 409);
  assert.equal(d.motivo, 'sem_mecanica_cartao');
});

test('desligar agenda num clone RUNTIME (mecânica é código, não texto) ⇒ muda, SEM aviso de texto assado', () => {
  const cur = { ...CLONE_AGENDA, cartaoMode: 'runtime', personaTemMecanicaBaked: false };
  const d = decideFormatoClone(cur, 'atendente', { personaTemMecanica: true });
  assert.equal(d.ok, true);
  assert.equal(d.mudou, true);
  assert.equal(d.motivo, 'desligou_agenda');
  assert.notEqual(d.avisoTextoAssado, true);
});

test('desligar agenda num clone BAKED com cartão no texto ⇒ muda MAS avisa avisoTextoAssado', () => {
  const cur = { ...CLONE_AGENDA, cartaoMode: 'baked', personaTemMecanicaBaked: true };
  const d = decideFormatoClone(cur, 'atendente', { personaTemMecanica: true });
  assert.equal(d.ok, true);
  assert.equal(d.mudou, true);
  assert.equal(d.avisoTextoAssado, true, 'clone baked com cartão no texto precisa do aviso');
});

test('desligar agenda num clone BAKED SEM cartão detectável no texto ⇒ muda, sem aviso (nada a avisar)', () => {
  const cur = { ...CLONE_AGENDA, cartaoMode: 'baked', personaTemMecanicaBaked: false };
  const d = decideFormatoClone(cur, 'atendente', { personaTemMecanica: true });
  assert.equal(d.ok, true);
  assert.equal(d.mudou, true);
  assert.notEqual(d.avisoTextoAssado, true);
});

test('desligar nunca é bloqueado por falta de mecânica (só LIGAR exige a garantia)', () => {
  const d = decideFormatoClone(CLONE_AGENDA, 'atendente', { personaTemMecanica: false });
  assert.equal(d.ok, true);
  assert.equal(d.mudou, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) Estabelecimento: erro explícito, NUNCA silêncio
// ─────────────────────────────────────────────────────────────────────────────

test('estabelecimento ⇒ 400 explícito com motivo (nunca no-op silencioso)', () => {
  const cur = { product_type: 'estabelecimento', personalizacao: {}, modoAtendenteEnabled: true };
  const d = decideFormatoClone(cur, 'agenda', { personaTemMecanica: true });
  assert.equal(d.ok, false);
  assert.equal(d.http, 400);
  assert.equal(d.motivo, 'nao_individual');
  assert.equal(d.productType, 'estabelecimento');
});

test('estabelecimento é barrado ANTES de checar idempotência (nunca conta como "já estava")', () => {
  const cur = { product_type: 'estabelecimento', personalizacao: {}, modoAtendenteEnabled: false };
  const d = decideFormatoClone(cur, 'agenda', { personaTemMecanica: true });
  assert.equal(d.ok, false);
  assert.notEqual(d.motivo, 'ja_estava');
});

test('alvo inválido ⇒ 400 explícito (não silencia entrada malformada)', () => {
  const d = decideFormatoClone(CLONE_AGENDA, 'invalido', {});
  assert.equal(d.ok, false);
  assert.equal(d.http, 400);
  assert.equal(d.motivo, 'alvo_invalido');
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) Coerência: as 2 colunas nunca saem meio-a-meio (checagem no formato de RETORNO)
// ─────────────────────────────────────────────────────────────────────────────

test('formato retornado é sempre um dos dois valores válidos (front decide as 2 colunas a partir dele)', () => {
  const d1 = decideFormatoClone(CLONE_ATENDENTE, 'agenda', { personaTemMecanica: true });
  const d2 = decideFormatoClone(CLONE_AGENDA, 'atendente', { personaTemMecanica: true });
  assert.ok(['agenda', 'atendente'].includes(d1.formato));
  assert.ok(['agenda', 'atendente'].includes(d2.formato));
});

// ─────────────────────────────────────────────────────────────────────────────
// (5) Leitura do estado ATUAL: boolean-ou-string, mesma convenção do resto do código
//     (agenda-degrade.ts / teste_barbearia.ts) — chave ausente = agenda LIGADA.
// ─────────────────────────────────────────────────────────────────────────────

test('chave agenda_automatica AUSENTE (Cirilo/Samuel/Dragon) ⇒ lido como formato "agenda"', () => {
  const cur = { product_type: 'individual', personalizacao: {}, modoAtendenteEnabled: false, cartaoMode: 'baked' };
  const d = decideFormatoClone(cur, 'agenda', { personaTemMecanica: true });
  assert.equal(d.mudou, false, 'chave ausente já É agenda — pedir agenda de novo é no-op');
});

test('personalizacao boolean cru false (gravado por SQL/gestão) também conta como atendente', () => {
  const cur = { product_type: 'individual', personalizacao: { agenda_automatica: false }, modoAtendenteEnabled: false, cartaoMode: 'baked' };
  const d = decideFormatoClone(cur, 'atendente', { personaTemMecanica: true });
  assert.equal(d.mudou, false, 'já está em atendente pelo boolean cru');
});

test('modo_atendente_enabled=true sozinho (agenda_automatica ausente) já conta como atendente', () => {
  const cur = { product_type: 'individual', personalizacao: {}, modoAtendenteEnabled: true, cartaoMode: 'baked' };
  const d = decideFormatoClone(cur, 'atendente', { personaTemMecanica: true });
  assert.equal(d.mudou, false);
});

test('a função de decisão é PURA (sem I/O) — só lê os argumentos', () => {
  const fnSrc = extractFunction('decideFormatoClone');
  assert.doesNotMatch(fnSrc, /pool|await|query|res\.|req\./, 'decisão não pode fazer I/O');
});

// ─────────────────────────────────────────────────────────────────────────────
// (6) Wiring do handler: reusa extractBakedCartao (nunca duplica), transação
//     coerente numa statement só, resposta nunca-muda-silenciosamente.
// ─────────────────────────────────────────────────────────────────────────────

test('reusa extractBakedCartao (mesmo detector do /gcal/test, não uma heurística nova)', () => {
  assert.match(
    HANDLER,
    /extractBakedCartao\(row\.bot_prompt \?\? ''\)\.found === true/,
    'deve reusar o detector já testado, nunca reimplementar',
  );
});

test('runtime dispensa a checagem de texto (mecânica vem do código)', () => {
  assert.match(HANDLER, /if \(row\.cartao_mode === 'runtime'\) \{\s*personaTemMecanica = true;/);
});

test('import quebrado é FAIL-CLOSED (não libera o flip)', () => {
  assert.match(
    HANDLER,
    /catch \(importErr\) \{[\s\S]*?personaTemMecanica = false;/,
    'sem conseguir provar a mecânica, não pode liberar',
  );
});

test('as 2 colunas saem do MESMO UPDATE (nunca meio-a-meio) — agenda_automatica é STRING', () => {
  const updates = [...HANDLER.matchAll(/UPDATE\s+flow_clones/gi)];
  assert.equal(updates.length, 1, 'ler-e-escrever em 2 etapas abre janela de corrida/incoerência');
  assert.match(HANDLER, /jsonb_set\(COALESCE\(personalizacao/, 'agenda_automatica via jsonb_set');
  assert.match(HANDLER, /to_jsonb\(\$2::text\)/, "storage é STRING (convenção 'true'/'false', nunca boolean)");
  assert.match(HANDLER, /modo_atendente_enabled = \$3/, 'as 2 colunas no mesmo UPDATE');
});

test('nunca 200 mudo: toda resposta ok carrega `mudou` explícito', () => {
  assert.match(HANDLER, /mudou: false/);
  assert.match(HANDLER, /mudou: true/);
});

test('caso barrado responde com o status http da decisão (409/400), não 200', () => {
  assert.match(HANDLER, /res\.status\(decisao\.http\)\.json/);
});

test('resposta de desligar clone baked-com-cartão expõe avisoTextoAssado (não conserta, avisa)', () => {
  assert.match(HANDLER, /avisoTextoAssado: decisao\.avisoTextoAssado === true \? true : undefined/);
});

test('handler NUNCA escreve em bot_prompt (o texto assado é intocado — decisão do Bruno)', () => {
  assert.doesNotMatch(HANDLER, /UPDATE\s+bot_prompt/i, 'este endpoint não mexe no prompt');
});

test('não mexe em billing_from_agenda_enabled nem em outros gates fora do escopo', () => {
  assert.doesNotMatch(HANDLER, /billing_from_agenda_enabled/i);
});

test('SQL parametrizada — sem interpolação de string no UPDATE', () => {
  const updateStart = HANDLER.indexOf('UPDATE flow_clones');
  const updateSql = HANDLER.slice(updateStart, HANDLER.indexOf('RETURNING', updateStart) + 60);
  assert.doesNotMatch(updateSql, /\$\{/, 'nada de template string dentro da SQL');
});

test('rota valida id numérico e formato antes de tocar o banco', () => {
  assert.match(HANDLER, /Number\.isFinite\(id\)/);
  assert.match(HANDLER, /alvo !== 'agenda' && alvo !== 'atendente'/);
});

test('log [formato] registra tanto o sucesso quanto o bloqueio (nada silencioso no console)', () => {
  assert.match(HANDLER, /\[formato\][^`]*BARRADO/);
  assert.match(HANDLER, /\[formato\][^`]*já estava/);
});

// ─────────────────────────────────────────────────────────────────────────────
// (7) GET /api/clones/:id expõe os campos que a UI precisa pra mostrar estado
// ─────────────────────────────────────────────────────────────────────────────

test('GET /api/clones/:id retorna modo_atendente_enabled, cartao_mode e gcal_status', () => {
  const GET = handlerSource("app.get('/api/clones/:id'");
  assert.match(GET, /fc\.modo_atendente_enabled/);
  assert.match(GET, /fc\.cartao_mode/);
  assert.match(GET, /fc\.gcal_status/);
});

// ─────────────────────────────────────────────────────────────────────────────
// (8) Endpoint /gcal/test não foi removido nem alterado no comportamento (regra dura)
// ─────────────────────────────────────────────────────────────────────────────

test('/gcal/test continua existindo e fazendo o flip automático de sempre', () => {
  const GCAL = handlerSource("app.post('/api/clones/:id/gcal/test'");
  assert.match(GCAL, /agenda_ativada/i);
  assert.match(GCAL, /personaTemMecanica/);
});
