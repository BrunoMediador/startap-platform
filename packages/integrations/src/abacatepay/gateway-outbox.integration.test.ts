/**
 * Teste de INTEGRAÇÃO (SCRUM-173) — roda SQL REAL contra Postgres 16.
 *
 * PROVA a causa raiz e o fix do card: antes desta versão, o INSERT da linha 'pending' e o
 * POST ao gateway rodavam na MESMA transação do advisory lock — um timeout na resposta do
 * gateway (que já tinha CONFIRMADO a cobrança) abortava a transação, desfazia o INSERT, e
 * o retry seguinte criava uma SEGUNDA cobrança real (sem nenhum rastro local).
 *
 * Este teste simula o timeout com um client AbacatePay FAKE que sobe (rejeita) na 1ª
 * chamada e só confirma se receber uma 2ª chamada — mas o fix impede a 2ª chamada
 * enquanto a marca `gateway_call_state='calling'` estiver dentro do timeout de
 * ambiguidade. Prova, contra banco REAL:
 *   1. Após o timeout, a linha SOBREVIVE (não é desfeita por rollback) com
 *      gateway_call_state='calling'.
 *   2. Um retry NA JANELA de ambiguidade recebe PixChargeGatewayInFlightError e o fake do
 *      gateway NÃO é chamado de novo (asserção no número de chamadas).
 *   3. Um retry APÓS o timeout de ambiguidade completa a MESMA linha (não cria 2ª).
 *
 * Cobre os DOIS caminhos do card (ON/OFF): ensurePixChargeForSlot (BILLING_DUE_DATE_MODEL
 * ON) e ensurePixChargeForCycle (OFF) — os dois usam callGatewayWithOutbox internamente.
 *
 * COMO RODAR: PG_TEST_URL=postgres://user:pass@host:5432/db npx vitest run
 *   gateway-outbox.integration
 * Sem PG_TEST_URL o suite AUTO-SKIPA. NUNCA toca produção: schema dedicado (itest_outbox).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AbacatePayClient } from './client.js';

const PG_TEST_URL = process.env.PG_TEST_URL;
const describeIf = PG_TEST_URL ? describe : describe.skip;

if (!PG_TEST_URL) {
  console.warn(
    '[gateway-outbox.integration] PG_TEST_URL ausente — suite de integração PULADO ' +
      '(outbox SCRUM-173 não exercitado contra Postgres real). Defina PG_TEST_URL para rodar.',
  );
}

describeIf('outbox de chamada ao gateway (SCRUM-173) contra Postgres REAL', () => {
  // biome-ignore lint/suspicious/noExplicitAny: pg importado dinamicamente.
  let pgPool: any;
  // biome-ignore lint/suspicious/noExplicitAny: módulo importado dinâmico após setar env do pool.
  let service: any;
  // biome-ignore lint/suspicious/noExplicitAny: idem.
  let billingCharges: any;

  const SCHEMA = 'itest_outbox';
  const SLOT_SLOT = 'itest_outbox_slot';
  const SLOT_CYCLE = 'itest_outbox_cycle';
  const TENANT = '00000000-0000-0000-0000-0000000000cc';
  const AMOUNT = 9700;
  const DUE = '2026-06-20';
  const CYCLE = '2026-06';

  async function exec(sql: string, params?: unknown[]) {
    return pgPool.query(sql, params);
  }

  /** Fake do gateway: 1ª chamada TIMEOUT (rejeita), demais confirmam com ids enfileirados. */
  function makeFlakyGateway(responses: Array<{ id: string; expiresAt: string }>) {
    const queue = [...responses];
    let calls = 0;
    let failFirst = true;
    const createPixCharge = async () => {
      calls += 1;
      if (failFirst) {
        failFirst = false;
        throw new Error('gateway timeout (simulado)');
      }
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
    return {
      client: { createPixCharge } as unknown as AbacatePayClient,
      callCount: () => calls,
    };
  }

  async function createSchema() {
    await exec(`CREATE TABLE IF NOT EXISTS flow_clones (
      slot VARCHAR(80) PRIMARY KEY,
      tenant_id UUID,
      status VARCHAR(24) NOT NULL DEFAULT 'rascunho',
      waha_sessao VARCHAR(120),
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
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      superseded_charge_ids TEXT[] NOT NULL DEFAULT '{}',
      gateway_call_state TEXT NOT NULL DEFAULT 'idle'
        CHECK (gateway_call_state IN ('idle','calling','done')),
      gateway_call_started_at TIMESTAMPTZ)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_billing_charges_external_id
      ON billing_charges (external_id)`);
  }

  async function seedSlot(slot: string) {
    await exec(
      `INSERT INTO flow_clones (slot, tenant_id, status, waha_sessao, flow_enabled)
       VALUES ($1, $2, 'conectado', 'itest_outbox_session', true)`,
      [slot, TENANT],
    );
    await exec(
      `INSERT INTO client_billing (slot, next_due_date, amount_cents, last_payment_at, status, tenant_id)
       VALUES ($1, $2, $3, NULL, 'overdue', $4)`,
      [slot, DUE, AMOUNT, TENANT],
    );
  }

  async function countRows(slot: string): Promise<number> {
    const r = await exec('SELECT COUNT(*)::int AS n FROM billing_charges WHERE slot = $1', [slot]);
    return r.rows[0].n;
  }

  async function readRow(slot: string) {
    const r = await exec(
      `SELECT id::text AS id, abacate_charge_id, gateway_call_state, gateway_call_started_at, status
         FROM billing_charges WHERE slot = $1`,
      [slot],
    );
    return r.rows[0] as
      | {
          id: string;
          abacate_charge_id: string | null;
          gateway_call_state: string;
          gateway_call_started_at: Date | null;
          status: string;
        }
      | undefined;
  }

  beforeAll(async () => {
    const url = new URL(PG_TEST_URL as string);
    process.env.PG_HOST = url.hostname;
    process.env.PG_PORT = url.port || '5432';
    process.env.PG_USER = decodeURIComponent(url.username);
    process.env.PG_PASS = decodeURIComponent(url.password);
    process.env.PG_DB = url.pathname.replace(/^\//, '');
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
    service = await import('./service.js');
    const db = await import('@startap/db');
    billingCharges = db.billingCharges;
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
    await exec('DELETE FROM billing_charges');
    await exec('DELETE FROM client_billing');
    await exec('DELETE FROM flow_clones');
    await seedSlot(SLOT_SLOT);
    await seedSlot(SLOT_CYCLE);
  });

  it('ensurePixChargeForSlot (BILLING_DUE_DATE_MODEL ON): timeout NAO desfaz o INSERT; retry na janela NAO chama o gateway de novo', async () => {
    const gateway = makeFlakyGateway([
      { id: 'pix_char_confirmado', expiresAt: '2026-06-25T10:00:00.000Z' },
    ]);
    const now = new Date('2026-06-20T10:00:00.000Z');

    // (1) 1ª tentativa: o POST "timeouta" (fake rejeita). ANTES do fix isso desfaria o
    // INSERT via rollback da transação única — aqui a linha PERSISTE.
    await expect(
      service.ensurePixChargeForSlot(
        gateway.client,
        { slot: SLOT_SLOT, duePeriod: DUE, amountCents: AMOUNT },
        now,
      ),
    ).rejects.toThrow(/gateway timeout/);

    expect(await countRows(SLOT_SLOT)).toBe(1); // INSERT sobreviveu ao rollback do POST.
    const afterTimeout = await readRow(SLOT_SLOT);
    expect(afterTimeout?.gateway_call_state).toBe('calling');
    expect(afterTimeout?.abacate_charge_id).toBeNull();
    expect(afterTimeout?.gateway_call_started_at).not.toBeNull();
    expect(gateway.callCount()).toBe(1);

    // (2) Retry IMEDIATO (mesma janela de ambiguidade, <30s): PixChargeGatewayInFlightError,
    // SEM chamar o gateway de novo — a asserção CENTRAL do card.
    await expect(
      service.ensurePixChargeForSlot(
        gateway.client,
        { slot: SLOT_SLOT, duePeriod: DUE, amountCents: AMOUNT },
        now, // mesmo "agora" -> ainda dentro do timeout de ambiguidade
      ),
    ).rejects.toBeInstanceOf(billingCharges.PixChargeGatewayInFlightError);

    expect(gateway.callCount()).toBe(1); // AINDA 1 — nao chamou de novo.
    expect(await countRows(SLOT_SLOT)).toBe(1); // AINDA 1 linha — nao duplicou.

    // (3) Retry APOS o timeout de ambiguidade (constante GATEWAY_CALL_AMBIGUOUS_TIMEOUT_MS,
    // 30s) libera nova tentativa pela MESMA linha.
    const wellAfter = new Date(
      now.getTime() + billingCharges.GATEWAY_CALL_AMBIGUOUS_TIMEOUT_MS + 5_000,
    );
    const recovered = await service.ensurePixChargeForSlot(
      gateway.client,
      { slot: SLOT_SLOT, duePeriod: DUE, amountCents: AMOUNT },
      wellAfter,
    );

    expect(gateway.callCount()).toBe(2); // so agora incrementou.
    expect(recovered.charge.abacate_charge_id).toBe('pix_char_confirmado');
    expect(recovered.charge.gateway_call_state).toBe('done');
    expect(await countRows(SLOT_SLOT)).toBe(1); // NUNCA criou 2a cobranca.
  });

  it('ensurePixChargeForCycle (BILLING_DUE_DATE_MODEL OFF, legado): mesmo mecanismo — timeout persiste, retry nao duplica', async () => {
    const gateway = makeFlakyGateway([
      { id: 'pix_char_legado_ok', expiresAt: '2026-06-25T10:00:00.000Z' },
    ]);
    const now = new Date('2026-06-20T10:00:00.000Z');

    await expect(
      service.ensurePixChargeForCycle(
        gateway.client,
        { slot: SLOT_CYCLE, cycle: CYCLE, amountCents: AMOUNT },
        now,
      ),
    ).rejects.toThrow(/gateway timeout/);

    expect(await countRows(SLOT_CYCLE)).toBe(1);
    const afterTimeout = await readRow(SLOT_CYCLE);
    expect(afterTimeout?.gateway_call_state).toBe('calling');
    expect(gateway.callCount()).toBe(1);

    // Retry imediato -> bloqueado, sem 2a chamada ao gateway.
    await expect(
      service.ensurePixChargeForCycle(
        gateway.client,
        { slot: SLOT_CYCLE, cycle: CYCLE, amountCents: AMOUNT },
        now,
      ),
    ).rejects.toBeInstanceOf(billingCharges.PixChargeGatewayInFlightError);
    expect(gateway.callCount()).toBe(1);
    expect(await countRows(SLOT_CYCLE)).toBe(1);

    // Retry apos o timeout de ambiguidade -> completa a MESMA linha.
    const wellAfter = new Date(
      now.getTime() + billingCharges.GATEWAY_CALL_AMBIGUOUS_TIMEOUT_MS + 5_000,
    );
    const recovered = await service.ensurePixChargeForCycle(
      gateway.client,
      { slot: SLOT_CYCLE, cycle: CYCLE, amountCents: AMOUNT },
      wellAfter,
    );
    expect(gateway.callCount()).toBe(2);
    expect(recovered.charge.abacate_charge_id).toBe('pix_char_legado_ok');
    expect(await countRows(SLOT_CYCLE)).toBe(1);
  });
});
