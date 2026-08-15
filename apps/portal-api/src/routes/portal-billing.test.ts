/**
 * Testes das rotas de mensalidade do portal (ADR 0013, F3).
 *
 * DB e o client AbacatePay sao MOCKADOS — nada bate em banco/gateway real.
 * Foco: shape do GET, valor do banco no POST /pix (e 409 sem valor), guard Dev-only
 * do /simular, e o invariante anti-IDOR (slot SEMPRE da sessao, controle C8).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// config.js valida process.env no import — mockamos. dev_mode = chave abc_dev_*.
// BILLING_DUE_DATE_MODEL e MUTAVEL por teste (default OFF — comportamento atual).
// vi.hoisted leva o objeto pro topo junto com o vi.mock (que e hoisted).
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    NODE_ENV: 'test',
    ABACATEPAY_API_KEY: 'abc_dev_xyz',
    ABACATEPAY_BASE_URL: 'https://api.abacatepay.com',
    BILLING_DUE_DATE_MODEL: false,
  },
}));
vi.mock('../config.js', () => ({ config: mockConfig }));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

// computeBillingState e a fonte unica de verdade (ADR 0014) — usamos a IMPLEMENTACAO
// REAL no mock pra exercitar a janela de fato (nao mockar a logica que estamos testando).
const { computeBillingStateReal } = vi.hoisted(() => {
  const WINDOW = 7;
  return {
    computeBillingStateReal: (
      nextDueDate: string | null,
      today = new Date(),
      windowDays = WINDOW,
    ) => {
      if (!nextDueDate) {
        return {
          state: 'sem_config',
          diasRestantes: null,
          dentroDaJanela: false,
          podeGerarPix: false,
        };
      }
      const due = Date.parse(`${nextDueDate}T00:00:00Z`);
      const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
      const dias = Math.round((due - todayUtc) / 86_400_000);
      if (dias > windowDays) {
        return { state: 'em_dia', diasRestantes: dias, dentroDaJanela: false, podeGerarPix: false };
      }
      const state = dias <= 0 ? 'vencido' : 'a_vencer';
      return { state, diasRestantes: dias, dentroDaJanela: true, podeGerarPix: true };
    },
  };
});

vi.mock('@startap/db', () => ({
  clientBilling: {
    getBillingBySlot: vi.fn(),
    daysUntilDue: vi.fn(),
    computeBillingState: computeBillingStateReal,
  },
  billingCharges: {
    BillingSlotBusyError: class BillingSlotBusyError extends Error {},
    PixChargeGatewayInFlightError: class PixChargeGatewayInFlightError extends Error {},
    getCharge: vi.fn(),
    getActivePendingCharge: vi.fn(),
  },
}));

// Client AbacatePay + service mockados. vi.hoisted leva os mocks pro topo junto com
// vi.mock (que e hoisted) — evita "cannot access before initialization".
const { simulatePaymentMock, ensureMock, ensureForSlotMock } = vi.hoisted(() => ({
  simulatePaymentMock: vi.fn(),
  ensureMock: vi.fn(),
  ensureForSlotMock: vi.fn(),
}));
vi.mock('@startap/integrations', () => {
  class FakeNotConfigured extends Error {}
  return {
    abacatepay: {
      AbacatePayClient: class {
        apiKey: string | undefined;
        constructor(cfg: { apiKey: string | undefined }) {
          if (!cfg.apiKey) throw new FakeNotConfigured('sem key');
          this.apiKey = cfg.apiKey;
        }
        simulatePayment(id: string) {
          return simulatePaymentMock(id);
        }
      },
      AbacatePayNotConfiguredError: FakeNotConfigured,
      ensurePixChargeForCycle: (...args: unknown[]) => ensureMock(...args),
      ensurePixChargeForSlot: (...args: unknown[]) => ensureForSlotMock(...args),
    },
  };
});

// withTenant stub: injeta tenant fixo (slot da sessao). A auth real vive em tenant.test.ts.
let injectedSlot = 'clone_x';
vi.mock('../lib/tenant.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/tenant.js')>('../lib/tenant.js');
  return {
    ...actual,
    withTenant: vi.fn(async (req: { tenant?: unknown }) => {
      req.tenant = { slot: injectedSlot, userId: 7, username: 'cirilo', sid: 'sid-atual' };
    }),
  };
});

import { billingCharges, clientBilling } from '@startap/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { cicloAtual, portalBillingRoutes } from './portal-billing.js';

const getBillingMock = vi.mocked(clientBilling.getBillingBySlot);
const daysUntilDueMock = vi.mocked(clientBilling.daysUntilDue);
const getChargeMock = vi.mocked(billingCharges.getCharge);
const getActivePendingChargeMock = vi.mocked(billingCharges.getActivePendingCharge);

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalBillingRoutes);
  await app.ready();
  return app;
}

function makeBilling(over: Partial<Record<string, unknown>> = {}) {
  return {
    slot: 'clone_x',
    next_due_date: '2026-07-10',
    amount_cents: 19900,
    last_payment_at: null,
    status: 'active',
    notes: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
    // biome-ignore lint/suspicious/noExplicitAny: fixture de teste
  } as any;
}

function makeCharge(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: '1',
    slot: 'clone_x',
    cycle: cicloAtual(),
    external_id: `clone_x-${cicloAtual()}`,
    abacate_charge_id: 'pix_char_abc',
    amount_cents: 19900,
    paid_amount_cents: null,
    status: 'pending',
    br_code: '00020126...PIX',
    br_code_base64: 'data:image/png;base64,AAAA',
    expires_at: expiresInDays(30), // validade viva (relativa ao relogio, nao data fixa)
    paid_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
    // biome-ignore lint/suspicious/noExplicitAny: fixture de teste
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  injectedSlot = 'clone_x';
  mockConfig.BILLING_DUE_DATE_MODEL = false; // default OFF (comportamento atual)
});

/** next_due_date 'YYYY-MM-DD' a N dias de hoje (UTC) — pra exercitar a janela real. */
function dueInDays(n: number): string {
  const t = new Date();
  const due = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + n));
  return due.toISOString().slice(0, 10);
}

/** expires_at N dias no futuro (Date) — validade viva relativa ao relogio, sem data fixa. */
function expiresInDays(n: number): Date {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}

// ── cicloAtual (helper puro) ──────────────────────────────────────────────────
describe('cicloAtual', () => {
  it('formata YYYY-MM no fuso America/Sao_Paulo', () => {
    // 2026-07-01 02:00 UTC = 2026-06-30 23:00 BRT -> ciclo do mes de junho.
    expect(cicloAtual(new Date('2026-07-01T02:00:00.000Z'))).toBe('2026-06');
    // 2026-07-01 12:00 UTC = 2026-07-01 09:00 BRT -> julho.
    expect(cicloAtual(new Date('2026-07-01T12:00:00.000Z'))).toBe('2026-07');
  });
});

// ── GET /portal/mensalidade ───────────────────────────────────────────────────
describe('GET /portal/mensalidade', () => {
  it('200 com o shape completo (billing + charge do ciclo + dev_mode)', async () => {
    const expiresAt = expiresInDays(5); // validade no futuro, relativa ao relogio
    getBillingMock.mockResolvedValue(makeBilling());
    daysUntilDueMock.mockReturnValue(12);
    getChargeMock.mockResolvedValue(makeCharge({ expires_at: expiresAt }));

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/mensalidade' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      amount_cents: 19900,
      next_due_date: '2026-07-10',
      dias_restantes: 12,
      billing_status: 'active',
      charge: {
        cycle: cicloAtual(),
        status: 'pending',
        br_code: '00020126...PIX',
        br_code_base64: 'data:image/png;base64,AAAA',
        expires_at: expiresAt.toISOString(),
        paid_at: null,
        is_expired: false, // validade no futuro
      },
      dev_mode: true, // chave abc_dev_* no mock
    });
    // ISOLAMENTO: a query usa o slot da sessao, nunca input.
    expect(getBillingMock).toHaveBeenCalledWith('clone_x');
    expect(getChargeMock).toHaveBeenCalledWith('clone_x', cicloAtual());
    await app.close();
  });

  it('200 com nulls quando nao ha billing nem cobranca', async () => {
    getBillingMock.mockResolvedValue(null);
    getChargeMock.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/mensalidade' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      amount_cents: null,
      next_due_date: null,
      dias_restantes: null,
      billing_status: null,
      charge: null,
      dev_mode: true,
    });
    expect(daysUntilDueMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('isolamento: usa o slot do tenant da sessao (outro slot -> outra query)', async () => {
    injectedSlot = 'clone_outro';
    getBillingMock.mockResolvedValue(null);
    getChargeMock.mockResolvedValue(null);

    const app = await buildApp();
    await app.inject({ method: 'GET', url: '/portal/mensalidade' });

    expect(getBillingMock).toHaveBeenCalledWith('clone_outro');
    expect(getChargeMock).toHaveBeenCalledWith('clone_outro', cicloAtual());
    await app.close();
  });

  it('is_expired=true quando pending com validade no passado (front sabe que o QR venceu)', async () => {
    getBillingMock.mockResolvedValue(makeBilling());
    daysUntilDueMock.mockReturnValue(3);
    getChargeMock.mockResolvedValue(
      makeCharge({ status: 'pending', expires_at: new Date('2020-01-01T00:00:00.000Z') }),
    );

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/mensalidade' });

    expect(res.statusCode).toBe(200);
    expect(res.json().charge.is_expired).toBe(true);
    await app.close();
  });

  it('is_expired=false para cobranca paga mesmo com expires_at no passado', async () => {
    getBillingMock.mockResolvedValue(makeBilling());
    daysUntilDueMock.mockReturnValue(3);
    getChargeMock.mockResolvedValue(
      makeCharge({ status: 'paid', expires_at: new Date('2020-01-01T00:00:00.000Z') }),
    );

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/mensalidade' });

    expect(res.json().charge.is_expired).toBe(false);
    await app.close();
  });
});

// ── POST /portal/mensalidade/pix ──────────────────────────────────────────────
describe('POST /portal/mensalidade/pix', () => {
  it('200: gera a cobranca usando o amount do BANCO (nunca de input)', async () => {
    getBillingMock.mockResolvedValue(makeBilling({ amount_cents: 25000 }));
    ensureMock.mockResolvedValue({ charge: makeCharge({ amount_cents: 25000 }), created: true });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/mensalidade/pix',
      // Tentativa de injetar amount/slot pelo body — deve ser IGNORADA.
      payload: { amount_cents: 1, slot: 'clone_hacker' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ cycle: cicloAtual(), status: 'pending' });
    // amountCents veio do banco (25000), slot da sessao (clone_x), reissue ligado
    // (cliente sempre recebe um PIX pagavel — reemite o expirado sem duplicar).
    const callArgs = ensureMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(callArgs).toMatchObject({
      slot: 'clone_x',
      cycle: cicloAtual(),
      amountCents: 25000,
      reissueIfExpired: true,
    });
    await app.close();
  });

  it('409 sem_valor_configurado quando amount_cents e null', async () => {
    getBillingMock.mockResolvedValue(makeBilling({ amount_cents: null }));

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/mensalidade/pix' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'sem_valor_configurado' });
    expect(ensureMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('503 + Retry-After quando outra instancia segura o lock do slot', async () => {
    getBillingMock.mockResolvedValue(makeBilling({ amount_cents: 25000 }));
    ensureMock.mockRejectedValue(new billingCharges.BillingSlotBusyError('clone_x'));

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/mensalidade/pix' });

    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.json()).toEqual({ error: 'billing_busy', retry_after_seconds: 1 });
    await app.close();
  });

  it('409 sem_valor_configurado quando amount_cents e 0', async () => {
    getBillingMock.mockResolvedValue(makeBilling({ amount_cents: 0 }));

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/mensalidade/pix' });

    expect(res.statusCode).toBe(409);
    expect(ensureMock).not.toHaveBeenCalled();
    await app.close();
  });
});

// ── POST /portal/mensalidade/simular (Dev-only) ───────────────────────────────
describe('POST /portal/mensalidade/simular', () => {
  it('200 simulated quando ha cobranca com abacate_charge_id (Dev)', async () => {
    getChargeMock.mockResolvedValue(makeCharge({ abacate_charge_id: 'pix_char_xyz' }));
    simulatePaymentMock.mockResolvedValue({ id: 'pix_char_xyz', status: 'paid' });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/mensalidade/simular' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ simulated: true });
    // chargeId veio do slot da sessao, nao de input.
    expect(simulatePaymentMock).toHaveBeenCalledWith('pix_char_xyz');
    await app.close();
  });

  it('409 sem_cobranca quando nao ha cobranca com abacate_charge_id', async () => {
    getChargeMock.mockResolvedValue(makeCharge({ abacate_charge_id: null }));

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/mensalidade/simular' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'sem_cobranca' });
    expect(simulatePaymentMock).not.toHaveBeenCalled();
    await app.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADR 0014 — modelo por DATA DE VENCIMENTO (flag BILLING_DUE_DATE_MODEL = ON)
// ═══════════════════════════════════════════════════════════════════════════════

describe('GET /portal/mensalidade (flag ON — modelo por data)', () => {
  it('EM DIA (d=20): state=em_dia, charge=null, pode_gerar_pix=false — NAO consulta cobranca', async () => {
    mockConfig.BILLING_DUE_DATE_MODEL = true;
    getBillingMock.mockResolvedValue(
      makeBilling({ next_due_date: dueInDays(20), amount_cents: 19900 }),
    );

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/mensalidade' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.model).toBe('due_date');
    expect(body.state).toBe('em_dia');
    expect(body.pode_gerar_pix).toBe(false);
    expect(body.charge).toBeNull();
    // Em dia nao busca cobranca ativa (nem expoe PIX).
    expect(getActivePendingChargeMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('A VENCER (d=3): state=a_vencer, expoe a cobranca ATIVA do slot', async () => {
    mockConfig.BILLING_DUE_DATE_MODEL = true;
    getBillingMock.mockResolvedValue(
      makeBilling({ next_due_date: dueInDays(3), amount_cents: 19900 }),
    );
    getActivePendingChargeMock.mockResolvedValue(
      makeCharge({ abacate_charge_id: 'pix_char_ativa' }),
    );

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/mensalidade' });

    const body = res.json();
    expect(body.state).toBe('a_vencer');
    expect(body.pode_gerar_pix).toBe(true);
    expect(body.charge).not.toBeNull();
    expect(getActivePendingChargeMock).toHaveBeenCalledWith('clone_x');
    await app.close();
  });

  it('VENCIDO (d=-2): state=vencido, expoe cobranca ativa', async () => {
    mockConfig.BILLING_DUE_DATE_MODEL = true;
    getBillingMock.mockResolvedValue(
      makeBilling({ next_due_date: dueInDays(-2), amount_cents: 19900 }),
    );
    getActivePendingChargeMock.mockResolvedValue(makeCharge());

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/mensalidade' });

    expect(res.json().state).toBe('vencido');
    expect(res.json().pode_gerar_pix).toBe(true);
    await app.close();
  });

  it('SEM CONFIG (sem next_due_date): state=sem_config, charge=null', async () => {
    mockConfig.BILLING_DUE_DATE_MODEL = true;
    getBillingMock.mockResolvedValue(makeBilling({ next_due_date: null, amount_cents: null }));

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/mensalidade' });

    const body = res.json();
    expect(body.state).toBe('sem_config');
    expect(body.charge).toBeNull();
    expect(getActivePendingChargeMock).not.toHaveBeenCalled();
    await app.close();
  });

  // SCRUM-173/ADR 0039 F1 (achado do security): uma linha 'pending' SEM br_code (outbox em
  // voo/travado — gateway_call_state='calling') NUNCA pode aparecer como cobranca pagavel
  // pro cliente. Sem isso, o portal mostraria "cobranca pendente" sem QR — estado sem saida
  // que, com BILLING_OVERDUE_SILENCE + GRACE_DAYS=3, cala o bot no 4o dia sem o cliente
  // conseguir pagar.
  it('F1: cobranca pending SEM br_code (outbox travado) vira charge=null pro cliente, NAO is_expired', async () => {
    mockConfig.BILLING_DUE_DATE_MODEL = true;
    getBillingMock.mockResolvedValue(
      makeBilling({ next_due_date: dueInDays(3), amount_cents: 19900 }),
    );
    // Mesmo que a query real (getActivePendingCharge, F1) ja filtre br_code IS NOT NULL,
    // este teste garante defesa em profundidade na CAMADA DE VIEW: se por qualquer motivo
    // uma linha sem br_code chegar ate aqui, o portal NUNCA a expõe como pagavel.
    getActivePendingChargeMock.mockResolvedValue(
      makeCharge({ br_code: null, br_code_base64: null }),
    );

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/mensalidade' });

    const body = res.json();
    expect(body.charge).toBeNull();
    // NAO e is_expired=true — a linha nao esta expirada, so ainda nao pagavel. Sinal
    // errado levaria o front a tratar como "gere de novo" quando o outbox pode
    // completar sozinho no proximo request.
    await app.close();
  });

  it('cobranca pending COM br_code (caminho normal) continua exposta ao cliente', async () => {
    mockConfig.BILLING_DUE_DATE_MODEL = true;
    getBillingMock.mockResolvedValue(
      makeBilling({ next_due_date: dueInDays(3), amount_cents: 19900 }),
    );
    getActivePendingChargeMock.mockResolvedValue(makeCharge({ br_code: '00020126...PIX' }));

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/mensalidade' });

    const body = res.json();
    expect(body.charge).not.toBeNull();
    expect(body.charge.br_code).toBe('00020126...PIX');
    await app.close();
  });
});

describe('POST /portal/mensalidade/pix (flag ON — janela)', () => {
  it('EM DIA -> 409 fora_da_janela, NAO gera (sem antecipacao)', async () => {
    mockConfig.BILLING_DUE_DATE_MODEL = true;
    getBillingMock.mockResolvedValue(
      makeBilling({ next_due_date: dueInDays(20), amount_cents: 19900 }),
    );

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/mensalidade/pix' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'fora_da_janela', state: 'em_dia' });
    expect(ensureForSlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('A VENCER -> gera via ensurePixChargeForSlot (duePeriod = next_due_date, amount do banco)', async () => {
    mockConfig.BILLING_DUE_DATE_MODEL = true;
    const due = dueInDays(3);
    getBillingMock.mockResolvedValue(makeBilling({ next_due_date: due, amount_cents: 25000 }));
    ensureForSlotMock.mockResolvedValue({
      charge: makeCharge({ amount_cents: 25000 }),
      created: true,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/portal/mensalidade/pix',
      payload: { amount_cents: 1, slot: 'clone_hacker' }, // ignorado (anti-IDOR)
    });

    expect(res.statusCode).toBe(200);
    const callArgs = ensureForSlotMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(callArgs).toMatchObject({ slot: 'clone_x', duePeriod: due, amountCents: 25000 });
    await app.close();
  });

  it('VENCIDO -> gera (dentro da janela)', async () => {
    mockConfig.BILLING_DUE_DATE_MODEL = true;
    getBillingMock.mockResolvedValue(
      makeBilling({ next_due_date: dueInDays(-5), amount_cents: 19900 }),
    );
    ensureForSlotMock.mockResolvedValue({ charge: makeCharge(), created: true });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/mensalidade/pix' });

    expect(res.statusCode).toBe(200);
    expect(ensureForSlotMock).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('RE-COBRANCA (data movida pro passado) -> gera nova (dentro da janela)', async () => {
    mockConfig.BILLING_DUE_DATE_MODEL = true;
    getBillingMock.mockResolvedValue(
      makeBilling({ next_due_date: '2020-01-01', amount_cents: 19900 }),
    );
    ensureForSlotMock.mockResolvedValue({ charge: makeCharge(), created: true });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/mensalidade/pix' });

    expect(res.statusCode).toBe(200);
    const callArgs = ensureForSlotMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(callArgs).toMatchObject({ duePeriod: '2020-01-01' });
    await app.close();
  });

  it('sem valor configurado -> 409 sem_valor_configurado (antes da janela)', async () => {
    mockConfig.BILLING_DUE_DATE_MODEL = true;
    getBillingMock.mockResolvedValue(
      makeBilling({ next_due_date: dueInDays(-2), amount_cents: null }),
    );

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/portal/mensalidade/pix' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'sem_valor_configurado' });
    expect(ensureForSlotMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('flag OFF preserva o comportamento ATUAL (regressao)', () => {
  it('GET sem flag NAO retorna `state`/`model` nem chama getActivePendingCharge', async () => {
    // mockConfig.BILLING_DUE_DATE_MODEL ja e false (beforeEach).
    getBillingMock.mockResolvedValue(makeBilling());
    daysUntilDueMock.mockReturnValue(12);
    getChargeMock.mockResolvedValue(makeCharge());

    const app = await buildApp();
    const body = (await app.inject({ method: 'GET', url: '/portal/mensalidade' })).json();

    expect(body.model).toBeUndefined();
    expect(body.state).toBeUndefined();
    expect(body.pode_gerar_pix).toBeUndefined();
    // Caminho legado: cobranca do ciclo do mes (getCharge), nao a ativa do slot.
    expect(getChargeMock).toHaveBeenCalledWith('clone_x', cicloAtual());
    expect(getActivePendingChargeMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('POST sem flag gera via ensurePixChargeForCycle (sem checagem de janela)', async () => {
    getBillingMock.mockResolvedValue(
      makeBilling({ next_due_date: dueInDays(20), amount_cents: 19900 }),
    );
    ensureMock.mockResolvedValue({ charge: makeCharge(), created: true });

    const app = await buildApp();
    // Mesmo "em dia" (d=20), no modelo legado gera normalmente (nada de fora_da_janela).
    const res = await app.inject({ method: 'POST', url: '/portal/mensalidade/pix' });

    expect(res.statusCode).toBe(200);
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(ensureForSlotMock).not.toHaveBeenCalled();
    await app.close();
  });
});
