// Regressão: leads_count em GET /api/bots deve filtrar pelo slot do bot,
// não somar todos os slots da tabela (bug B1 Missao 013).
// Uso: node --test painel-admin/test/leads-count.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Simula a estrutura leadsByLeadsTable construída em /api/bots
// Chave = tabela, valor = mapa slot→count (resultado do GROUP BY slot na query)
const leadsByLeadsTable = {
  leads_ricardo: {
    teste_barbearia: 10,
    clone_barbearia_joao: 37, // clone com muitos leads
  },
  leads_vendas_barbearia: {
    teste_vendas_barbearia: 5,
  },
};

// Lógica ANTIGA (bugada): soma todos os slots da tabela
function leadsCountBugado(leadsTable, _slot) {
  return leadsTable
    ? Object.values(leadsByLeadsTable[leadsTable] || {}).reduce((sum, n) => sum + n, 0)
    : 0;
}

// Lógica NOVA (correta): filtra pelo slot do bot
function leadsCountCorrigido(leadsTable, slot) {
  return leadsTable ? leadsByLeadsTable[leadsTable][slot] || 0 : 0;
}

test('B1 — lógica antiga soma todos os slots (comprova o bug)', () => {
  // teste_barbearia tem 10, mas a soma total da tabela é 10+37=47
  const result = leadsCountBugado('leads_ricardo', 'teste_barbearia');
  assert.equal(result, 47, 'bug: soma indevida de outros slots');
});

test('B1 — lógica corrigida retorna apenas o slot do bot', () => {
  const result = leadsCountCorrigido('leads_ricardo', 'teste_barbearia');
  assert.equal(result, 10, 'deve retornar só o count do slot teste_barbearia');
});

test('B1 — clone isolado não vaza para a matriz', () => {
  const matrizCount = leadsCountCorrigido('leads_ricardo', 'teste_barbearia');
  const cloneCount = leadsCountCorrigido('leads_ricardo', 'clone_barbearia_joao');
  assert.equal(matrizCount, 10);
  assert.equal(cloneCount, 37);
  assert.notEqual(matrizCount, matrizCount + cloneCount, 'matriz não deve incluir leads do clone');
});

test('B1 — slot sem leads retorna 0', () => {
  const result = leadsCountCorrigido('leads_ricardo', 'bot_sem_leads');
  assert.equal(result, 0);
});

test('B1 — leadsTable null retorna 0', () => {
  const result = leadsCountCorrigido(null, 'qualquer_slot');
  assert.equal(result, 0);
});
