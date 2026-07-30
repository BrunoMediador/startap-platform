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
  cartaoBakedReason: 'found',
};

const CLONE_ATENDENTE = {
  product_type: 'individual',
  personalizacao: { agenda_automatica: 'false' },
  modoAtendenteEnabled: true,
  cartaoMode: 'baked',
  cartaoBakedReason: 'sem_cartao',
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
  const cur = { ...CLONE_AGENDA, cartaoMode: 'runtime', cartaoBakedReason: 'sem_cartao' };
  const d = decideFormatoClone(cur, 'atendente', { personaTemMecanica: true });
  assert.equal(d.ok, true);
  assert.equal(d.mudou, true);
  assert.equal(d.motivo, 'desligou_agenda');
  assert.notEqual(d.avisoTextoAssado, true);
});

test('desligar agenda num clone BAKED com cartão no texto (posição canônica) ⇒ muda MAS avisa avisoTextoAssado', () => {
  const cur = { ...CLONE_AGENDA, cartaoMode: 'baked', cartaoBakedReason: 'found' };
  const d = decideFormatoClone(cur, 'atendente', { personaTemMecanica: true });
  assert.equal(d.ok, true);
  assert.equal(d.mudou, true);
  assert.equal(d.avisoTextoAssado, true, 'clone baked com cartão no texto precisa do aviso');
  assert.notEqual(d.avisoTextoAssadoForaDoPadrao, true, 'cartão canônico não é "fora do padrão"');
});

test('desligar agenda num clone BAKED SEM cartão detectável no texto ⇒ muda, sem aviso (nada a avisar)', () => {
  const cur = { ...CLONE_AGENDA, cartaoMode: 'baked', cartaoBakedReason: 'sem_cartao' };
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

// ── FIX 1 (review qa+security, 30/07): falso-negativo do avisoTextoAssado ────
// extractBakedCartao devolve found:false por 2 razões: 'sem_cartao' (não há
// cartão) e 'cartao_nao_trailing' (HÁ cartão, só não em posição canônica —
// cenário real, coberto em cartao-extract.test.ts:58,103). Colapsar as duas em
// "não avisa" deixava desligar a agenda de um clone com cartão editado à mão
// "no meio" do prompt SEM avisar ninguém — exatamente o que a 13-bis existe pra
// impedir. Decisão do Bruno (30/07): o aviso é a ÚNICA proteção deste caminho
// (não conserta o bot_prompt), então tem que disparar sempre que há QUALQUER
// sinal de cartão no texto — fail-closed no sentido do aviso.

test('FIX 1: cartão HÁ mas fora do trailing (cartao_nao_trailing) ⇒ avisa MESMO ASSIM', () => {
  const cur = { ...CLONE_AGENDA, cartaoMode: 'baked', cartaoBakedReason: 'cartao_nao_trailing' };
  const d = decideFormatoClone(cur, 'atendente', { personaTemMecanica: true });
  assert.equal(d.ok, true);
  assert.equal(d.mudou, true);
  assert.equal(d.avisoTextoAssado, true, 'cartão fora do trailing AINDA é cartão no texto — tem que avisar');
});

test('FIX 1: aviso por cartão fora do trailing tem motivo diferenciado (avisoTextoAssadoForaDoPadrao)', () => {
  const cur = { ...CLONE_AGENDA, cartaoMode: 'baked', cartaoBakedReason: 'cartao_nao_trailing' };
  const d = decideFormatoClone(cur, 'atendente', { personaTemMecanica: true });
  assert.equal(d.avisoTextoAssadoForaDoPadrao, true);
});

test('FIX 1: sem_cartao (razão distinta de cartao_nao_trailing) NÃO avisa — nada a avisar de fato', () => {
  const cur = { ...CLONE_AGENDA, cartaoMode: 'baked', cartaoBakedReason: 'sem_cartao' };
  const d = decideFormatoClone(cur, 'atendente', { personaTemMecanica: true });
  assert.notEqual(d.avisoTextoAssado, true);
  assert.notEqual(d.avisoTextoAssadoForaDoPadrao, true);
});

test('FIX 1: as duas razões de found:false são tratadas DIFERENTE uma da outra (não colapsam)', () => {
  const semCartao = decideFormatoClone(
    { ...CLONE_AGENDA, cartaoMode: 'baked', cartaoBakedReason: 'sem_cartao' },
    'atendente',
    { personaTemMecanica: true },
  );
  const foraDoTrailing = decideFormatoClone(
    { ...CLONE_AGENDA, cartaoMode: 'baked', cartaoBakedReason: 'cartao_nao_trailing' },
    'atendente',
    { personaTemMecanica: true },
  );
  assert.notEqual(semCartao.avisoTextoAssado, foraDoTrailing.avisoTextoAssado);
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
// (3-bis) Gaps de teste pedidos pelo QA — clone inexistente, personalizacao
// malformado, product_type ausente. O QA verificou manualmente que o código já
// se comporta certo nestes casos; aqui é a cobertura automatizada.
// ─────────────────────────────────────────────────────────────────────────────

test('clone inexistente: o handler responde 404 ANTES de tentar decidir qualquer coisa', () => {
  assert.match(HANDLER, /if \(!r\.rows\[0\]\) \{/, 'checa a linha antes de seguir');
  assert.match(HANDLER, /res\.status\(404\)\.json\(\{ error: 'Clone não encontrado' \}\)/);
});

test('clone inexistente: faz ROLLBACK antes do 404 (não deixa transação pendurada)', () => {
  const notFoundBlock = HANDLER.slice(
    HANDLER.indexOf('if (!r.rows[0]) {'),
    HANDLER.indexOf('const row = r.rows[0];'),
  );
  assert.match(notFoundBlock, /await client\.query\('ROLLBACK'\)/);
  assert.match(notFoundBlock, /404/);
});

test('personalizacao=null ⇒ lido como agenda (guard typeof já cobre; não lança)', () => {
  const cur = { product_type: 'individual', personalizacao: null, modoAtendenteEnabled: false, cartaoMode: 'baked' };
  assert.doesNotThrow(() => decideFormatoClone(cur, 'agenda', { personaTemMecanica: true }));
  const d = decideFormatoClone(cur, 'agenda', { personaTemMecanica: true });
  assert.equal(d.mudou, false, 'null é tratado como agenda (mesma leitura de chave ausente)');
});

test('personalizacao=string (JSONB corrompido/tipo errado) ⇒ não lança, cai no default agenda', () => {
  const cur = { product_type: 'individual', personalizacao: 'não deveria ser string', modoAtendenteEnabled: false, cartaoMode: 'baked' };
  assert.doesNotThrow(() => decideFormatoClone(cur, 'agenda', { personaTemMecanica: true }));
  const d = decideFormatoClone(cur, 'agenda', { personaTemMecanica: true });
  assert.equal(d.mudou, false);
});

test('personalizacao=array (typeof "object" mas não é o shape esperado) ⇒ não lança', () => {
  const cur = { product_type: 'individual', personalizacao: [], modoAtendenteEnabled: false, cartaoMode: 'baked' };
  assert.doesNotThrow(() => decideFormatoClone(cur, 'atendente', { personaTemMecanica: true }));
  // array não tem chave agenda_automatica ⇒ lido como agenda ⇒ pedir atendente MUDA.
  const d = decideFormatoClone(cur, 'atendente', { personaTemMecanica: true });
  assert.equal(d.ok, true);
  assert.equal(d.mudou, true);
});

test('product_type=null ⇒ NÃO é "individual" ⇒ 400 fail-closed (mesmo caminho do estabelecimento)', () => {
  const cur = { product_type: null, personalizacao: {}, modoAtendenteEnabled: false };
  const d = decideFormatoClone(cur, 'agenda', { personaTemMecanica: true });
  assert.equal(d.ok, false);
  assert.equal(d.http, 400);
  assert.equal(d.motivo, 'nao_individual');
});

test('product_type=undefined (coluna ausente/erro de leitura) ⇒ 400 fail-closed, não lança', () => {
  const cur = { personalizacao: {}, modoAtendenteEnabled: false };
  assert.doesNotThrow(() => decideFormatoClone(cur, 'agenda', { personaTemMecanica: true }));
  const d = decideFormatoClone(cur, 'agenda', { personaTemMecanica: true });
  assert.equal(d.ok, false);
  assert.equal(d.motivo, 'nao_individual');
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
    /const extracted = extractBakedCartao\(row\.bot_prompt \?\? ''\);/,
    'deve reusar o detector já testado, nunca reimplementar',
  );
});

test('runtime dispensa a checagem de texto (mecânica vem do código)', () => {
  assert.match(HANDLER, /if \(row\.cartao_mode === 'runtime'\) \{\s*personaTemMecanica = true;/);
});

test('import quebrado é FAIL-CLOSED nos DOIS sentidos: não libera o flip E assume que pode haver cartão', () => {
  assert.match(
    HANDLER,
    /catch \(importErr\) \{[\s\S]*?personaTemMecanica = false;[\s\S]*?cartaoBakedReason = 'cartao_nao_trailing';/,
    'sem conseguir provar a mecânica, não pode liberar o flip NEM perder o aviso',
  );
});

// FIX 1 — wiring: cartaoBakedReason carrega o `reason` FINO da extração, não o
// found/!found colapsado (era o bug do falso-negativo).
test('cartaoBakedReason vem do extracted.reason quando found:false (não colapsa em booleano)', () => {
  assert.match(
    HANDLER,
    /cartaoBakedReason = extracted\.found === true \? 'found' : extracted\.reason;/,
    'precisa propagar cartao_nao_trailing vs sem_cartao, não só true/false',
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
  assert.match(
    HANDLER,
    /avisoTextoAssadoForaDoPadrao: decisao\.avisoTextoAssadoForaDoPadrao === true \? true : undefined/,
    'motivo diferenciado pra cartão fora do trailing também precisa chegar na resposta',
  );
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

// ── FIX 2 (review qa+security, 30/07): concorrência — SELECT ... FOR UPDATE
// dentro de transação explícita (BEGIN/COMMIT/ROLLBACK). O UPDATE em si já era
// atômico (par de colunas nunca sai meio-a-meio); o que faltava travar era a
// leitura-que-decide não ser pisada por uma escrita concorrente no mesmo clone
// entre o SELECT e o UPDATE. Decisão+escrita não cabem numa CTE única como o
// /gcal/test porque a decisão depende de I/O assíncrono (import + JS) fora do SQL.
test('FIX 2: usa transação explícita com BEGIN e a leitura trava a linha (FOR UPDATE)', () => {
  assert.match(HANDLER, /await client\.query\('BEGIN'\)/, 'precisa abrir transação explícita');
  assert.match(HANDLER, /FOR UPDATE OF fc/, 'a leitura que decide precisa travar a linha do clone');
});

test('FIX 2: todo caminho de saída fecha a transação — sucesso commita, erro/no-op faz rollback', () => {
  assert.match(HANDLER, /await client\.query\('COMMIT'\)/, 'caminho de escrita precisa commitar');
  const rollbacks = [...HANDLER.matchAll(/await client\.query\('ROLLBACK'\)/g)];
  assert.ok(rollbacks.length >= 3, 'clone não encontrado, decisão barrada e no-op idempotente precisam rollback');
});

test('FIX 2: catch genérico também faz ROLLBACK (nunca deixa transação pendurada)', () => {
  assert.match(HANDLER, /catch \(e\) \{\s*await client\.query\('ROLLBACK'\)\.catch/);
});

test('FIX 2: conexão é sempre liberada de volta ao pool (finally com client.release)', () => {
  assert.match(HANDLER, /\} finally \{\s*client\.release\(\);\s*\}/);
});

test('FIX 2: leitura e escrita usam a MESMA conexão (client), não pool.query solto', () => {
  const withoutComment = HANDLER.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(
    withoutComment,
    /pool\.query/,
    'dentro do handler tudo deve passar pela conexão travada (client), não pelo pool genérico',
  );
});

// ── Security P3 (opcional, aplicado): resposta de erro não derrama campos
// internos da decisão (http/ok) — enumera os campos explicitamente.
test('resposta de erro enumera campos explicitamente, não espalha a decisão inteira (`...decisao`)', () => {
  assert.doesNotMatch(HANDLER, /\.\.\.decisao/, 'nunca espalhar a decisão inteira na resposta HTTP');
  assert.match(
    HANDLER,
    /res\.status\(decisao\.http\)\.json\(\{\s*ok: false,\s*error: decisao\.motivo,\s*productType: decisao\.productType,\s*\}\)/,
  );
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
