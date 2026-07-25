// Testes do fix "validar a agenda liga o modo agenda" (POST /api/clones/:id/gcal/test).
// Uso: node --test painel-admin/test/gcal-test-liga-agenda.test.js
//
// ⚠️ Estes testes NÃO rodam no CI (vitest.config.ts exclui painel-admin/test/** — SCRUM-50).
//    Rode à mão: `node --test painel-admin/test/*.test.js`.
//
// CASO REAL (MVS BARBEARIA, clone_mvs_barbearia_qc9qff): cadastro self-service no formato
// ATENDENTE (personalizacao.agenda_automatica='false' + modo_atendente_enabled=true). Depois
// o time conectou uma agenda Google pelo gestão e validou no botão "Testar" (gcal_status=
// 'active'), mas o TIPO DO FLUXO nunca mudou: o runtime seguiu no ramo `processAtendente`
// (sem tool de agendamento) enquanto o bot_prompt prometia marcar horário.
// 11 conversas, 126 mensagens, ZERO agendamentos.
//
// ESTRATÉGIA (diferente dos outros testes deste diretório, que replicam a lógica à mão):
// aqui NADA é replicado. O teste LÊ o server.js, EXTRAI a statement real do handler e
// avalia o predicado extraído num mini-interpretador de SQL booleano (3-valued logic).
// Consequência desejada: se alguém remover/afrouxar o fix no server.js, estes testes ficam
// VERMELHOS (foi verificado removendo a mudança). Teste que passa com e sem o fix não guarda
// nada.
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

/** Todos os template literals (`...`) de um trecho de código. */
function sqlLiterals(src) {
  return [...src.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}

/**
 * Recorta o predicado `( ... ) AS <alias>` da SQL, casando parênteses de trás pra frente
 * (regex ingênua pegaria o `(` do `WITH prev AS (`).
 */
function extractPredicate(sql, alias) {
  const at = sql.indexOf(`AS ${alias}`);
  assert.ok(at > -1, `a SQL do teste de GCal deveria expor a decisão como \`AS ${alias}\``);
  let close = at - 1;
  while (close >= 0 && /\s/.test(sql[close])) close--;
  assert.equal(sql[close], ')', `esperado \`) AS ${alias}\``);
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (sql[i] === ')') depth++;
    else if (sql[i] === '(') {
      depth--;
      if (depth === 0) return sql.slice(i + 1, close).trim();
    }
  }
  throw new Error(`parênteses do predicado \`AS ${alias}\` não fecham`);
}

// ── Mini-interpretador de predicado SQL (só o subconjunto usado na statement) ─
// Suporta: AND, OR, parênteses, `=`, `<>`, IS [NOT] DISTINCT FROM, IS [NOT] TRUE,
// colunas, literais 'texto', parâmetros $n e acesso jsonb `col->>'chave'`.
// Lógica ternária de verdade (NULL) igual à do Postgres — só `true` conta como flip.

const TOKEN =
  /\s*(\(|\)|\bIS NOT DISTINCT FROM\b|\bIS DISTINCT FROM\b|\bIS NOT TRUE\b|\bIS TRUE\b|\bAND\b|\bOR\b|<>|=|'[^']*'|\$\d+|[A-Za-z_][A-Za-z0-9_]*(?:->>?'[^']*')?)/giy;

function tokenize(src) {
  const out = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    const m = TOKEN.exec(src);
    if (!m) {
      if (/^\s*$/.test(src.slice(TOKEN.lastIndex))) break;
      throw new Error(`token inesperado em: ${src.slice(TOKEN.lastIndex, TOKEN.lastIndex + 30)}`);
    }
    out.push(m[1]);
  }
  return out;
}

/** Resolve um operando pro valor JS (null = NULL do SQL). */
function operand(tok, row, params) {
  if (/^\$\d+$/.test(tok)) {
    const v = params[Number(tok.slice(1)) - 1];
    return v === undefined ? null : v;
  }
  if (/^TRUE$/i.test(tok)) return true;
  if (/^FALSE$/i.test(tok)) return false;
  if (tok.startsWith("'")) return tok.slice(1, -1);
  const json = tok.match(/^([A-Za-z_][A-Za-z0-9_]*)->>'([^']*)'$/);
  if (json) {
    const obj = row[json[1]];
    if (obj === null || obj === undefined) return null;
    const v = obj[json[2]];
    if (v === null || v === undefined) return null;
    return typeof v === 'string' ? v : String(v); // ->> devolve TEXTO
  }
  const v = row[tok];
  return v === undefined ? null : v;
}

const and3 = (a, b) =>
  a === false || b === false ? false : a === null || b === null ? null : true;
const or3 = (a, b) => (a === true || b === true ? true : a === null || b === null ? null : false);

function evalPredicate(src, row, params) {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];

  function factor() {
    if (peek() === '(') {
      next();
      const v = expr();
      assert.equal(next(), ')', 'parêntese não fechado no predicado');
      return v;
    }
    const left = operand(next(), row, params);
    const op = next()?.toUpperCase();
    if (op === 'IS TRUE') return left === true;
    if (op === 'IS NOT TRUE') return left !== true;
    if (op === 'IS DISTINCT FROM' || op === 'IS NOT DISTINCT FROM') {
      const right = operand(next(), row, params);
      const distinct =
        left === null && right === null
          ? false
          : left === null || right === null
            ? true
            : left !== right;
      return op === 'IS DISTINCT FROM' ? distinct : !distinct;
    }
    if (op === '=' || op === '<>') {
      const right = operand(next(), row, params);
      if (left === null || right === null) return null; // NULL propaga
      return op === '=' ? left === right : left !== right;
    }
    throw new Error(`operador não suportado: ${op}`);
  }

  function term() {
    let v = factor();
    while (peek()?.toUpperCase() === 'AND') {
      next();
      v = and3(v, factor());
    }
    return v;
  }

  function expr() {
    let v = term();
    while (peek()?.toUpperCase() === 'OR') {
      next();
      v = or3(v, term());
    }
    return v;
  }

  const out = expr();
  assert.equal(i, toks.length, 'sobrou token no predicado (parser desatualizado?)');
  return out;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const HANDLER = handlerSource("app.post('/api/clones/:id/gcal/test'");
const SQL = sqlLiterals(HANDLER).find((s) => s.includes('UPDATE flow_clones'));
assert.ok(SQL, 'handler do teste de GCal deveria conter um UPDATE flow_clones');
const PREDICADO = extractPredicate(SQL, 'flip');
const PREDICADO_BLOQUEADO = extractPredicate(SQL, 'flip_bloqueado_nao_individual');
const PREDICADO_PERSONA = extractPredicate(SQL, 'flip_bloqueado_persona_sem_mecanica');
/** Só a cláusula SET do UPDATE (o que é ESCRITO), sem o predicado do CTE (o que é LIDO). */
const SET_CLAUSE = SQL.slice(
  SQL.indexOf('SET ', SQL.indexOf('UPDATE flow_clones')),
  SQL.indexOf('FROM prev'),
);
assert.ok(SET_CLAUSE.includes('gcal_status'), 'cláusula SET não recortada');

// $1 = novoStatus, $2 = id (não usado nos predicados), $3 = personaTemMecanica.
const params = (novoStatus, mecanica) => [novoStatus, 999, mecanica];

/**
 * `true` se a statement real flipa o clone. `mecanica` (default true) simula o
 * `personaTemMecanica` que o handler calcula em JS (cartao_mode='runtime' OU
 * extractBakedCartao(bot_prompt).found).
 */
function flipa(rowAntes, novoStatus, mecanica = true) {
  return evalPredicate(PREDICADO, rowAntes, params(novoStatus, mecanica)) === true;
}

/** `true` se o clone TERIA flipado, mas foi barrado por não ser individual (vira log). */
function flipBloqueado(rowAntes, novoStatus, mecanica = true) {
  return evalPredicate(PREDICADO_BLOQUEADO, rowAntes, params(novoStatus, mecanica)) === true;
}

/** `true` se individual atendente em transição, mas barrado por persona SEM mecânica. */
function flipBloqueadoPersona(rowAntes, novoStatus, mecanica) {
  return evalPredicate(PREDICADO_PERSONA, rowAntes, params(novoStatus, mecanica)) === true;
}

/** Estado do MVS antes do fix: individual, atendente, agenda recém-conectada (pending). */
const MVS_ATENDENTE = {
  gcal_status: 'pending',
  product_type: 'individual',
  modo_atendente_enabled: true,
  personalizacao: { nome_negocio: 'MVS BARBEARIA', agenda_automatica: 'false' },
};

// ─────────────────────────────────────────────────────────────────────────────
// (a) atendente + transição pending→active ⇒ flipa
// ─────────────────────────────────────────────────────────────────────────────

test('(a) atendente com agenda validada agora: FLIPA para modo agenda', () => {
  assert.equal(flipa(MVS_ATENDENTE, 'active'), true);
});

test('(a2) flipa mesmo se só a coluna modo_atendente_enabled acusar atendente', () => {
  assert.equal(flipa({ ...MVS_ATENDENTE, personalizacao: { nome_negocio: 'x' } }, 'active'), true);
});

test('(a3) flipa mesmo se só o personalizacao acusar atendente (coluna já false)', () => {
  assert.equal(flipa({ ...MVS_ATENDENTE, modo_atendente_enabled: false }, 'active'), true);
});

test('(a4) personalizacao com boolean cru false (gravado por SQL/gestão) também flipa', () => {
  assert.equal(
    flipa(
      {
        ...MVS_ATENDENTE,
        modo_atendente_enabled: false,
        personalizacao: { agenda_automatica: false },
      },
      'active',
    ),
    true,
  );
});

test('(a5) gcal_status NULL (nunca testado) conta como transição', () => {
  assert.equal(flipa({ ...MVS_ATENDENTE, gcal_status: null }, 'active'), true);
});

test('(a6) clone que estava invalid e voltou: transição válida, flipa', () => {
  assert.equal(flipa({ ...MVS_ATENDENTE, gcal_status: 'invalid' }, 'active'), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) clone que JÁ é agenda ⇒ nada muda
// ─────────────────────────────────────────────────────────────────────────────

test('(b) clone que já é agenda (Cirilo/Samuel): NÃO flipa (no-op)', () => {
  assert.equal(
    flipa(
      {
        gcal_status: 'pending',
        product_type: 'individual',
        modo_atendente_enabled: false,
        personalizacao: { nome_negocio: 'Cirilo', agenda_automatica: 'true' },
      },
      'active',
    ),
    false,
  );
});

test('(b2) clone de agenda sem a chave agenda_automatica (ausente = agenda): NÃO flipa', () => {
  assert.equal(
    flipa(
      {
        gcal_status: 'pending',
        product_type: 'individual',
        modo_atendente_enabled: false,
        personalizacao: { nome_negocio: 'Samuel' },
      },
      'active',
    ),
    false,
  );
});

test('(b3) personalizacao NULL + coluna false: NÃO flipa (nada indica atendente)', () => {
  assert.equal(
    flipa(
      {
        gcal_status: 'pending',
        product_type: 'individual',
        modo_atendente_enabled: false,
        personalizacao: null,
      },
      'active',
    ),
    false,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) teste que FALHA ⇒ nada muda — em especial NÃO desliga agenda de ninguém
// ─────────────────────────────────────────────────────────────────────────────

test('(c) teste falho (invalid) no atendente: NÃO flipa', () => {
  assert.equal(flipa(MVS_ATENDENTE, 'invalid'), false);
});

test('(c2) teste falho num clone de AGENDA ativa: NÃO flipa (nunca o inverso)', () => {
  assert.equal(
    flipa(
      {
        gcal_status: 'active',
        product_type: 'individual',
        modo_atendente_enabled: false,
        personalizacao: { agenda_automatica: 'true' },
      },
      'invalid',
    ),
    false,
  );
});

test('(c3) a statement NUNCA escreve agenda_automatica=false nem modo_atendente_enabled=true', () => {
  // O fix é one-way: só liga. Olha só a cláusula SET (o predicado do CTE LÊ 'false',
  // isso é esperado) — nada ali pode desligar agenda nem religar o modo atendente.
  assert.doesNotMatch(SET_CLAUSE, /'false'/i, 'a escrita não pode desligar agenda_automatica');
  assert.match(SET_CLAUSE, /to_jsonb\('true'::text\)/, 'o único valor escrito é a string true');
  assert.doesNotMatch(
    SET_CLAUSE,
    /modo_atendente_enabled\s*=\s*CASE[\s\S]*?THEN\s+true/i,
    'não pode religar modo_atendente_enabled',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) re-teste de um clone já 'active' ⇒ não flipa (decisão deliberada preservada)
// ─────────────────────────────────────────────────────────────────────────────

test('(d) re-teste de clone já active que foi devolvido pra atendente: NÃO flipa', () => {
  assert.equal(flipa({ ...MVS_ATENDENTE, gcal_status: 'active' }, 'active'), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// product_type: SÓ 'individual' flipa (decisão do Bruno, 24/07)
// No estabelecimento a agenda é 1 calendarId por COLABORADOR (clone_colaboradores.gcal_*):
// validar o gcal do NÍVEL do clone não significa "a agenda passou a valer", e ligar o modo
// agenda ali pode deixar o clone com agenda ligada e nenhum calendário utilizável.
// ─────────────────────────────────────────────────────────────────────────────

const MEDUZZA = {
  gcal_status: 'pending',
  product_type: 'estabelecimento',
  modo_atendente_enabled: true,
  personalizacao: { nome_negocio: 'Meduzza', agenda_automatica: 'false' },
};

test('estabelecimento em modo atendente (Meduzza, R$150): NÃO flipa', () => {
  assert.equal(flipa(MEDUZZA, 'active'), false);
});

test('estabelecimento barrado é LOGADO (não silencioso): flip_bloqueado = true', () => {
  assert.equal(flipBloqueado(MEDUZZA, 'active'), true);
});

test('individual que flipa NÃO acende o log de bloqueio (os dois são mutuamente exclusivos)', () => {
  assert.equal(flipa(MVS_ATENDENTE, 'active'), true);
  assert.equal(flipBloqueado(MVS_ATENDENTE, 'active'), false);
});

test('estabelecimento que JÁ é agenda: nem flipa nem loga bloqueio', () => {
  const estabAgenda = { ...MEDUZZA, modo_atendente_enabled: false, personalizacao: {} };
  assert.equal(flipa(estabAgenda, 'active'), false);
  assert.equal(flipBloqueado(estabAgenda, 'active'), false);
});

test('estabelecimento com teste FALHO: nada acontece (nem log de bloqueio)', () => {
  assert.equal(flipa(MEDUZZA, 'invalid'), false);
  assert.equal(flipBloqueado(MEDUZZA, 'invalid'), false);
});

test('comparação é ESTRITA (= individual): product_type desconhecido/futuro NÃO flipa', () => {
  // product_type é NOT NULL DEFAULT 'individual' (migration 052), mas a guarda estrita
  // garante que um formato novo (ex.: 'franquia') entre como "não flipa" até ser avaliado.
  assert.equal(flipa({ ...MVS_ATENDENTE, product_type: 'franquia' }, 'active'), false);
  assert.equal(flipBloqueado({ ...MVS_ATENDENTE, product_type: 'franquia' }, 'active'), true);
  assert.match(PREDICADO, /product_type\s*=\s*'individual'/, 'a guarda tem de ser estrita');
});

// ─────────────────────────────────────────────────────────────────────────────
// GUARD da PERSONA (qa+security, 24/07): só flipa se a persona já tem a mecânica de
// agendamento (cartão + SIM + inserir_agendamento) OU cartao_mode='runtime'. Flipar um
// clone atendente cuja persona (ATENDENTE_PROMPT_TPL) NÃO tem cartão/SIM ganharia as tools
// de agenda sem a trava do SIM => bot marca sem confirmar (pior que o bug do MVS).
// `personaTemMecanica` entra como $3 (calculado em JS pelo handler).
// ─────────────────────────────────────────────────────────────────────────────

test('(persona-a) individual atendente COM mecânica ($3=true): flipa', () => {
  assert.equal(flipa(MVS_ATENDENTE, 'active', true), true);
});

test('(persona-b) individual atendente SEM mecânica ($3=false): NÃO flipa', () => {
  assert.equal(flipa(MVS_ATENDENTE, 'active', false), false);
});

test('(persona-b) o bloqueio por persona acende o motivo próprio (não silencioso)', () => {
  assert.equal(flipBloqueadoPersona(MVS_ATENDENTE, 'active', false), true);
  // e é mutuamente exclusivo com o flip e com o bloqueio de não-individual
  assert.equal(flipa(MVS_ATENDENTE, 'active', false), false);
  assert.equal(flipBloqueado(MVS_ATENDENTE, 'active', false), false);
});

test('(persona-c) cartao_mode=runtime ⇒ $3=true ⇒ flipa (mecânica vem do código)', () => {
  // O handler resolve cartao_mode='runtime' => personaTemMecanica=true ANTES da SQL; aqui
  // isso é o $3=true. Cobre o caso c pedido pela consulta.
  assert.equal(flipa(MVS_ATENDENTE, 'active', true), true);
});

test('persona sem mecânica só bloqueia INDIVIDUAL: estabelecimento vira o outro motivo', () => {
  // Meduzza (estabelecimento) sem mecânica: o motivo é nao_individual, não persona
  // (o guard de persona é product_type='individual').
  assert.equal(flipBloqueadoPersona(MEDUZZA, 'active', false), false);
  assert.equal(flipBloqueado(MEDUZZA, 'active', false), true);
});

test('o guard de persona exige $3 = TRUE no predicado do flip (sem ele, some a proteção)', () => {
  assert.match(PREDICADO, /\$3\s*=\s*TRUE/i, 'o flip precisa exigir personaTemMecanica');
  assert.match(
    PREDICADO_PERSONA,
    /\$3\s*=\s*FALSE/i,
    'o motivo do bloqueio por persona é $3 = FALSE',
  );
});

// ── End-to-end da decisão de mecânica: extractBakedCartao REAL do dist ────────
// Prova que o cálculo de personaTemMecanica (o que o handler faz em JS) separa de fato o
// ATENDENTE_PROMPT_TPL (sem mecânica) dos templates de agenda (com cartão+SIM). Importa a
// função COMPILADA (mesma que o server.js importa) — exige `npm run build --workspaces`.
const distExtract = await import(
  '../../packages/integrations/dist/prompt-builder/cartao-extract.js'
);

/** Espelha o cálculo do handler: runtime dispensa a persona; senão exige o cartão baked. */
function personaTemMecanica(cartaoMode, botPrompt) {
  if (cartaoMode === 'runtime') return true;
  return distExtract.extractBakedCartao(botPrompt ?? '').found === true;
}

// Cópia fiel do ATENDENTE_PROMPT_TPL (clone-provisioning.ts) — persona de pré-venda, SEM
// cartão/SIM/inserir_agendamento. Mantido em sync com o provisioning.
const ATENDENTE_TPL = [
  'Voce e o atendente virtual de MVS BARBEARIA e conversa com os clientes pelo WhatsApp.',
  '',
  '[SEU PAPEL AQUI]',
  '- Da as boas-vindas, explica o que MVS BARBEARIA oferece e tira as duvidas da pessoa.',
  '- Quando percebe interesse, acolhe e cuida de encaminhar pra equipe dar sequencia.',
].join('\n');

// Persona de AGENDA no formato dos templates legados (Cirilo/Samuel/mvs): seção
// [CARTAO DE CONFIRMACAO] TRAILING + inserir_agendamento + regra do SIM.
const AGENDA_TPL = [
  'Voce e o assistente virtual de uma barbearia.',
  '[FLUXO OBRIGATORIO]',
  '4. Se estiver -> apresente o CARTAO DE CONFIRMACAO e peca SIM.',
  '5. APOS o SIM: chame inserir_agendamento.',
  '',
  '[CARTAO DE CONFIRMACAO]',
  'DIA / HORARIO / SERVICO / VALOR e pede SIM.',
].join('\n');

test('(a) atendente individual com persona de AGENDA (mvs-real) => tem mecânica => flipa', () => {
  assert.equal(personaTemMecanica('baked', AGENDA_TPL), true);
  assert.equal(flipa(MVS_ATENDENTE, 'active', personaTemMecanica('baked', AGENDA_TPL)), true);
});

test('(b) atendente individual com ATENDENTE_PROMPT_TPL => SEM mecânica => NÃO flipa', () => {
  assert.equal(personaTemMecanica('baked', ATENDENTE_TPL), false);
  assert.equal(flipa(MVS_ATENDENTE, 'active', personaTemMecanica('baked', ATENDENTE_TPL)), false);
  assert.equal(
    flipBloqueadoPersona(MVS_ATENDENTE, 'active', personaTemMecanica('baked', ATENDENTE_TPL)),
    true,
  );
});

test('(c) atendente individual cartao_mode=runtime => mecânica pelo código => flipa', () => {
  // Mesmo com a persona de atendente (sem cartão baked), runtime dispensa a persona.
  assert.equal(personaTemMecanica('runtime', ATENDENTE_TPL), true);
  assert.equal(flipa(MVS_ATENDENTE, 'active', personaTemMecanica('runtime', ATENDENTE_TPL)), true);
});

test('bot_prompt NULL (clone sem linha em bot_prompt) => SEM mecânica => NÃO flipa', () => {
  assert.equal(personaTemMecanica('baked', null), false);
});

test('o handler reusa extractBakedCartao do dist e resolve cartao_mode=runtime como mecânica', () => {
  // Casa a LINHA DE CÓDIGO exata (não o comentário) — senão a asserção passaria só pela
  // menção em comentário e não guardaria a computação real (mutação "= true" escaparia).
  assert.match(
    HANDLER,
    /personaTemMecanica = extractBakedCartao\(bot_prompt \?\? ''\)\.found === true;/,
    'o guard deve reusar o detector já testado, não uma string mágica nova',
  );
  assert.match(
    HANDLER,
    /if \(cartao_mode === 'runtime'\) \{\s*personaTemMecanica = true;/,
    'runtime dispensa a persona (mecânica vem do código)',
  );
  assert.match(
    HANDLER,
    /catch \(importErr\) \{\s*\/\/[\s\S]*?personaTemMecanica = false;/,
    'import quebrado deve ser fail-closed (não flipa)',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Contrato da statement e da resposta
// ─────────────────────────────────────────────────────────────────────────────

test('flip é ATÔMICO: um único UPDATE flow_clones no handler', () => {
  const updates = sqlLiterals(HANDLER).filter((s) => /UPDATE\s+flow_clones/i.test(s));
  assert.equal(updates.length, 1, 'ler-e-escrever em 2 etapas abre janela de corrida');
  assert.match(
    SQL,
    /jsonb_set\(/,
    'agenda_automatica deve ser setado com jsonb_set na mesma statement',
  );
  assert.match(
    SQL,
    /to_jsonb\('true'::text\)/,
    "storage é STRING 'true' (convenção do personalizacao)",
  );
  assert.match(
    SQL,
    /modo_atendente_enabled\s*=\s*CASE/,
    'coluna do gate deve cair no mesmo UPDATE',
  );
  assert.match(
    SQL,
    /RETURNING[\s\S]*prev\.flip/,
    'o que é reportado tem de ser a MESMA decisão que escreveu',
  );
});

test('billing_from_agenda_enabled É LIGADO no flip (SCRUM-112); bot_prompt NÃO é tocado', () => {
  // SCRUM-112: o flip agora liga o gate billing-da-agenda na MESMA statement (Faturamento
  // nasce vivo). Só via prev.flip (nunca incondicional, nunca desligando).
  assert.match(
    SQL,
    /billing_from_agenda_enabled\s*=\s*CASE\s+WHEN\s+prev\.flip\s+THEN\s+true/i,
    'o flip deve ligar billing_from_agenda_enabled (só no flip, na mesma statement)',
  );
  assert.doesNotMatch(SQL, /bot_prompt/i, 'trocar persona de cliente é caminho separado');
});

test('o operador é avisado: resposta expõe agendaAtivada e há log [gcal]', () => {
  assert.match(HANDLER, /agendaAtivada:/, 'a resposta precisa dizer que o modo mudou');
  assert.match(
    HANDLER,
    /if \(agendaAtivada\) \{\s*console\.log\(/,
    'o log do flip só sai quando o flip acontece',
  );
  assert.match(
    HANDLER,
    /\[gcal\][^`]*AGENDA ATIVADA/i,
    'flip precisa deixar rastro no padrão [gcal]',
  );
});

test('estabelecimento barrado também é avisado: log explicando por que NÃO flipou', () => {
  assert.match(
    HANDLER,
    /flip_bloqueado === true\) \{[\s\S]*console\.log\(/,
    'o caso barrado precisa de log próprio',
  );
  assert.match(
    HANDLER,
    /\[gcal\][^`]*modo NÃO alterado[^`]*product_type/,
    'o log de bloqueio precisa dizer o motivo (product_type não individual)',
  );
});

test('persona sem mecânica é avisada: resposta expõe agendaBloqueadaPersona + log próprio', () => {
  assert.match(
    HANDLER,
    /agendaBloqueadaPersona:/,
    'a resposta precisa sinalizar que a persona não tem a mecânica (pro front avisar)',
  );
  assert.match(
    HANDLER,
    /flip_bloqueado_persona === true\) \{[\s\S]*console\.log\(/,
    'o bloqueio por persona precisa de log próprio (não silencioso)',
  );
  assert.match(
    HANDLER,
    /\[gcal\][^`]*persona SEM mecânica[^`]*inserir_agendamento/,
    'o log deve dizer o motivo: persona sem cartão/SIM/inserir_agendamento',
  );
});

test('parâmetros continuam parametrizados ($1/$2/$3) — sem interpolação', () => {
  assert.match(SQL, /\$1/);
  assert.match(SQL, /\$2/);
  assert.match(SQL, /\$3/, 'personaTemMecanica entra parametrizado, não interpolado');
  assert.doesNotMatch(SQL, /\$\{/, 'nada de template string dentro da SQL');
});

// ─────────────────────────────────────────────────────────────────────────────
// Rota irmã da MATRIZ (bot_config) — decisão consciente de NÃO aplicar o flip
// ─────────────────────────────────────────────────────────────────────────────

test('matriz (/api/bots/:slot/gcal/test) segue sem flip — matriz não tem modo atendente', () => {
  const matriz = handlerSource("app.post('/api/bots/:slot/gcal/test'");
  assert.match(matriz, /UPDATE\s+bot_config/i, 'a rota irmã opera em bot_config');
  assert.doesNotMatch(matriz, /modo_atendente_enabled/i, 'bot_config nem tem essa coluna');
  assert.doesNotMatch(
    matriz,
    /agenda_automatica/i,
    'o runtime lê o modo de flow_clones, não da matriz',
  );
});
