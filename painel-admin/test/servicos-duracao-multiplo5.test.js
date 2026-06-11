// Testes da validacao de duracao_min em PUT /api/bots/:slot e PATCH /api/clones/:id.
// Uso: node --test painel-admin/test/servicos-duracao-multiplo5.test.js
//
// Decisao do Bruno (2026-06-11): duracao de servico so aceita MULTIPLOS DE 5
// minutos (5, 10, 15, ...) — a grade de horarios da agenda anda em passos de
// 5min e duracoes fora do passo quebram a montagem dos slots livres.
//
// Estrategia: replica SO o helper validarDuracaoServico do server.js, sem
// inicializar Express + pool Postgres. Espelha o padrao de suspend-kind.test.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * Replica EXATA do helper do server.js:
 *  - duracao_min ausente/null -> permitido ("duracao a combinar", legado).
 *  - presente -> Number() (string numerica "30" passa), inteiro > 0 e % 5 === 0.
 * Retorna mensagem de erro PT-BR ou null se ok.
 */
function validarDuracaoServico(s) {
  if (s.duracao_min === undefined || s.duracao_min === null) return null;
  const nome = String(s.nome || 'servico').trim();
  const dur = Number(s.duracao_min);
  if (!Number.isInteger(dur) || dur <= 0) {
    return `servico "${nome}": duracao_min deve ser inteiro maior que zero`;
  }
  if (dur % 5 !== 0) {
    return `servico "${nome}": duracao_min deve ser multiplo de 5 minutos`;
  }
  return null;
}

test('aceita multiplos de 5 (5, 25, 30, 1440)', () => {
  for (const dur of [5, 25, 30, 1440]) {
    assert.equal(
      validarDuracaoServico({ nome: 'Corte', duracao_min: dur }),
      null,
      `duracao_min ${dur} deveria ser aceita`,
    );
  }
});

test('rejeita duracao fora do passo de 5 minutos (7, 23)', () => {
  for (const dur of [7, 23]) {
    const erro = validarDuracaoServico({ nome: 'Corte', duracao_min: dur });
    assert.match(erro, /multiplo de 5/, `duracao_min ${dur} deveria ser rejeitada`);
  }
});

test('rejeita zero, negativo e nao-inteiro', () => {
  for (const dur of [0, -5, 7.5, 'abc', Number.NaN]) {
    const erro = validarDuracaoServico({ nome: 'Corte', duracao_min: dur });
    assert.match(erro, /inteiro maior que zero/, `duracao_min ${dur} deveria ser rejeitada`);
  }
});

test('permite duracao_min ausente/null (legado "a combinar")', () => {
  assert.equal(validarDuracaoServico({ nome: 'Corte' }), null);
  assert.equal(validarDuracaoServico({ nome: 'Corte', duracao_min: null }), null);
});

test('aceita string numerica multipla de 5 (leniencia Number(), como renderServicosPrecos)', () => {
  assert.equal(validarDuracaoServico({ nome: 'Corte', duracao_min: '30' }), null);
  assert.match(validarDuracaoServico({ nome: 'Corte', duracao_min: '7' }), /multiplo de 5/);
});

test('mensagem de erro identifica o servico pelo nome', () => {
  const erro = validarDuracaoServico({ nome: 'Barba', duracao_min: 23 });
  assert.match(erro, /"Barba"/);
});
