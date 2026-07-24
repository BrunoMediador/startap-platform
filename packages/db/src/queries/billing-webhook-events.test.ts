/**
 * Testes do processamento transacional applyPaidWebhook (C1/C2/C4 do threat-model).
 *
 * O pool pg e MOCKADO — um client fake responde a cada SQL pela ORDEM/PADRAO da query.
 * Cobre: dedupe (replay nao reprocessa), orfao, already_paid, underpaid (nao avanca/
 * reativa), applied + auto-resume SO com suspended_kind='billing' (e NAO com
 * 'owner_request'/NULL). Verifica COMMIT/ROLLBACK e que o slot vem do registro casado.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock do pool pg: client fake roteado por substring da query ─────────────────
interface Scenario {
  dedupeInserted: boolean; // (1) INSERT billing_webhook_events RETURNING -> 1 ou 0 linhas
  charge: { id: string; slot: string; amount_cents: number; status: string } | null; // (2) SELECT charge FOR UPDATE por abacate_charge_id
  nextDueDate: string | null; // (6) SELECT client_billing FOR UPDATE
  resumeRows: number; // (7) UPDATE flow_clones ... RETURNING -> 0 ou 1
  // (6) last_payment_at IS NULL no SELECT client_billing -> firstPayment do result.
  // Default true (cliente novo) quando não declarado pelo cenário.
  firstPayment?: boolean;
  // (2b) SELECT charge FOR UPDATE por external_id — FALLBACK do SCRUM-139. So consultado
  // quando o match primario (abacate_charge_id) nao acha. undefined/null = 0 linhas.
  chargeByExternal?: { id: string; slot: string; amount_cents: number; status: string } | null;
}

const calls: { sql: string; params: unknown[] }[] = [];

function makeClient(s: Scenario) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const q = sql.replace(/\s+/g, ' ');

      if (q.includes('BEGIN')) return { rows: [], rowCount: 0 };
      if (q.includes('COMMIT') || q.includes('ROLLBACK')) return { rows: [], rowCount: 0 };

      if (q.includes('INSERT INTO billing_webhook_events') && q.includes('ON CONFLICT')) {
        return s.dedupeInserted
          ? { rows: [{ event_id: 'evt_1' }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (
        q.includes('FROM billing_charges') &&
        q.includes('abacate_charge_id = $1') &&
        q.includes('FOR UPDATE')
      ) {
        return s.charge ? { rows: [s.charge], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      // Fallback por external_id (SCRUM-139): so casa a linha 'pending' mais recente.
      if (
        q.includes('FROM billing_charges') &&
        q.includes('external_id = $1') &&
        q.includes('FOR UPDATE')
      ) {
        return s.chargeByExternal
          ? { rows: [s.chargeByExternal], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (q.includes('UPDATE billing_webhook_events SET charge_id')) {
        return { rows: [], rowCount: 1 };
      }
      if (q.includes('UPDATE billing_charges') && q.includes("status = 'paid'")) {
        return { rows: [], rowCount: 1 };
      }
      if (q.includes('FROM client_billing') && q.includes('FOR UPDATE')) {
        return {
          rows: [{ next_due_date: s.nextDueDate, first_payment: s.firstPayment ?? true }],
          rowCount: s.nextDueDate ? 1 : 0,
        };
      }
      if (q.includes('INSERT INTO client_billing')) {
        return { rows: [], rowCount: 1 };
      }
      if (q.includes('UPDATE flow_clones') && q.includes("suspended_kind = 'billing'")) {
        return s.resumeRows > 0
          ? { rows: [{ slot: s.charge?.slot }], rowCount: s.resumeRows }
          : { rows: [], rowCount: 0 };
      }
      if (q.includes('INSERT INTO flow_suspension_log')) {
        return { rows: [], rowCount: 1 };
      }
      if (q.includes('UPDATE billing_webhook_events SET processed_at')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
}

let currentClient: ReturnType<typeof makeClient>;

vi.mock('../client.js', () => ({
  pool: { connect: vi.fn(async () => currentClient) },
  query: vi.fn(),
}));

import { applyPaidWebhook } from './billing-webhook-events.js';

const BASE_INPUT = {
  eventId: 'evt_1',
  event: 'transparent.completed',
  abacateChargeId: 'pix_char_abc',
  paidAmountCents: 19900,
  redactedPayload: { id: 'evt_1', brCode: '[REDACTED]' },
};

function setup(s: Scenario) {
  calls.length = 0;
  currentClient = makeClient(s);
}

function sqlsRun(): string[] {
  return calls.map((c) => c.sql.replace(/\s+/g, ' ').trim());
}
function ranResume(): boolean {
  return sqlsRun().some(
    (q) => q.includes('UPDATE flow_clones') && q.includes("suspended_kind = 'billing'"),
  );
}
function ranAdvance(): boolean {
  return sqlsRun().some((q) => q.includes('INSERT INTO client_billing'));
}
function committed(): boolean {
  return sqlsRun().some((q) => q.includes('COMMIT'));
}

/** Novo next_due_date gravado (param $2 do INSERT INTO client_billing). */
function advancedDue(): string | undefined {
  const insert = calls.find((c) =>
    c.sql.replace(/\s+/g, ' ').includes('INSERT INTO client_billing'),
  );
  return insert?.params[1] as string | undefined;
}

/** SQL do SELECT de fallback por external_id (SCRUM-139), se emitido. */
function externalFallbackSql(): string | undefined {
  return sqlsRun().find(
    (q) => q.includes('FROM billing_charges') && q.includes('external_id = $1'),
  );
}

/** id da linha ligada ao evento no forense (param $1 do UPDATE ... SET charge_id). */
function linkedChargeId(): unknown {
  const link = calls.find((c) =>
    c.sql.replace(/\s+/g, ' ').includes('UPDATE billing_webhook_events SET charge_id'),
  );
  return link?.params[0];
}

beforeEach(() => {
  calls.length = 0;
});

describe('applyPaidWebhook (C1/C2/C4)', () => {
  it('C4 dedupe: event_id repetido (0 linhas no INSERT) -> duplicate, nao processa', async () => {
    setup({ dedupeInserted: false, charge: null, nextDueDate: null, resumeRows: 0 });
    const r = await applyPaidWebhook(BASE_INPUT);
    expect(r.outcome).toBe('duplicate');
    // Nao chegou a casar cobranca nem avancar.
    expect(sqlsRun().some((q) => q.includes('FROM billing_charges'))).toBe(false);
    expect(ranAdvance()).toBe(false);
    expect(committed()).toBe(true);
  });

  it('orfao: nenhuma cobranca casada -> orphan, nao avanca/reativa', async () => {
    setup({ dedupeInserted: true, charge: null, nextDueDate: null, resumeRows: 0 });
    const r = await applyPaidWebhook(BASE_INPUT);
    expect(r.outcome).toBe('orphan');
    expect(ranAdvance()).toBe(false);
    expect(ranResume()).toBe(false);
  });

  it('already_paid: cobranca ja paga -> idempotente, nao avanca/reativa', async () => {
    setup({
      dedupeInserted: true,
      charge: { id: '10', slot: 'barbearia-cirilo', amount_cents: 19900, status: 'paid' },
      nextDueDate: '2026-06-10',
      resumeRows: 0,
    });
    const r = await applyPaidWebhook(BASE_INPUT);
    expect(r.outcome).toBe('already_paid');
    expect(ranAdvance()).toBe(false);
    expect(ranResume()).toBe(false);
  });

  it('C2 underpaid: pago < snapshot -> marca pago mas NAO avanca nem reativa', async () => {
    setup({
      dedupeInserted: true,
      charge: { id: '10', slot: 'barbearia-cirilo', amount_cents: 19900, status: 'pending' },
      nextDueDate: '2026-06-10',
      resumeRows: 1, // mesmo que pudesse, nao deve chegar a reativar
    });
    const r = await applyPaidWebhook({ ...BASE_INPUT, paidAmountCents: 1 });
    expect(r.outcome).toBe('underpaid');
    expect(r.resumed).toBe(false);
    // Marcou pago, mas NAO avancou vencimento nem rodou o UPDATE de resume.
    expect(sqlsRun().some((q) => q.includes("status = 'paid'"))).toBe(true);
    expect(ranAdvance()).toBe(false);
    expect(ranResume()).toBe(false);
    expect(committed()).toBe(true);
  });

  it('T3 C2: valor PIX derivado de amount (9500) < snapshot (10000) -> underpaid, nao avanca/reativa', async () => {
    // Reconciliacao identica para valor derivado de `amount` (fallback PIX do parser): o
    // applyPaidWebhook nao sabe nem se importa de onde veio o valor — compara contra o
    // snapshot amount_cents. Pago a menos -> underpaid, sem avancar vencimento nem reativar.
    setup({
      dedupeInserted: true,
      charge: { id: '10', slot: 'barbearia-cirilo', amount_cents: 10000, status: 'pending' },
      nextDueDate: '2026-06-10',
      resumeRows: 1, // ainda que pudesse reativar, nao deve chegar la
    });
    const r = await applyPaidWebhook({ ...BASE_INPUT, paidAmountCents: 9500 });
    expect(r.outcome).toBe('underpaid');
    expect(r.resumed).toBe(false);
    expect(ranAdvance()).toBe(false);
    expect(ranResume()).toBe(false);
    expect(committed()).toBe(true);
  });

  it('C1 applied + auto-resume: pago >= snapshot e suspended_kind=billing -> reativa', async () => {
    setup({
      dedupeInserted: true,
      charge: { id: '10', slot: 'barbearia-cirilo', amount_cents: 19900, status: 'pending' },
      nextDueDate: '2026-06-10',
      resumeRows: 1, // UPDATE casou (slot estava suspenso por billing)
    });
    const r = await applyPaidWebhook(BASE_INPUT);
    expect(r.outcome).toBe('applied');
    expect(r.resumed).toBe(true);
    expect(r.slot).toBe('barbearia-cirilo');
    expect(ranAdvance()).toBe(true);
    expect(ranResume()).toBe(true);
    // Logou o resume.
    expect(sqlsRun().some((q) => q.includes('INSERT INTO flow_suspension_log'))).toBe(true);
  });

  it('C1 applied SEM resume: suspended_kind != billing / NULL -> avanca mas NAO reativa', async () => {
    // O UPDATE condicional (WHERE suspended_kind='billing') casa 0 linhas quando o slot
    // foi suspenso por outro motivo (owner_request) ou nao esta suspenso (NULL).
    setup({
      dedupeInserted: true,
      charge: { id: '10', slot: 'barbearia-cirilo', amount_cents: 19900, status: 'pending' },
      nextDueDate: '2026-06-10',
      resumeRows: 0, // WHERE nao casou -> nao reativa
    });
    const r = await applyPaidWebhook(BASE_INPUT);
    expect(r.outcome).toBe('applied');
    expect(r.resumed).toBe(false);
    expect(ranAdvance()).toBe(true); // vencimento avanca mesmo sem reativar
    // O UPDATE de resume RODA (com WHERE seguro), mas como casou 0 linhas, NAO loga resume.
    expect(sqlsRun().some((q) => q.includes('INSERT INTO flow_suspension_log'))).toBe(false);
  });

  it('o UPDATE de resume sempre carrega o guard suspended_kind=billing (anti-falso-resume)', async () => {
    setup({
      dedupeInserted: true,
      charge: { id: '10', slot: 'barbearia-cirilo', amount_cents: 19900, status: 'pending' },
      nextDueDate: '2026-06-10',
      resumeRows: 1,
    });
    await applyPaidWebhook(BASE_INPUT);
    const resumeSql = sqlsRun().find((q) => q.includes('UPDATE flow_clones'));
    expect(resumeSql).toBeDefined();
    expect(resumeSql).toContain("suspended_kind = 'billing'");
    expect(resumeSql).toContain('flow_enabled = false');
  });

  // ── firstPayment (gancho C do alerta de cliente novo) ───────────────────────
  it('firstPayment=true no PRIMEIRO pagamento (last_payment_at era NULL)', async () => {
    setup({
      dedupeInserted: true,
      charge: { id: '10', slot: 'clone-novo', amount_cents: 3100, status: 'pending' },
      nextDueDate: '2026-06-20', // trial já tinha vencimento; last_payment_at NULL é o que conta
      resumeRows: 0,
      firstPayment: true,
    });
    const r = await applyPaidWebhook({ ...BASE_INPUT, paidAmountCents: 3100 });
    expect(r.outcome).toBe('applied');
    expect(r.firstPayment).toBe(true);
    // O SELECT de billing carrega o teste de last_payment_at IS NULL.
    expect(sqlsRun().some((q) => q.includes('last_payment_at IS NULL'))).toBe(true);
  });

  it('firstPayment=false na RENOVAÇÃO mensal (last_payment_at já preenchido)', async () => {
    setup({
      dedupeInserted: true,
      charge: { id: '11', slot: 'barbearia-cirilo', amount_cents: 8500, status: 'pending' },
      nextDueDate: '2026-06-10',
      resumeRows: 0,
      firstPayment: false, // já pagou antes -> renovação, NÃO alerta cliente novo
    });
    const r = await applyPaidWebhook({ ...BASE_INPUT, paidAmountCents: 8500 });
    expect(r.outcome).toBe('applied');
    expect(r.firstPayment).toBe(false);
  });

  it('firstPayment é sempre false fora do applied (duplicate/orphan/already_paid/underpaid)', async () => {
    setup({ dedupeInserted: false, charge: null, nextDueDate: null, resumeRows: 0 });
    expect((await applyPaidWebhook(BASE_INPUT)).firstPayment).toBe(false); // duplicate

    setup({ dedupeInserted: true, charge: null, nextDueDate: null, resumeRows: 0 });
    expect((await applyPaidWebhook(BASE_INPUT)).firstPayment).toBe(false); // orphan

    setup({
      dedupeInserted: true,
      charge: { id: '10', slot: 's', amount_cents: 19900, status: 'pending' },
      nextDueDate: '2026-06-10',
      resumeRows: 0,
    });
    expect((await applyPaidWebhook({ ...BASE_INPUT, paidAmountCents: 1 })).firstPayment).toBe(
      false,
    ); // underpaid
  });
});

// ── SCRUM-139: fallback por external_id quando o abacate_charge_id nao casa ──────
//
// Cenario real: uma reemissao (reissueGatewayDataById) SOBRESCREVE o abacate_charge_id
// na linha; o cliente paga o QR VELHO -> o id antigo nao existe mais no banco -> o match
// primario por abacate_charge_id acha 0 linhas. O fallback casa a linha pela chave
// ESTAVEL external_id ("{slot}-{ciclo}"), SO em status='pending' (nunca reescreve 'paid'),
// a mais recente (id DESC), FOR UPDATE. Idempotencia (already_paid) + reconciliacao de
// valor (C2) do caminho principal ficam INTACTAS.
describe('applyPaidWebhook — fallback por external_id (SCRUM-139)', () => {
  const EXT = 'barbearia-cirilo-2026-06';

  it('paga o QR VELHO (abacate_charge_id sumiu na reemissao) mas external_id casa -> credita na linha certa', async () => {
    setup({
      dedupeInserted: true,
      charge: null, // match primario por abacate_charge_id NAO acha (reemissao sobrescreveu)
      chargeByExternal: {
        id: '77',
        slot: 'barbearia-cirilo',
        amount_cents: 8500,
        status: 'pending',
      },
      nextDueDate: '2026-06-10',
      resumeRows: 1,
    });
    const r = await applyPaidWebhook({
      ...BASE_INPUT,
      abacateChargeId: 'pix_char_VELHO_sumido',
      paidAmountCents: 8500,
      externalId: EXT,
    });
    expect(r.outcome).toBe('applied');
    expect(r.slot).toBe('barbearia-cirilo');
    expect(ranAdvance()).toBe(true);
    expect(ranResume()).toBe(true);
    // Forense: o evento foi ligado a linha casada pelo fallback (77), nao a outra.
    expect(linkedChargeId()).toBe('77');
    // A query primaria por abacate_charge_id foi tentada ANTES do fallback.
    expect(sqlsRun().some((q) => q.includes('abacate_charge_id = $1'))).toBe(true);
  });

  it('desempate DETERMINISTICO: external_id casa 2+ linhas -> pega a pending mais recente (id DESC, LIMIT 1, FOR UPDATE, so pending)', async () => {
    // O mock devolve a linha que o Postgres retornaria (a mais recente pending, id 99). A
    // GARANTIA do desempate mora na FORMA da SQL — asseguramos que ela filtra pending,
    // ordena por id DESC e limita a 1 sob FOR UPDATE.
    setup({
      dedupeInserted: true,
      charge: null,
      chargeByExternal: {
        id: '99',
        slot: 'barbearia-cirilo',
        amount_cents: 8500,
        status: 'pending',
      },
      nextDueDate: '2026-06-10',
      resumeRows: 0,
    });
    const r = await applyPaidWebhook({
      ...BASE_INPUT,
      abacateChargeId: 'pix_char_x',
      paidAmountCents: 8500,
      externalId: EXT,
    });
    expect(r.outcome).toBe('applied');
    expect(linkedChargeId()).toBe('99'); // creditou a linha mais recente
    const sql = externalFallbackSql();
    expect(sql).toBeDefined();
    const norm = (sql as string).replace(/\s+/g, ' ');
    expect(norm).toContain("status = 'pending'");
    expect(norm).toContain('ORDER BY id DESC');
    expect(norm).toContain('LIMIT 1');
    expect(norm).toContain('FOR UPDATE');
  });

  it('nada casa (nem abacate_charge_id nem external_id pending) -> orphan, NAO credita', async () => {
    setup({
      dedupeInserted: true,
      charge: null,
      chargeByExternal: null, // nenhuma linha pending pro external_id
      nextDueDate: null,
      resumeRows: 0,
    });
    const r = await applyPaidWebhook({
      ...BASE_INPUT,
      abacateChargeId: 'pix_char_x',
      externalId: EXT,
    });
    expect(r.outcome).toBe('orphan');
    expect(ranAdvance()).toBe(false);
    expect(ranResume()).toBe(false);
    expect(sqlsRun().some((q) => q.includes("status = 'paid'"))).toBe(false);
  });

  it('paga duas vezes: 2o webhook do QR velho nao acha linha pending (ja paga) -> orphan, NAO credita de novo', async () => {
    // 1o pagamento ja creditou e a linha virou 'paid'. O 2o evento (event_id NOVO — cliente
    // pagou o QR velho E o novo) passa o dedupe, mas o fallback so enxerga 'pending' -> a
    // linha ja paga NAO retorna -> orphan. Zero segundo credito (nao avanca, nao marca pago).
    setup({
      dedupeInserted: true, // event_id diferente do 1o -> passa o dedupe
      charge: null, // abacate_charge_id velho ja nao existe
      chargeByExternal: null, // a unica linha do external_id ja esta 'paid' -> fora do WHERE pending
      nextDueDate: null,
      resumeRows: 0,
    });
    const r = await applyPaidWebhook({
      ...BASE_INPUT,
      eventId: 'evt_2_double_pay',
      abacateChargeId: 'pix_char_VELHO_sumido',
      externalId: EXT,
    });
    expect(r.outcome).toBe('orphan');
    expect(ranAdvance()).toBe(false);
    expect(sqlsRun().some((q) => q.includes("status = 'paid'"))).toBe(false);
  });

  it('underpaid via fallback: pago < snapshot da linha casada por external_id -> marca pago, NAO avanca/reativa', async () => {
    setup({
      dedupeInserted: true,
      charge: null,
      chargeByExternal: {
        id: '77',
        slot: 'barbearia-cirilo',
        amount_cents: 8500,
        status: 'pending',
      },
      nextDueDate: '2026-06-10',
      resumeRows: 1, // ainda que pudesse reativar, underpaid barra antes
    });
    const r = await applyPaidWebhook({
      ...BASE_INPUT,
      abacateChargeId: 'pix_char_x',
      paidAmountCents: 1,
      externalId: EXT,
    });
    expect(r.outcome).toBe('underpaid');
    expect(r.resumed).toBe(false);
    expect(ranAdvance()).toBe(false);
    expect(ranResume()).toBe(false);
  });

  it('SEM externalId no input: fallback nem roda (nao quebra o caminho orphan atual)', async () => {
    setup({
      dedupeInserted: true,
      charge: null,
      // mesmo havendo linha pending casavel por external, o fallback nao deve ser tentado
      chargeByExternal: {
        id: '1',
        slot: 'barbearia-cirilo',
        amount_cents: 8500,
        status: 'pending',
      },
      nextDueDate: null,
      resumeRows: 0,
    });
    const r = await applyPaidWebhook({ ...BASE_INPUT, abacateChargeId: 'pix_char_x' }); // sem externalId
    expect(r.outcome).toBe('orphan');
    expect(externalFallbackSql()).toBeUndefined(); // a SQL de fallback NUNCA foi emitida
    expect(ranAdvance()).toBe(false);
  });
});

// ── ADR 0014: avanco do vencimento sob a flag dueDateModel ─────────────────────
describe('applyPaidWebhook — avanco max(due, hoje) (ADR 0014)', () => {
  const PAID_CHARGE = {
    id: '10',
    slot: 'barbearia-cirilo',
    amount_cents: 19900,
    status: 'pending',
  };

  function todayStr(): string {
    const t = new Date();
    const y = t.getUTCFullYear();
    const m = String(t.getUTCMonth() + 1).padStart(2, '0');
    const d = String(t.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  it('flag OFF (default): avanco LEGADO a partir de next_due_date puro — comportamento ATUAL', async () => {
    setup({ dedupeInserted: true, charge: PAID_CHARGE, nextDueDate: '2026-06-10', resumeRows: 0 });
    const r = await applyPaidWebhook(BASE_INPUT); // sem dueDateModel
    expect(r.outcome).toBe('applied');
    // Legado: 2026-06-10 + 1 mes = 2026-07-10 (mesmo que esteja no passado relativo a hoje).
    expect(advancedDue()).toBe('2026-07-10');
  });

  it('flag ON + VENCIDO (due no passado distante): NAO renova pro passado (parte de hoje)', async () => {
    // venceu em 2020 -> legado cairia em 2020-02; com max(due,hoje) cai em hoje+1mes (futuro).
    setup({ dedupeInserted: true, charge: PAID_CHARGE, nextDueDate: '2020-01-10', resumeRows: 1 });
    const r = await applyPaidWebhook({ ...BASE_INPUT, dueDateModel: true });
    expect(r.outcome).toBe('applied');
    const due = advancedDue();
    // O novo vencimento e estritamente FUTURO (> hoje), nunca no passado.
    expect(due).toBeDefined();
    expect((due as string) > todayStr()).toBe(true);
  });

  it('flag ON + EM DIA (due no futuro): parte de next_due_date (nao perde tempo pago)', async () => {
    setup({ dedupeInserted: true, charge: PAID_CHARGE, nextDueDate: '2099-06-10', resumeRows: 0 });
    const r = await applyPaidWebhook({ ...BASE_INPUT, dueDateModel: true });
    expect(r.outcome).toBe('applied');
    // due >> hoje -> max e a propria due. 2099-06-10 + 1 mes = 2099-07-10.
    expect(advancedDue()).toBe('2099-07-10');
  });

  it('flag ON nao regride dedupe/underpaid: pago a menos NAO avanca (mesmo no modelo novo)', async () => {
    setup({ dedupeInserted: true, charge: PAID_CHARGE, nextDueDate: '2020-01-10', resumeRows: 1 });
    const r = await applyPaidWebhook({ ...BASE_INPUT, paidAmountCents: 1, dueDateModel: true });
    expect(r.outcome).toBe('underpaid');
    expect(r.resumed).toBe(false);
    expect(ranAdvance()).toBe(false); // underpaid NAO avanca, independe do modelo
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Anti-coluna-fantasma (regressao do bug do receipt_url).
//
// O pool e MOCKADO nos testes acima, entao um SET pra coluna inexistente passaria
// despercebido ate o 1o pagamento real (UPDATE -> 'column does not exist' -> 500 ->
// retry -> ROLLBACK desfaz o dedupe -> loop). Esta suite deriva a lista de colunas
// REAIS de billing_charges direto da migration 041 (fonte da verdade do schema) e
// assegura que o SET do UPDATE so referencia colunas que existem.
//
// LIMITACAO ASSUMIDA: nao ha infra de Postgres efemero no projeto (so unit + mock).
// Esta validacao e por PARSING de string (SQL capturado x colunas da migration), nao
// por execucao real contra um banco. Cobre o furo concreto (coluna inexistente no SET);
// nao valida tipos/constraints. Se um dia houver pg de teste, trocar por migrate+query.
// ─────────────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_041 = resolve(HERE, '../../migrations/041_billing_charges.sql');

/** Extrai os nomes das colunas do CREATE TABLE billing_charges da migration 041. */
function billingChargesColumns(): Set<string> {
  const sql = readFileSync(MIGRATION_041, 'utf8');
  const m = sql.match(/CREATE TABLE IF NOT EXISTS billing_charges\s*\(([\s\S]*?)\n\)\s*;/i);
  if (!m) throw new Error('CREATE TABLE billing_charges nao encontrado na migration 041');
  const cols = new Set<string>();
  for (const rawLine of m[1].split('\n')) {
    const line = rawLine.replace(/--.*$/, '').trim();
    if (!line) continue;
    // Pula linhas de constraint de tabela (nao sao definicoes de coluna).
    if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) continue;
    const col = line.match(/^([a-z_][a-z0-9_]*)/i);
    if (col) cols.add(col[1].toLowerCase());
  }
  return cols;
}

/** Colunas referenciadas no SET de um `UPDATE billing_charges SET ... WHERE`. */
function setClauseColumns(updateSql: string): string[] {
  const norm = updateSql.replace(/\s+/g, ' ');
  const m = norm.match(/UPDATE billing_charges SET (.+?) WHERE /i);
  if (!m) throw new Error('clausula SET do UPDATE billing_charges nao encontrada');
  return m[1]
    .split(',')
    .map((assign) =>
      assign
        .trim()
        .match(/^([a-z_][a-z0-9_]*)/i)?.[1]
        ?.toLowerCase(),
    )
    .filter((c): c is string => Boolean(c));
}

describe('anti-coluna-fantasma: applyPaidWebhook so toca colunas reais de billing_charges', () => {
  it('a migration 041 expoe as colunas esperadas (sanidade do parser)', () => {
    const cols = billingChargesColumns();
    expect(cols.has('status')).toBe(true);
    expect(cols.has('paid_at')).toBe(true);
    expect(cols.has('paid_amount_cents')).toBe(true);
    expect(cols.has('updated_at')).toBe(true);
    // O bug: receipt_url NUNCA existiu em billing_charges.
    expect(cols.has('receipt_url')).toBe(false);
  });

  it('cada coluna do SET do UPDATE billing_charges existe na migration 041', async () => {
    setup({
      dedupeInserted: true,
      charge: { id: '10', slot: 'barbearia-cirilo', amount_cents: 19900, status: 'pending' },
      nextDueDate: '2026-06-10',
      resumeRows: 1,
    });
    await applyPaidWebhook(BASE_INPUT);

    const real = billingChargesColumns();
    const updateSql = sqlsRun().find(
      (q) => q.includes('UPDATE billing_charges') && q.includes("status = 'paid'"),
    );
    expect(updateSql).toBeDefined();

    const setCols = setClauseColumns(updateSql as string);
    expect(setCols.length).toBeGreaterThan(0);
    for (const col of setCols) {
      expect(real.has(col), `coluna '${col}' nao existe em billing_charges (041)`).toBe(true);
    }
    // Guard explicito do bug que motivou o teste.
    expect(setCols).not.toContain('receipt_url');
  });
});
