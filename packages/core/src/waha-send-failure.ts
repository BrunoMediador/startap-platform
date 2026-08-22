/**
 * Taxonomia de falha de envio WAHA (SCRUM-53 → movida pro core em SCRUM-59).
 *
 * FONTE ÚNICA (pura, sem deps): usada pelo worker (client-disconnect-notify/monitor) E pelo
 * apps/api (owner-alert/client-alert). O rollback do carimbo "avisado"/cooldown NÃO pode
 * disparar em QUALQUER falha: um TIMEOUT não prova não-entrega. Numa WAHA cronicamente lenta
 * (> timeout mas ENTREGANDO), reverter a cada tick reenviaria a mesma mensagem a um PAGANTE =
 * risco de ban. Então só revertemos em falha DEFINITIVA (temos certeza de que NÃO saiu); falha
 * AMBÍGUA (pode ter entregue) MANTÉM o carimbo/cooldown, preferindo perder 1 aviso a duplicar.
 *
 * DEFINITIVA (rollback):
 *  - HTTP 404 no /api/sendText  → sessão/chat não encontrado (não saiu);
 *  - HTTP 422 no /api/sendText  → sessão não-WORKING/FAILED (WAHA recusou o envio) — é o caso do
 *                                 incidente real (sessão morta); o fix do "alerta perdido" segue coberto;
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
  // a mensagem como "WAHA /api/sendText -> HTTP <status>" (sem body do provedor).
  if (/HTTP 404\b/.test(msg)) return true;
  if (/HTTP 422\b/.test(msg)) return true;

  // Defesa textual (independente do status): sessão inexistente / status inválido.
  if (/session not found|session status/i.test(msg)) return true;

  return false; // default conservador: AMBÍGUO → mantém o carimbo (não arrisca duplicar ao cliente)
}

/**
 * Envia com deadline SEM cortar a resposta de erro que chega colada no deadline (SCRUM-126).
 *
 * PROBLEMA que resolve: o padrão ingênuo `Promise.race([send(), timeout(deadline)])` DESCARTA o
 * resultado do envio quando o timeout vence a corrida — mesmo que o WAHA fosse responder um erro
 * DEFINITIVO (422 = sessão FAILED) ~20ms depois. Aí TODA falha vira "timeout" (ambígua), o carimbo
 * nunca sofre rollback e o alerta se perde em silêncio (incidente Cirilo: alert_count 1→4, zero
 * entrega). O timeout ganhava por milissegundos e mascarava um 422 CLARO.
 *
 * FIX (classifica pelo STATUS, não pela corrida): ao bater o `deadlineMs` sem a resposta ter
 * chegado, dá uma janela CURTA e LIMITADA (`settleGraceMs`) pra o envio assentar. Se assentar
 * (resolve = entregou; reject = classifica pelo erro real, ex.: HTTP 422 → definitivo), usa ESSE
 * desfecho. Só quando NÃO chega resposta nenhuma dentro de deadline+grace é que lança
 * `sendText timeout` (falta-de-resposta genuína = rede caiu/pendurou = AMBÍGUO, mantém o carimbo).
 *
 * Trade-off anti-duplicação PRESERVADO: rede realmente muda/pendurada nunca assenta → segue
 * ambíguo → não reenvia (não duplica pra pagante). O grace só captura uma resposta HTTP que pousa
 * em volta do deadline; não espera indefinidamente (teto = deadlineMs + settleGraceMs).
 *
 * Puro (Promises + timers, sem deps): fonte única reusável por todos os caminhos de alerta que hoje
 * repetem o `Promise.race` inline (monitor, client-alert, client-disconnect-notify, reminders,
 * bot-detect). Nesta entrega só o monitor é fiado (escopo SCRUM-126).
 */
export async function sendWithSettleTimeout<T>(
  send: () => Promise<T>,
  opts: { deadlineMs: number; settleGraceMs: number },
): Promise<T> {
  let settled: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  // Anexa handlers JÁ — captura o desfecho (inclusive uma rejeição tardia) sem virar unhandled
  // rejection e deixa o valor disponível pra classificação mesmo se o deadline "vencer" a corrida.
  const done = send().then(
    (value) => {
      settled = { ok: true, value };
    },
    (error) => {
      settled = { ok: false, error };
    },
  );

  // Fase 1 — deadline normal (caminho saudável responde bem antes).
  await settleOrDelay(done, opts.deadlineMs);
  // Fase 2 — bateu o deadline sem assentar: janela LIMITADA pra uma resposta que pousa em volta do
  // deadline (o "422 a deadline+20ms"). É isto que deixa o erro ser classificado pelo STATUS em vez
  // de virar timeout genérico. Resposta-nenhuma (rede caiu) nunca assenta → o grace escoa.
  if (!settled) await settleOrDelay(done, opts.settleGraceMs);

  if (settled) {
    if (settled.ok) return settled.value;
    throw settled.error; // classifica pelo erro real (status HTTP do WAHA, ECONN*, …)
  }
  // Nenhuma resposta dentro de deadline+grace → AMBÍGUO de verdade (o chamador mantém o carimbo).
  throw new Error('sendText timeout');
}

/** Resolve quando `done` assenta OU quando `ms` escoa — o que vier primeiro. `done` nunca rejeita
 *  (os handlers acima engolem), então isto nunca vira unhandled rejection. Limpa o timer no caminho
 *  feliz pra não deixar timer pendurado (importante sob fake timers no teste). */
function settleOrDelay(done: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    done.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
