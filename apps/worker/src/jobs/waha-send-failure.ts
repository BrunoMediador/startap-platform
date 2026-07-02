/**
 * Taxonomia de falha de envio WAHA (SCRUM-53, review security P2 + arquiteto).
 *
 * O rollback do carimbo "avisado" (reserveCooldown/applyTransition) NÃO pode disparar em QUALQUER
 * falha: um TIMEOUT não prova não-entrega. Numa WAHA cronicamente lenta (> SEND_TIMEOUT_MS mas
 * ENTREGANDO), reverter a cada ciclo reenviaria a mesma mensagem a um PAGANTE a cada tick (~180
 * em 6h) = risco de ban. Então só revertemos em falha DEFINITIVA (temos certeza de que NÃO saiu);
 * falha AMBÍGUA (pode ter entregue) MANTÉM o carimbo/cooldown (= comportamento pré-PR pra esses
 * casos), preferindo perder 1 aviso a duplicar pro cliente.
 *
 * DEFINITIVA (rollback):
 *  - HTTP 404 no /api/sendText  → sessão/chat não encontrado (não saiu);
 *  - HTTP 422 no /api/sendText  → sessão não-WORKING/FAILED (WAHA recusou o envio) — é o caso do
 *                                 incidente real (ALERTAS morta); o fix do "alerta perdido" segue coberto;
 *  - ECONNREFUSED / ENOTFOUND   → nem conectou no WAHA (não saiu).
 *
 * AMBÍGUA (mantém carimbo): timeout do Promise.race, 5xx genérico, ECONNRESET, erro desconhecido.
 * Default CONSERVADOR: o que não casar EXPLICITAMENTE com um padrão definitivo é ambíguo.
 */

/** Extrai códigos de erro de rede (err.code e err.cause.code — undici põe o code no cause). */
function networkCodes(err: unknown): string[] {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  return [e?.code, e?.cause?.code].filter((c): c is string => typeof c === 'string');
}

/**
 * true SÓ quando temos certeza de que a mensagem NÃO saiu (falha definitiva) — único caso em que
 * é seguro reverter o carimbo/cooldown e re-tentar. Timeout/5xx/desconhecido → false (ambíguo).
 */
export function isDefinitiveNonDelivery(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);

  // Timeout do nosso Promise.race: AMBÍGUO (pode ter entregue) — nunca definitivo. Checa antes de
  // tudo pra que qualquer mensagem com "timeout" caia no lado seguro (mantém carimbo).
  if (/timeout/i.test(msg)) return false;

  // Nunca chegou ao WAHA (fetch falhou na conexão) → definitivamente não saiu.
  const codes = networkCodes(err);
  if (codes.some((c) => c === 'ECONNREFUSED' || c === 'ENOTFOUND')) return true;
  if (/\bECONNREFUSED\b|\bENOTFOUND\b/.test(msg)) return true;

  // HTTP do WAHA no /api/sendText: 404 (sessão/chat inexistente) e 422 (sessão não-WORKING/FAILED)
  // provam que não saiu. 5xx e demais status → AMBÍGUO (pode ter processado). O client.ts formata
  // a mensagem como "WAHA /api/sendText -> HTTP <status>: <body>".
  if (/HTTP 404\b/.test(msg)) return true;
  if (/HTTP 422\b/.test(msg)) return true;

  // Defesa textual (independente do status): sessão inexistente / status inválido.
  if (/session not found|session status/i.test(msg)) return true;

  return false; // default conservador: AMBÍGUO → mantém o carimbo (não arrisca duplicar ao cliente)
}
