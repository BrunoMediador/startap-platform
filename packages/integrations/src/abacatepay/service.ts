/**
 * Servico de geracao/obtencao idempotente de cobranca PIX por (slot, ciclo).
 *
 * ADR 0013 / F1. Reune o cliente AbacatePay (@startap/integrations) com a persistencia
 * (@startap/db billing_charges). NAO expoe endpoint publico — e chamavel internamente
 * (F4 cron, scripts de smoke, testes). O portal do cliente e F3.
 *
 * Idempotencia (controle do threat-model): advisory lock por slot + recheck exato do
 * ciclo. A migration 043 removeu o UNIQUE (slot, cycle); o lock (reobtido em duas fases
 * curtas — ver OUTBOX abaixo) serializa recheck e persistencia para duas chamadas
 * concorrentes gerarem 1 PIX.
 *
 * Snapshot do valor: amountCents vem de client_billing.amount_cents NO MOMENTO da
 * geracao e e congelado em billing_charges.amount_cents. Pagamento (F2) confere
 * contra o snapshot, nunca contra client_billing em tempo de pagamento.
 *
 * OUTBOX DE CHAMADA AO GATEWAY (SCRUM-173, ADR 0039, migration 081): antes desta versao,
 * o INSERT da linha 'pending' e o POST ao gateway rodavam na MESMA transacao do advisory
 * lock. Se o gateway CONFIRMAVA mas a resposta se perdia (timeout), o throw abortava a
 * transacao, desfazia o INSERT, e o retry seguinte criava uma SEGUNDA cobranca real (sem
 * nenhum rastro local do que aconteceu). Agora `callGatewayWithOutbox` faz: (1) CLAIM
 * ATOMICO — UPDATE condicional de uma unica statement (`claimGatewayCall`) marca
 * gateway_call_state='calling' e COMMITA antes do POST, so se a linha estiver livre
 * (WHERE checa e seta na MESMA operacao — sem check-then-act, sem TOCTOU entre processos
 * distintos); (2) chama o gateway FORA de transacao; (3) reabre o lock numa transacao
 * NOVA pra persistir o resultado (attach/reissue) e fechar o estado em 'done'. Claim
 * perdido (0 linhas afetadas) -> PixChargeGatewayInFlightError, SEM chamar o gateway —
 * trata como ocupado, igual ao advisory lock. A comparacao de timeout de ambiguidade
 * (GATEWAY_CALL_AMBIGUOUS_TIMEOUT_MS) roda com NOW() do POSTGRES dentro do UPDATE, nao
 * com Date do processo Node — elimina dependencia de relogio sincronizado entre
 * portal-api e worker (podem rodar em instancias distintas). LIMITACAO ACEITA: a
 * AbacatePay nao expoe busca por externalId (so create/check-by-id/simulate — ver README
 * "Endpoints confirmados"), entao apos o timeout de ambiguidade nao ha como CONFIRMAR se
 * a tentativa anterior de fato criou uma cobranca no gateway; o pior caso residual e uma
 * cobranca 'pending' orfa la (sem duplo-credito: o webhook casa por external_id/SCRUM-139
 * e nunca reescreve 'paid'; o outcome 'orphan' loga em WARN com o valor pago pra permitir
 * deteccao manual — ver billing-webhook-events.ts).
 *
 * LEITURA DE PRODUTO vs LEITURA DE GERACAO (F1, achado do security): uma linha presa em
 * 'calling' (outbox em voo/orfao, sem br_code) NAO pode aparecer como "cobranca ativa" pro
 * PORTAL (o cliente veria um estado sem QR, sem conseguir pagar — pior que a duplicacao
 * rara que este outbox evita). Mas a fase de GERACAO precisa enxergar essa MESMA linha pra
 * REAPROVEITAR (reissue) em vez de inserir uma linha nova. Por isso duas funcoes de leitura
 * distintas em billing-charges.ts: `getActivePendingCharge` (produto, exige br_code IS NOT
 * NULL) e `getResumableChargeForSlot` (geracao, sem essa exigencia).
 */
import { logger } from '@startap/core/logger';
import { type BillingChargeRow, billingCharges } from '@startap/db';
import type { AbacatePayClient, PixCharge } from './client.js';

const log = logger.child({ module: 'abacatepay-service' });

/** Validade default do PIX: 3 dias (em segundos). Ajustavel pelo chamador. */
const DEFAULT_EXPIRES_IN_SEC = 3 * 24 * 60 * 60;
/** AbacatePay limita description (v1: 37 chars). Mantemos curto e seguro. */
const DESCRIPTION_MAX = 37;
/**
 * Margem de seguranca pra considerar um PIX "ainda valido": so reusamos a cobranca
 * pendente se faltar MAIS que isso pra expirar. Evita devolver ao cliente um QR que
 * expira nos proximos segundos (clock skew + tempo de pagar). 60s.
 */
const VALID_MARGIN_MS = 60_000;
const billingSingleFlights = new Map<string, Promise<EnsureChargeResult>>();

/** Coalesce concorrencia local antes de qualquer checkout do pool. */
function withBillingSingleFlight(
  slot: string,
  operation: () => Promise<EnsureChargeResult>,
): Promise<EnsureChargeResult> {
  const running = billingSingleFlights.get(slot);
  if (running) return running;

  const pending = operation();
  billingSingleFlights.set(slot, pending);
  void pending
    .finally(() => {
      if (billingSingleFlights.get(slot) === pending) billingSingleFlights.delete(slot);
    })
    .catch(() => {});
  return pending;
}

/**
 * true se a cobranca pendente ainda da pra pagar: tem validade conhecida e ela esta
 * no futuro com a margem de seguranca. Sem expires_at (validade desconhecida) -> NAO
 * e considerada valida (forca reemissao por seguranca).
 */
function isChargeStillValid(charge: BillingChargeRow, now: Date): boolean {
  if (!charge.expires_at) return false;
  return charge.expires_at.getTime() - now.getTime() > VALID_MARGIN_MS;
}

export interface EnsureChargeInput {
  slot: string;
  cycle: string; // 'YYYY-MM'
  /** Snapshot do valor do ciclo, em CENTAVOS. Vem de client_billing.amount_cents. */
  amountCents: number;
  /** Texto curto exibido no PIX. Default 'Mensalidade {cycle}'. */
  description?: string;
  expiresInSec?: number;
  /**
   * Se a cobranca pendente ja existente estiver EXPIRADA (ou sem validade conhecida),
   * REEMITE no gateway reusando a MESMA linha (slot, cycle) — novo abacate_charge_id /
   * br_code / expires_at, status volta a 'pending'. Default false (comportamento legado:
   * reusa a linha existente como esta). O portal (F3) liga isso pra o cliente sempre ver
   * um QR pagavel sem precisar gerar manualmente.
   */
  reissueIfExpired?: boolean;
}

export interface EnsureChargeResult {
  charge: BillingChargeRow;
  /** true se gerou no gateway agora (linha nova ou reemissao); false se ja existia (idempotencia). */
  created: boolean;
  /** true SO quando reemitiu por expiracao reusando a linha existente (slot, cycle). */
  reissued: boolean;
}

/**
 * Garante UMA cobranca PIX por (slot, ciclo). Cria no AbacatePay e persiste se ainda
 * nao existir; se ja existir, retorna a existente sem chamar o gateway.
 *
 * Casos de borda tratados (sempre REUSANDO a linha mais recente do slot/ciclo):
 *   - Linha 'pending' SEM dados do gateway (geracao anterior inseriu mas falhou na API):
 *     completa a chamada ao gateway agora.
 *   - Linha 'pending'/'expired' com PIX EXPIRADO e `reissueIfExpired`: REEMITE no gateway
 *     e sobrescreve a MESMA linha (novo id/br_code/expires_at, status volta 'pending').
 *   - Linha 'paid': retorna como esta (NUNCA reescreve cobranca paga — invariante C2).
 */
export async function ensurePixChargeForCycle(
  abacate: AbacatePayClient,
  input: EnsureChargeInput,
  now: Date = new Date(),
): Promise<EnsureChargeResult> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error(
      `ensurePixChargeForCycle: amountCents invalido (${input.amountCents}) — esperado inteiro > 0`,
    );
  }

  return withBillingSingleFlight(input.slot, async () => {
    // Fase 1 (transacao propria, sob o lock): recheck + insere-se-ausente. Retorna so a
    // linha e a decisao — NENHUMA chamada ao gateway acontece aqui (SCRUM-173: o POST sai
    // da transacao do INSERT, ver callGatewayWithOutbox).
    const { row, created } = await billingCharges.withBillingSlotLock(
      input.slot,
      async (client) => {
        const existing = await billingCharges.getCharge(input.slot, input.cycle, client);
        const isNew = existing === null;
        const r =
          existing ??
          (await billingCharges.insertPendingCharge(client, {
            slot: input.slot,
            cycle: input.cycle,
            externalId: `${input.slot}-${input.cycle}`,
            amountCents: input.amountCents,
          }));
        return { row: r, created: isNew };
      },
    );

    // Linha ja existente com cobranca no gateway: decide reuso / reemissao / paga.
    if (!created && row.abacate_charge_id) {
      // Paga: nunca mexe. O portal mostra "pago".
      if (row.status === 'paid') {
        log.info({ slot: input.slot, cycle: input.cycle }, 'cobranca ja paga — reuso');
        return { charge: row, created: false, reissued: false };
      }

      // Pendente e AINDA valida (validade no futuro com margem): reusa, nao chama gateway.
      if (isChargeStillValid(row, now)) {
        log.info({ slot: input.slot, cycle: input.cycle }, 'cobranca pendente valida — reuso');
        return { charge: row, created: false, reissued: false };
      }

      // Pendente porem EXPIRADA. Sem reissue: mantem o comportamento legado (reusa como esta).
      if (!input.reissueIfExpired) {
        log.info(
          { slot: input.slot, cycle: input.cycle },
          'cobranca expirada mas reissue desligado — reuso',
        );
        return { charge: row, created: false, reissued: false };
      }

      // Pendente EXPIRADA + reissue: reemite no gateway e sobrescreve a MESMA linha (outbox).
      const reissuedRow = await callGatewayWithOutbox(abacate, input, row, (client, pix) =>
        billingCharges.reissueGatewayDataById(client, {
          id: row.id,
          abacateChargeId: pix.id,
          brCode: pix.brCode,
          brCodeBase64: pix.brCodeBase64,
          expiresAt: pix.expiresAt ? new Date(pix.expiresAt) : null,
        }),
      );
      log.info(
        { slot: input.slot, cycle: input.cycle, abacateChargeId: reissuedRow.abacate_charge_id },
        'cobranca PIX expirada — reemitida no gateway (mesma linha)',
      );
      return { charge: reissuedRow, created: true, reissued: true };
    }

    // Linha existe mas sem dados do gateway (nova, ou geracao anterior falhou na API):
    // completa a chamada ao AbacatePay via outbox e persiste pela identidade imutavel `id`.
    const updated = await callGatewayWithOutbox(abacate, input, row, (client, pix) =>
      billingCharges.attachGatewayDataById(client, {
        id: row.id,
        abacateChargeId: pix.id,
        brCode: pix.brCode,
        brCodeBase64: pix.brCodeBase64,
        expiresAt: pix.expiresAt ? new Date(pix.expiresAt) : null,
      }),
    );

    log.info(
      { slot: input.slot, cycle: input.cycle, abacateChargeId: updated.abacate_charge_id },
      'cobranca PIX gerada no gateway',
    );

    return { charge: updated, created: true, reissued: false };
  });
}

/**
 * Chama createPixCharge usando SEMPRE o snapshot ja gravado na linha (row.amount_cents)
 * — nunca re-le client_billing aqui. Centraliza description/expiresIn pros 3 caminhos
 * (criar, completar, reemitir).
 */
function callGateway(abacate: AbacatePayClient, input: EnsureChargeInput, row: BillingChargeRow) {
  const description = (input.description ?? `Mensalidade ${input.cycle}`).slice(0, DESCRIPTION_MAX);
  return abacate.createPixCharge({
    slot: input.slot,
    cycle: input.cycle,
    amountCents: row.amount_cents,
    description,
    expiresInSec: input.expiresInSec ?? DEFAULT_EXPIRES_IN_SEC,
  });
}

/**
 * OUTBOX (SCRUM-173, ADR 0039): chama o gateway e persiste o resultado SEM manter o
 * INSERT pendente na mesma transacao do POST. Ver comentario de topo do arquivo.
 *
 * Pre-condicao: `row` foi lida/criada DENTRO da transacao do advisory lock atual (o
 * caller esta em `withBillingSlotLock`), mas este helper faz o proprio commit
 * intermediario ANTES do gateway — por isso reabre o lock de novo para a fase de
 * persistencia final.
 *
 * ⚠️ CORRECAO DE COMENTARIO FALSO (F2, achado do security): uma versao anterior deste
 * comentario afirmava que o claim rodava "sob o MESMO advisory lock, serializando com
 * outras tentativas do slot". ISSO E FALSO. `withBillingSlotLock` usa
 * `pg_try_advisory_xact_lock`, que e liberado no COMMIT — entre o commit da fase 1 (que
 * trouxe `row`) e a chamada a este helper, o slot esta DESTRAVADO. O advisory lock aqui
 * SERVE PRA OUTRA COISA (serializar o par recheck+insert da fase 1, invariante "1
 * pending/slot"), NAO pra impedir duas chamadas concorrentes ao gateway. Quem impede a
 * corrida real e o CLAIM ATOMICO abaixo (`claimGatewayCall`, UPDATE condicional de uma
 * unica statement — Postgres serializa por row-level lock implicito do proprio UPDATE,
 * nao pelo advisory lock). portal-api e worker sao processos separados; o
 * `withBillingSingleFlight` (Map in-process) NAO os coordena.
 */
async function callGatewayWithOutbox(
  abacate: AbacatePayClient,
  input: EnsureChargeInput,
  row: BillingChargeRow,
  persist: (client: import('pg').PoolClient, pix: PixCharge) => Promise<BillingChargeRow | null>,
): Promise<BillingChargeRow> {
  // Passo 1: CLAIM ATOMICO — marca 'calling' e COMMITA numa transacao propria, ANTES do
  // POST. 0 linhas afetadas = outro processo/tentativa ja reivindicou (ou a cobranca ja
  // esta 'paid') -> PixChargeGatewayInFlightError SEM chamar o gateway. O relogio usado
  // e o do BANCO (NOW() dentro do UPDATE), nao o do processo Node — elimina dependencia
  // de clock sincronizado entre instancias (P2 do QA).
  const claimed = await billingCharges.withBillingSlotLock(input.slot, (client) =>
    billingCharges.claimGatewayCall(client, row.id),
  );
  if (!claimed) {
    throw new billingCharges.PixChargeGatewayInFlightError(input.slot, row.id);
  }

  // Passo 2: chama o gateway FORA de qualquer transacao de banco. Se lancar (timeout,
  // erro), a linha PERMANECE 'calling' — e o rastro que o retry seguinte usa para nao
  // criar uma segunda cobranca as cegas.
  const pix = await callGateway(abacate, input, row);

  // Passo 3: reabre o lock numa transacao NOVA so pra persistir o resultado e fechar o
  // outbox ('done', dentro de attachGatewayDataById/reissueGatewayDataById).
  const updated = await billingCharges.withBillingSlotLock(input.slot, (client) =>
    persist(client, pix),
  );

  return updated ?? row;
}

// ─── Modelo por DATA DE VENCIMENTO (ADR 0014) ──────────────────────────────────

export interface EnsureChargeForSlotInput {
  slot: string;
  /** due_period 'YYYY-MM-DD' (a next_due_date vigente) — vira o `cycle` da linha nova. */
  duePeriod: string;
  /** Snapshot do valor em CENTAVOS (de client_billing.amount_cents). */
  amountCents: number;
  /** Texto curto exibido no PIX. Default 'Mensalidade'. */
  description?: string;
  expiresInSec?: number;
  /**
   * Janela de REEMISSAO ANTECIPADA em ms (SCRUM-124). Uma pending cuja validade cai DENTRO
   * de [now, now+reissueAheadMs] e tratada como "precisa reemitir" — a proxima cobranca
   * nasce ANTES da atual expirar. Reemite a MESMA linha (idempotente, 1 pending/slot — NAO
   * cria 2a cobranca), MAS abandona o abacate_charge_id antigo (QR velho segue pagavel). O
   * vetor de "pagamento orfao no QR velho" ja esta FECHADO pelo FALLBACK por external_id no
   * webhook (SCRUM-139, PR #497): o pagamento do QR velho casa a linha 'pending' mais
   * recente por external_id e credita sem orfao/duplo-credito. Por isso o cron liga
   * (BILLING_REISSUE_AHEAD_MIN default 120 no config). Default 0 aqui = OFF (legado: so
   * reemite ja expirada) — o portal (geracao sob demanda) mantem 0.
   */
  reissueAheadMs?: number;
}

/**
 * Garante UMA cobranca PIX ATIVA por slot no modelo por data (ADR 0014). NAO usa
 * (slot, cycle)/UNIQUE: a cobranca ativa e a `pending` nao-expirada mais recente, e a
 * invariante "1 pending/slot" e garantida por ADVISORY LOCK + recheck na transacao.
 *
 * Caminhos (sempre sob o lock por slot — serializa duas abas/dois cliques):
 *   - Existe pending AINDA VALIDA -> REUSA (idempotencia). Nao chama o gateway.
 *   - Existe pending EXPIRADA (ou sem validade conhecida) -> REEMITE reusando a MESMA
 *     linha (por id), novo abacate_charge_id/br_code/expires_at, status volta 'pending'.
 *   - NAO existe pending valida -> INSERE linha NOVA (cycle=duePeriod), chama o gateway e
 *     attach por id.
 *
 * Pre-condicao: o chamador (portal/cron) JA checou a janela (computeBillingState) e o
 * valor > 0. Este servico NAO decide janela — so materializa a cobranca ativa.
 *
 * O gateway (rede) e chamado FORA da transacao do lock (SCRUM-173, outbox — ver
 * callGatewayWithOutbox no topo do arquivo): o lock e reobtido em duas transacoes curtas
 * (marca 'calling' / persiste resultado), nunca segura uma conexao do pool durante o POST.
 */
export async function ensurePixChargeForSlot(
  abacate: AbacatePayClient,
  input: EnsureChargeForSlotInput,
  now: Date = new Date(),
): Promise<EnsureChargeResult> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error(
      `ensurePixChargeForSlot: amountCents invalido (${input.amountCents}) — esperado inteiro > 0`,
    );
  }

  return withBillingSingleFlight(input.slot, async () => {
    // Fase 1 (transacao propria, sob o lock): recheck + decisao + insere-se-preciso. NENHUMA
    // chamada ao gateway acontece aqui (SCRUM-173: o POST sai da transacao, ver
    // callGatewayWithOutbox).
    const phase1 = await billingCharges.withBillingSlotLock(input.slot, async (client) => {
      // 1) Recheck sob o lock: ja existe uma pending nao-expirada RESUMIVEL? LEITURA DE
      // GERACAO (ADR 0039, SCRUM-173 F1) — usa getResumableChargeForSlot (SEM exigir
      // br_code), nunca getActivePendingCharge (essa e a leitura de PRODUTO do portal).
      // Isso garante que uma linha orfa presa em gateway_call_state='calling' (outbox em
      // voo/travado, sem br_code) seja REAPROVEITADA aqui em vez de gerar uma linha NOVA —
      // e exatamente essa reutilizacao que evita a segunda cobranca real no gateway. O
      // filtro do read usa o `now` REAL (expires_at > now): idempotencia intacta, nunca
      // enxerga uma linha ja-expirada como ativa.
      const active = await billingCharges.getResumableChargeForSlot(input.slot, now, client);

      if (active) {
        // Horizonte da decisao de validade: agora + janela de reemissao antecipada. Uma
        // pending que expira DENTRO da proxima janela de execucao ja e reemitida (reusando a
        // MESMA linha), pra proxima cobranca nascer ANTES da atual expirar — sem gap sem PIX
        // (SCRUM-124). reissueAheadMs=0 (default/portal) => horizonte == agora (legado).
        const aheadMs = input.reissueAheadMs && input.reissueAheadMs > 0 ? input.reissueAheadMs : 0;
        const decisionAt = aheadMs > 0 ? new Date(now.getTime() + aheadMs) : now;
        if (isChargeStillValid(active, decisionAt)) {
          log.info({ slot: input.slot, chargeId: active.id }, 'cobranca ativa valida — reuso');
          return { kind: 'reuse' as const, row: active };
        }
        // Pending porem expirada/sem validade: precisa reemitir (fase 2, fora daqui).
        return { kind: 'reissue' as const, row: active };
      }

      // 2) Sem pending valida: insere linha NOVA (cycle = due_period). Chamada ao gateway
      // acontece na fase 2.
      const externalId = `${input.slot}-${input.duePeriod}`;
      const row = await billingCharges.insertPendingCharge(client, {
        slot: input.slot,
        cycle: input.duePeriod,
        externalId,
        amountCents: input.amountCents,
      });
      return { kind: 'create' as const, row };
    });

    if (phase1.kind === 'reuse') {
      return { charge: phase1.row, created: false, reissued: false };
    }

    const active = phase1.row;
    const legacyInput: EnsureChargeInput = {
      slot: input.slot,
      cycle: active.cycle,
      amountCents: active.amount_cents,
      description: input.description,
      expiresInSec: input.expiresInSec,
    };

    if (phase1.kind === 'reissue') {
      const reissued = await callGatewayWithOutbox(abacate, legacyInput, active, (client, pix) =>
        billingCharges.reissueGatewayDataById(client, {
          id: active.id,
          abacateChargeId: pix.id,
          brCode: pix.brCode,
          brCodeBase64: pix.brCodeBase64,
          expiresAt: pix.expiresAt ? new Date(pix.expiresAt) : null,
        }),
      );
      log.info(
        { slot: input.slot, chargeId: active.id, abacateChargeId: reissued.abacate_charge_id },
        'cobranca ativa expirada — reemitida (mesma linha)',
      );
      return { charge: reissued, created: true, reissued: true };
    }

    // phase1.kind === 'create'
    const updated = await callGatewayWithOutbox(abacate, legacyInput, active, (client, pix) =>
      billingCharges.attachGatewayDataById(client, {
        id: active.id,
        abacateChargeId: pix.id,
        brCode: pix.brCode,
        brCodeBase64: pix.brCodeBase64,
        expiresAt: pix.expiresAt ? new Date(pix.expiresAt) : null,
      }),
    );
    log.info(
      { slot: input.slot, chargeId: active.id, abacateChargeId: updated.abacate_charge_id },
      'cobranca PIX gerada (modelo por data)',
    );
    return { charge: updated, created: true, reissued: false };
  });
}
