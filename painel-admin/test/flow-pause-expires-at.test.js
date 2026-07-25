// Regressão SCRUM-114: pausa pelo painel legado (gestão) não zerava expires_at.
// Uso: node --test painel-admin/test/flow-pause-expires-at.test.js
//
// Bug (mesma classe do SCRUM-86, que consertou o caminho do PORTAL):
//   1. O upsert de pausa (POST /api/flows/:flowId/pauses) fazia ON CONFLICT DO UPDATE
//      SEM `expires_at = NULL`. Ao pausar pela gestão SOBRE uma linha human_reply com TTL
//      já vencido, a pausa promovida HERDAVA o expires_at morto → some do /pausas (o
//      runtime isFlowPaused ignora expiradas) E o bot volta a responder um contato
//      pausado de propósito.
//   2. A listagem (GET /api/flows/:flowId/pauses) filtrava só por `active = true`, sem
//      validade → o operador VIA uma pausa inerte como se estivesse ativa.
//
// Fix: (1) upsert seta expires_at = NULL (pausa manual do operador = indeterminada);
//      (2) listagem filtra por validade, espelhando isFlowPaused (packages/db pausa.ts).
//
// Estratégia (mesma lição do PR #491): o teste que REALMENTE guarda o fix LÊ O SOURCE,
// extrai a SQL e avalia o predicado — em vez de replicar a rota (réplica passa nos dois
// mundos e não guarda nada). O container copia só server.js+public/, então o SQL vive
// inline no server.js e é lá que checamos. Extra: um predicado JS emula a semântica do
// WHERE de validade pra documentar a intenção com casos concretos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = readFileSync(join(__dirname, '..', 'server.js'), 'utf8');

// Normaliza whitespace pra assertion robusta a indentação/quebra de linha.
const norm = (s) => s.replace(/\s+/g, ' ').trim();

// Recorta o bloco textual entre um marcador inicial e um final (inclusivo do início).
function slice(src, startNeedle, endNeedle) {
  const start = src.indexOf(startNeedle);
  assert.ok(start >= 0, `marcador inicial não encontrado no source: ${startNeedle}`);
  const end = src.indexOf(endNeedle, start);
  assert.ok(end > start, `marcador final não encontrado após o início: ${endNeedle}`);
  return src.slice(start, end);
}

// ── Fix 1: upsert do POST zera o TTL no ON CONFLICT DO UPDATE ────────────────
test('upsert de pausa (ON CONFLICT DO UPDATE) seta expires_at = NULL', () => {
  const block = slice(SERVER_SRC, 'INSERT INTO flow_pauses', 'RETURNING flow_id');
  const flat = norm(block);

  // O bloco tem que ser um upsert de promoção (DO UPDATE), não DO NOTHING.
  assert.ok(
    /ON CONFLICT \(flow_id, telefone\) DO UPDATE/.test(flat),
    'esperava ON CONFLICT (flow_id, telefone) DO UPDATE',
  );

  // O ponto do fix: o DO UPDATE tem que ZERAR o TTL explicitamente. Herdar o
  // expires_at pré-existente é a classe de bug "estado misto" do SCRUM-86.
  assert.ok(
    /expires_at\s*=\s*NULL/i.test(block),
    'REGRESSÃO SCRUM-114: o upsert não zera expires_at no DO UPDATE — pausa manual ' +
      'herda TTL vencido de human_reply (estado misto: some do painel + bot volta a responder)',
  );
});

// ── Fix 2: listagem do GET filtra por validade (não lista pausa vencida) ─────
test('listagem GET /api/flows/:flowId/pauses filtra pausas expiradas', () => {
  // Recorta o handler do GET (do app.get até o res.json da resposta).
  const handler = slice(
    SERVER_SRC,
    "app.get('/api/flows/:flowId/pauses'",
    'res.json({ flow_id: flowId, count',
  );
  const flat = norm(handler);

  // O ramo default (sem includeInactive) tem que exigir active E validade.
  assert.ok(
    /active\s*=\s*true\s+AND\s+\(expires_at\s+IS\s+NULL\s+OR\s+expires_at\s*>\s*NOW\(\)\)/i.test(flat),
    'REGRESSÃO SCRUM-114: a listagem não filtra por validade — operador vê pausa inerte ' +
      '(human_reply vencida) como ativa. Espere: active = true AND (expires_at IS NULL OR expires_at > NOW())',
  );
});

// ── Predicado de validade (documenta a semântica do WHERE com casos concretos) ──
// Emula `active = true AND (expires_at IS NULL OR expires_at > NOW())`.
function isActivePause(row, now = Date.now()) {
  if (!row.active) return false;
  if (row.expires_at == null) return true; // permanente
  return new Date(row.expires_at).getTime() > now;
}

test('predicado de validade: exclui vencida, inclui permanente e TTL futuro', () => {
  const now = Date.parse('2026-07-24T12:00:00Z');
  const permanente = { active: true, expires_at: null, source: 'manual-painel' };
  const vencida = { active: true, expires_at: '2026-07-01T00:00:00Z', source: 'human_reply' };
  const futura = { active: true, expires_at: '2026-07-24T13:00:00Z', source: 'human_reply' };
  const inativa = { active: false, expires_at: null, source: 'manual-painel' };

  assert.equal(isActivePause(permanente, now), true, 'permanente deve listar');
  assert.equal(isActivePause(vencida, now), false, 'human_reply vencida NÃO deve listar');
  assert.equal(isActivePause(futura, now), true, 'TTL futuro deve listar');
  assert.equal(isActivePause(inativa, now), false, 'inativa NÃO deve listar');
});
