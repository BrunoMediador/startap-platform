/**
 * Teste de INTEGRAÇÃO cross-feature (SCRUM-124 + SCRUM-139) — roda SQL REAL contra Postgres.
 *
 * PROVA o cenário que o #494 (SCRUM-124) apontou como o RISCO e o #497 (SCRUM-139) resolveu,
 * agora com as DUAS features ligadas juntas (reissue-ahead ON, default 120min):
 *
 *   1. REISSUE-AHEAD (ensurePixChargeForSlot, reissueAheadMs>0): uma pending que expira DENTRO
 *      da janela é REEMITIDA ANTES de vencer — novo abacate_charge_id, MESMA linha, MESMO
 *      external_id, SEM criar 2ª cobrança (invariante "1 pending/slot" do #494).
 *   2. O cliente paga o QR VELHO (abacate_charge_id que a reemissão sobrescreveu e não existe
 *      mais no banco) → o webhook (applyPaidWebhook) casa por FALLBACK external_id (#497) e
 *      credita a linha certa — SEM órfão e SEM duplo-crédito.
 *
 * POR QUÊ integração e não mock: o unit (service.test.ts / billing-webhook-events.test.ts)
 * MOCKA o driver pg e valida a STRING do SQL. O acoplamento REAL entre "reissue sobrescreve o
 * abacate_charge_id da MESMA linha" e "o fallback casa essa linha por external_id" só é provado
 * executando as duas funções REAIS contra uma linha real — é a interação, não cada peça.
 *
 * COMO RODAR (local / CI): PG_TEST_URL=postgres://user:pass@host:5432/db npx vitest run
 *   reissue-ahead-fallback.integration
 * Sem PG_TEST_URL o suite AUTO-SKIPA (baseline local — o CI tem Postgres efêmero). NUNCA toca
 * produção: cria/dropa as tabelas num schema dedicado (itest_reissue).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AbacatePayClient } from './client.js';

const PG_TEST_URL = process.env.PG_TEST_URL;
const describeIf = PG_TEST_URL ? describe : describe.skip;

if (!PG_TEST_URL) {
  console.warn(
    '[reissue-ahead-fallback.integration] PG_TEST_URL ausente — suite de integração PULADO ' +
      '(cross-feature SCRUM-124+139 não exercitado). Defina PG_TEST_URL para rodar.',
  );
}

describeIf(
  'reissue-ahead (SCRUM-124) + fallback external_id (SCRUM-139) contra Postgres REAL',
  () => {
    // biome-ignore lint/suspicious/noExplicitAny: pg importado dinamicamente; tipos via cast abaixo.
    let pgPool: any;
    // biome-ignore lint/suspicious/noExplicitAny: módulos importados dinâmicos após setar env do pool.
    let service: any;
    // biome-ignore lint/suspicious/noExplicitAny: idem.
    let billingCharges: any;
    // biome-ignore lint/suspicious/noExplicitAny: idem.
    let billingWebhookEvents: any;

    const SCHEMA = 'itest_reissue';
    const SLOT = 'itest_reissue_slot';
    const TENANT = '00000000-0000-0000-0000-0000000000bb';
    const AMOUNT = 8500; // R$85 (Cirilo) — snapshot congelado
    const DUE = '2026-06-15'; // due_period vira o `cycle`/external_id da linha
    const EXTERNAL_ID = `${SLOT}-${DUE}`;

    // "Agora" fixo. O PIX VELHO expira daqui 1h (ainda válido AGORA) — dentro da janela de 2h.
    const NOW = new Date('2026-06-15T10:00:00.000Z');
    const OLD_EXPIRES = new Date('2026-06-15T11:00:00.000Z'); // NOW + 1h
    const NEW_EXPIRES = new Date('2026-06-18T10:00:00.000Z'); // NOW + 3d (bem válido)
    const AHEAD_120MIN_MS = 120 * 60_000; // == BILLING_REISSUE_AHEAD_MIN default novo

    async function exec(sql: string, params?: unknown[]) {
      return pgPool.query(sql, params);
    }

    /** Fake do gateway: devolve as respostas enfileiradas (ordem = createPixCharge chamados). */
    function makeGateway(responses: Array<{ id: string; expiresAt: string }>): AbacatePayClient {
      const queue = [...responses];
      const createPixCharge = async () => {
        const next = queue.shift();
        if (!next) throw new Error('gateway fake: sem resposta enfileirada');
        return {
          id: next.id,
          brCode: `00020-${next.id}`,
          brCodeBase64: `data:image/png;base64,${next.id}`,
          status: 'pending' as const,
          expiresAt: next.expiresAt,
          platformFee: 80,
        };
      };
      return { createPixCharge } as unknown as AbacatePayClient;
    }

    /** Cria o schema mínimo (colunas/tipos das migrations 038/040/041/042/043 relevantes). */
    async function createSchema() {
      await exec(`CREATE TABLE IF NOT EXISTS flow_clones (
      slot VARCHAR(80) PRIMARY KEY,
      tenant_id UUID,
      flow_enabled BOOLEAN NOT NULL DEFAULT true,
      suspended_reason TEXT,
      suspended_at TIMESTAMPTZ,
      suspended_kind VARCHAR(20)
        CHECK (suspended_kind IN ('billing','owner_request','manual_other','abuse')),
      timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await exec(`CREATE TABLE IF NOT EXISTS client_billing (
      slot VARCHAR(80) PRIMARY KEY REFERENCES flow_clones(slot) ON DELETE CASCADE,
      next_due_date DATE, amount_cents INTEGER, last_payment_at TIMESTAMPTZ,
      status VARCHAR(24) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','overdue','suspended')),
      tenant_id UUID, notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await exec(`CREATE TABLE IF NOT EXISTS billing_charges (
      id BIGSERIAL PRIMARY KEY,
      slot VARCHAR(80) NOT NULL REFERENCES flow_clones(slot) ON DELETE CASCADE,
      cycle VARCHAR(10) NOT NULL, external_id VARCHAR(120) NOT NULL,
      abacate_charge_id VARCHAR(120),
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      paid_amount_cents INTEGER,
      status VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','paid','expired','cancelled')),
      br_code TEXT, br_code_base64 TEXT, expires_at TIMESTAMPTZ, paid_at TIMESTAMPTZ,
      tenant_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await exec(`CREATE INDEX IF NOT EXISTS idx_billing_charges_external_id
      ON billing_charges (external_id)`);
      await exec(`CREATE TABLE IF NOT EXISTS billing_webhook_events (
      event_id VARCHAR(120) PRIMARY KEY, event VARCHAR(60) NOT NULL,
      charge_id BIGINT REFERENCES billing_charges(id) ON DELETE SET NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(), processed_at TIMESTAMPTZ,
      payload JSONB)`);
      await exec(`CREATE TABLE IF NOT EXISTS flow_suspension_log (
      id BIGSERIAL PRIMARY KEY,
      slot VARCHAR(80) NOT NULL REFERENCES flow_clones(slot) ON DELETE CASCADE,
      action VARCHAR(16) NOT NULL CHECK (action IN ('suspend','resume')),
      reason TEXT, actor VARCHAR(80) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    }

    /** Estado inicial: clone SUSPENSO por billing (prova o auto-resume C1), sem pagamento anterior. */
    async function seedSlot() {
      await exec(
        `INSERT INTO flow_clones (slot, tenant_id, flow_enabled, suspended_reason, suspended_at, suspended_kind)
       VALUES ($1, $2, false, 'inadimplente', now(), 'billing')`,
        [SLOT, TENANT],
      );
      await exec(
        `INSERT INTO client_billing (slot, next_due_date, amount_cents, last_payment_at, status, tenant_id)
       VALUES ($1, $2, $3, NULL, 'overdue', $4)`,
        [SLOT, DUE, AMOUNT, TENANT],
      );
    }

    async function countRows(): Promise<number> {
      const r = await exec('SELECT COUNT(*)::int AS n FROM billing_charges WHERE slot = $1', [
        SLOT,
      ]);
      return r.rows[0].n;
    }
    async function countByStatus(status: string): Promise<number> {
      const r = await exec(
        'SELECT COUNT(*)::int AS n FROM billing_charges WHERE slot = $1 AND status = $2',
        [SLOT, status],
      );
      return r.rows[0].n;
    }
    async function readBilling(): Promise<{
      next_due_date: string | null;
      last_payment_at: Date | null;
      status: string;
    }> {
      const r = await exec(
        `SELECT to_char(next_due_date,'YYYY-MM-DD') AS next_due_date, last_payment_at, status
         FROM client_billing WHERE slot = $1`,
        [SLOT],
      );
      return r.rows[0];
    }

    beforeAll(async () => {
      const url = new URL(PG_TEST_URL as string);
      process.env.PG_HOST = url.hostname;
      process.env.PG_PORT = url.port || '5432';
      process.env.PG_USER = decodeURIComponent(url.username);
      process.env.PG_PASS = decodeURIComponent(url.password);
      process.env.PG_DB = url.pathname.replace(/^\//, '');
      // Aponta o pool interno (@startap/db client.ts) pro MESMO schema — ANTES de importá-lo.
      process.env.PG_SEARCH_PATH = SCHEMA;
      const pg = await import('pg');
      pgPool = new pg.default.Pool({
        host: process.env.PG_HOST,
        port: Number(process.env.PG_PORT),
        user: process.env.PG_USER,
        password: process.env.PG_PASS,
        database: process.env.PG_DB,
        max: 6,
        options: `-c search_path=${SCHEMA}`,
      });
      await exec(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      // Importa DEPOIS de setar env: ambas as features compartilham o pool do @startap/db (dist).
      service = await import('./service.js');
      const db = await import('@startap/db');
      billingCharges = db.billingCharges;
      billingWebhookEvents = db.billingWebhookEvents;
      await createSchema();
    }, 30_000);

    afterAll(async () => {
      if (pgPool) {
        await exec(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await pgPool.end().catch(() => {});
      }
      try {
        const db = await import('@startap/db');
        await db.closePool();
      } catch {
        /* noop */
      }
    });

    beforeEach(async () => {
      await exec('DELETE FROM billing_webhook_events');
      await exec('DELETE FROM flow_suspension_log WHERE slot = $1', [SLOT]);
      await exec('DELETE FROM billing_charges WHERE slot = $1', [SLOT]);
      await exec('DELETE FROM client_billing WHERE slot = $1', [SLOT]);
      await exec('DELETE FROM flow_clones WHERE slot = $1', [SLOT]);
      await seedSlot();
    });

    it('CENÁRIO COMPLETO: reissue-ahead reemite a MESMA linha e o QR velho é creditado via fallback (sem órfão, sem duplo-crédito)', async () => {
      const gateway = makeGateway([
        { id: 'pix_char_VELHO', expiresAt: OLD_EXPIRES.toISOString() },
        { id: 'pix_char_NOVO', expiresAt: NEW_EXPIRES.toISOString() },
      ]);

      // (1) Geração inicial: cria a linha com o QR VELHO (expira daqui 1h).
      const first = await service.ensurePixChargeForSlot(
        gateway,
        { slot: SLOT, duePeriod: DUE, amountCents: AMOUNT, reissueAheadMs: AHEAD_120MIN_MS },
        NOW,
      );
      expect(first.created).toBe(true);
      expect(first.reissued).toBe(false);
      expect(first.charge.abacate_charge_id).toBe('pix_char_VELHO');
      expect(first.charge.external_id).toBe(EXTERNAL_ID);
      const rowId = first.charge.id;
      expect(await countRows()).toBe(1);

      // (2) REISSUE-AHEAD: a pending expira em 1h < janela 2h -> REEMITE a MESMA linha ANTES de
      // vencer. Novo abacate_charge_id, MESMA linha (mesmo id), MESMO external_id, SEM 2ª cobrança.
      const reissued = await service.ensurePixChargeForSlot(
        gateway,
        { slot: SLOT, duePeriod: DUE, amountCents: AMOUNT, reissueAheadMs: AHEAD_120MIN_MS },
        NOW,
      );
      expect(reissued.created).toBe(true);
      expect(reissued.reissued).toBe(true);
      expect(reissued.charge.id).toBe(rowId); // MESMA linha
      expect(reissued.charge.abacate_charge_id).toBe('pix_char_NOVO'); // id novo
      expect(reissued.charge.external_id).toBe(EXTERNAL_ID); // chave estável
      // INVARIANTE #494: NÃO duplicou — continua exatamente 1 linha, 1 pending.
      expect(await countRows()).toBe(1);
      expect(await countByStatus('pending')).toBe(1);
      // O abacate_charge_id VELHO não existe mais no banco (foi sobrescrito).
      const gone = await exec('SELECT id FROM billing_charges WHERE abacate_charge_id = $1', [
        'pix_char_VELHO',
      ]);
      expect(gone.rowCount).toBe(0);

      // (3) O cliente paga o QR VELHO. O match primário (abacate_charge_id='pix_char_VELHO') acha
      // 0 linhas -> FALLBACK por external_id (#497) casa a linha 'pending' mais recente e credita.
      const paid = await billingWebhookEvents.applyPaidWebhook({
        eventId: 'evt_pagou_qr_velho',
        event: 'transparent.completed',
        abacateChargeId: 'pix_char_VELHO', // QR velho — sumiu do match primário
        externalId: EXTERNAL_ID, // fallback casa por aqui
        paidAmountCents: AMOUNT,
        redactedPayload: { id: 'evt_pagou_qr_velho' },
        actor: 'abacatepay-webhook',
        dueDateModel: true,
      });
      expect(paid.outcome).toBe('applied'); // creditado via fallback — NÃO órfão
      expect(paid.slot).toBe(SLOT);
      expect(paid.resumed).toBe(true); // auto-resume C1 (estava suspenso por billing)
      expect(paid.firstPayment).toBe(true);

      // (4) SEM duplo-crédito: a MESMA linha virou 'paid'; continua 1 linha, 1 paid, 0 pending.
      expect(await countRows()).toBe(1);
      expect(await countByStatus('paid')).toBe(1);
      expect(await countByStatus('pending')).toBe(0);
      const paidRow = await exec(
        'SELECT id::text AS id, paid_amount_cents FROM billing_charges WHERE slot = $1 AND status = $2',
        [SLOT, 'paid'],
      );
      expect(paidRow.rows[0].id).toBe(rowId); // creditou a linha certa (a reemitida)
      expect(paidRow.rows[0].paid_amount_cents).toBe(AMOUNT);

      // billing avançou + reativou.
      const billing = await readBilling();
      expect(billing.last_payment_at).not.toBeNull();
      expect(billing.status).toBe('active');
      expect(billing.next_due_date && billing.next_due_date > DUE).toBe(true);

      // Forense: o evento foi ligado à linha casada pelo fallback (não ficou órfão).
      const evt = await exec(
        'SELECT charge_id::text AS charge_id, processed_at FROM billing_webhook_events WHERE event_id = $1',
        ['evt_pagou_qr_velho'],
      );
      expect(evt.rows[0].charge_id).toBe(rowId);
      expect(evt.rows[0].processed_at).not.toBeNull();

      // (5) DOUBLE-PAY: se um 2º webhook (event_id novo) do QR velho chegar, o fallback só enxerga
      // 'pending' -> a linha já 'paid' NÃO retorna -> órfão, ZERO segundo crédito.
      const dueAfter = (await readBilling()).next_due_date;
      const second = await billingWebhookEvents.applyPaidWebhook({
        eventId: 'evt_pagou_de_novo',
        event: 'transparent.completed',
        abacateChargeId: 'pix_char_VELHO',
        externalId: EXTERNAL_ID,
        paidAmountCents: AMOUNT,
        redactedPayload: { id: 'evt_pagou_de_novo' },
        dueDateModel: true,
      });
      expect(second.outcome).toBe('orphan'); // nada pending pra casar -> não credita de novo
      expect(await countByStatus('paid')).toBe(1); // ainda 1 pago
      expect((await readBilling()).next_due_date).toBe(dueAfter); // vencimento NÃO avançou 2x
    });

    it('reissue-ahead NÃO reemite quando a pending é válida ALÉM da janela (reusa a MESMA linha, sem 2ª cobrança)', async () => {
      // Regressão da invariante #494: reissue-ahead não é "gerar mais agressivo". Pending que
      // expira em 3 dias (>> janela 2h) é REUSADA — nenhum churn de gateway, nenhuma duplicação.
      const gateway = makeGateway([{ id: 'pix_char_LONGE', expiresAt: NEW_EXPIRES.toISOString() }]);
      const first = await service.ensurePixChargeForSlot(
        gateway,
        { slot: SLOT, duePeriod: DUE, amountCents: AMOUNT, reissueAheadMs: AHEAD_120MIN_MS },
        NOW,
      );
      expect(first.created).toBe(true);
      const again = await service.ensurePixChargeForSlot(
        gateway, // sem 2ª resposta enfileirada: se tentasse reemitir, o fake lançaria
        { slot: SLOT, duePeriod: DUE, amountCents: AMOUNT, reissueAheadMs: AHEAD_120MIN_MS },
        NOW,
      );
      expect(again.created).toBe(false);
      expect(again.reissued).toBe(false);
      expect(again.charge.id).toBe(first.charge.id);
      expect(again.charge.abacate_charge_id).toBe('pix_char_LONGE');
      expect(await countRows()).toBe(1);
    });

    it('pagar o QR NOVO após já pago -> already_paid (idempotência do match primário, sem 2º crédito)', async () => {
      const gateway = makeGateway([
        { id: 'pix_char_VELHO', expiresAt: OLD_EXPIRES.toISOString() },
        { id: 'pix_char_NOVO', expiresAt: NEW_EXPIRES.toISOString() },
      ]);
      await service.ensurePixChargeForSlot(
        gateway,
        { slot: SLOT, duePeriod: DUE, amountCents: AMOUNT, reissueAheadMs: AHEAD_120MIN_MS },
        NOW,
      );
      await service.ensurePixChargeForSlot(
        gateway,
        { slot: SLOT, duePeriod: DUE, amountCents: AMOUNT, reissueAheadMs: AHEAD_120MIN_MS },
        NOW,
      );
      // Paga o QR NOVO (match primário casa a linha pending).
      const p1 = await billingWebhookEvents.applyPaidWebhook({
        eventId: 'evt_novo_1',
        event: 'transparent.completed',
        abacateChargeId: 'pix_char_NOVO',
        externalId: EXTERNAL_ID,
        paidAmountCents: AMOUNT,
        redactedPayload: { id: 'evt_novo_1' },
        dueDateModel: true,
      });
      expect(p1.outcome).toBe('applied');
      const dueAfter = (await readBilling()).next_due_date;
      // 2º webhook do MESMO QR novo (event_id diferente) -> linha já 'paid' -> already_paid.
      const p2 = await billingWebhookEvents.applyPaidWebhook({
        eventId: 'evt_novo_2',
        event: 'transparent.completed',
        abacateChargeId: 'pix_char_NOVO',
        externalId: EXTERNAL_ID,
        paidAmountCents: AMOUNT,
        redactedPayload: { id: 'evt_novo_2' },
        dueDateModel: true,
      });
      expect(p2.outcome).toBe('already_paid');
      expect(await countByStatus('paid')).toBe(1);
      expect((await readBilling()).next_due_date).toBe(dueAfter); // sem 2º avanço
    });
  },
);
