/**
 * Servico de geracao/obtencao idempotente de cobranca PIX por (slot, ciclo).
 *
 * ADR 0013 / F1. Reune o cliente AbacatePay (@startap/integrations) com a persistencia
 * (@startap/db billing_charges). NAO expoe endpoint publico — e chamavel internamente
 * (F4 cron, scripts de smoke, testes). O portal do cliente e F3.
 *
 * Idempotencia (controle do threat-model):
 *   - UNIQUE (slot, cycle) no banco barra duplicacao de geracao.
 *   - "Cria se nao existe": 2a chamada do mesmo (slot, cycle) retorna a cobranca
 *     existente, sem chamar o gateway de novo.
 *
 * Snapshot do valor: amountCents vem de client_billing.amount_cents NO MOMENTO da
 * geracao e e congelado em billing_charges.amount_cents. Pagamento (F2) confere
 * contra o snapshot, nunca contra client_billing em tempo de pagamento.
 */
import { logger } from '@startap/core/logger';
import { type BillingChargeRow, billingCharges } from '@startap/db';
import type { AbacatePayClient } from './client.js';

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
 * Casos de borda tratados (sempre REUSANDO a linha — UNIQUE slot,cycle, sem duplicar):
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

  const externalId = `${input.slot}-${input.cycle}`;

  // 1) Reserva a linha (idempotencia de banco via UNIQUE slot,cycle).
  const { row, created } = await billingCharges.insertPendingChargeIfAbsent({
    slot: input.slot,
    cycle: input.cycle,
    externalId,
    amountCents: input.amountCents,
  });

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

    // Pendente EXPIRADA + reissue: reemite no gateway e sobrescreve a MESMA linha.
    const pix = await callGateway(abacate, input, row);
    const reissuedRow = await billingCharges.reissueGatewayData({
      slot: input.slot,
      cycle: input.cycle,
      abacateChargeId: pix.id,
      brCode: pix.brCode,
      brCodeBase64: pix.brCodeBase64,
      expiresAt: pix.expiresAt ? new Date(pix.expiresAt) : null,
    });
    log.info(
      { slot: input.slot, cycle: input.cycle, abacateChargeId: pix.id },
      'cobranca PIX expirada — reemitida no gateway (mesma linha)',
    );
    return { charge: reissuedRow ?? row, created: true, reissued: true };
  }

  // Linha existe mas sem dados do gateway (nova, ou geracao anterior falhou na API):
  // completa a chamada ao AbacatePay agora.
  const pix = await callGateway(abacate, input, row);
  const updated = await billingCharges.attachGatewayData({
    slot: input.slot,
    cycle: input.cycle,
    abacateChargeId: pix.id,
    brCode: pix.brCode,
    brCodeBase64: pix.brCodeBase64,
    expiresAt: pix.expiresAt ? new Date(pix.expiresAt) : null,
  });

  log.info(
    { slot: input.slot, cycle: input.cycle, abacateChargeId: pix.id },
    'cobranca PIX gerada no gateway',
  );

  return { charge: updated ?? row, created: true, reissued: false };
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
   * nasce ANTES da atual expirar, sem deixar buraco de PIX pagavel. Reemite a MESMA linha
   * (idempotente, 1 pending/slot — NAO cria 2a cobranca). Default 0 = comportamento legado
   * (so reemite ja expirada). So o CRON passa > 0; o portal (geracao sob demanda) mantem 0.
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
 * O gateway (rede) e chamado DENTRO da transacao do lock — o lock dura no maximo o
 * timeout do client (15s). Decisao do ADR 0014 (advisory lock > indice unico parcial).
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

  return billingCharges.withBillingSlotLock(input.slot, async (client) => {
    // 1) Recheck sob o lock: ja existe uma pending nao-expirada? Reusa (idempotencia).
    // O filtro do read usa o `now` REAL (expires_at > now): idempotencia intacta, nunca
    // enxerga uma linha ja-expirada como ativa.
    const active = await billingCharges.getActivePendingCharge(input.slot, now, client);

    if (active) {
      // Horizonte da decisao de validade: agora + janela de reemissao antecipada. Uma
      // pending que expira DENTRO da proxima janela de execucao ja e reemitida (reusando a
      // MESMA linha), pra proxima cobranca nascer ANTES da atual expirar — sem gap sem PIX
      // (SCRUM-124). reissueAheadMs=0 (default/portal) => horizonte == agora (legado).
      const aheadMs = input.reissueAheadMs && input.reissueAheadMs > 0 ? input.reissueAheadMs : 0;
      const decisionAt = aheadMs > 0 ? new Date(now.getTime() + aheadMs) : now;
      if (isChargeStillValid(active, decisionAt)) {
        log.info({ slot: input.slot, chargeId: active.id }, 'cobranca ativa valida — reuso');
        return { charge: active, created: false, reissued: false };
      }
      // Pending porem expirada/sem validade: reemite REUSANDO a mesma linha (por id).
      const legacyInput: EnsureChargeInput = {
        slot: input.slot,
        cycle: active.cycle,
        amountCents: active.amount_cents,
        description: input.description,
        expiresInSec: input.expiresInSec,
      };
      const pix = await callGateway(abacate, legacyInput, active);
      const reissued = await billingCharges.reissueGatewayDataById(client, {
        id: active.id,
        abacateChargeId: pix.id,
        brCode: pix.brCode,
        brCodeBase64: pix.brCodeBase64,
        expiresAt: pix.expiresAt ? new Date(pix.expiresAt) : null,
      });
      log.info(
        { slot: input.slot, chargeId: active.id, abacateChargeId: pix.id },
        'cobranca ativa expirada — reemitida (mesma linha)',
      );
      return { charge: reissued ?? active, created: true, reissued: true };
    }

    // 2) Sem pending valida: insere linha NOVA (cycle = due_period) e chama o gateway.
    const externalId = `${input.slot}-${input.duePeriod}`;
    const row = await billingCharges.insertPendingCharge(client, {
      slot: input.slot,
      cycle: input.duePeriod,
      externalId,
      amountCents: input.amountCents,
    });
    const legacyInput: EnsureChargeInput = {
      slot: input.slot,
      cycle: input.duePeriod,
      amountCents: input.amountCents,
      description: input.description,
      expiresInSec: input.expiresInSec,
    };
    const pix = await callGateway(abacate, legacyInput, row);
    const updated = await billingCharges.attachGatewayDataById(client, {
      id: row.id,
      abacateChargeId: pix.id,
      brCode: pix.brCode,
      brCodeBase64: pix.brCodeBase64,
      expiresAt: pix.expiresAt ? new Date(pix.expiresAt) : null,
    });
    log.info(
      { slot: input.slot, chargeId: row.id, abacateChargeId: pix.id },
      'cobranca PIX gerada (modelo por data)',
    );
    return { charge: updated ?? row, created: true, reissued: false };
  });
}
