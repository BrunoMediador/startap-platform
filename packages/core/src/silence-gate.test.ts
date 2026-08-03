import { describe, expect, it } from 'vitest';
import { OWNER_PAUSE_KIND, resolveSilenceGate } from './silence-gate.js';

/** daysUntilDue determinístico pra teste: recebe o mapa fixo do cenário. */
function fixedDaysUntilDue(days: number | null) {
  return (_nextDueDate: string | null) => days;
}

describe('OWNER_PAUSE_KIND (contrato de schema)', () => {
  it('é "owner_request" — literal usado em suspended_kind por todo o sistema (WHERE de queries, portal-conexao)', () => {
    // Fonte ÚNICA nasce AQUI (@startap/core); @startap/db/queries/flow-clones.ts REEXPORTA
    // este mesmo valor (não duplica) — a prova de que os dois pacotes nunca divergem está em
    // packages/db/src/queries/flow-clones-owner-pause.test.ts (testa o import real, não um
    // 2º literal digitado — comparar 2 literais escritos à mão nunca pega divergência real).
    expect(OWNER_PAUSE_KIND).toBe('owner_request');
  });
});

describe('resolveSilenceGate (gate único de silêncio total)', () => {
  it('(a) flow_enabled=false + suspended_kind=owner_request -> NÃO silencia mas NÃO responde (pausa do dono, cliente ativo)', () => {
    const result = resolveSilenceGate(
      {
        flow_enabled: false,
        suspended_kind: 'owner_request',
        next_due_date: null,
        billing_amount_cents: null,
      },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(null), billingOverdueSilenceOn: true },
    );
    expect(result).toEqual({ silenced: false, respond: false });
  });

  it('MATRIZ (2ª linha): owner_request + EM DIA -> PROCESSA, NÃO responde (pausa gravada, bot só não responde por escolha do dono)', () => {
    const result = resolveSilenceGate(
      {
        flow_enabled: false,
        suspended_kind: 'owner_request',
        next_due_date: '2099-01-01',
        billing_amount_cents: 8500,
      },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(9999), billingOverdueSilenceOn: true },
    );
    expect(result).toEqual({ silenced: false, respond: false });
  });

  it('MATRIZ (3ª linha): owner_request + VENCIDO ALÉM DA CARÊNCIA -> SILÊNCIO TOTAL (os dois eixos são independentes, não um OR condicionado pelo eixo do dono)', () => {
    const result = resolveSilenceGate(
      {
        flow_enabled: false,
        suspended_kind: 'owner_request',
        next_due_date: '2026-01-01',
        billing_amount_cents: 8500,
      },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(-4), billingOverdueSilenceOn: true },
    );
    expect(result).toEqual({ silenced: true, reason: 'billing-overdue', diasRestantes: -4 });
  });

  it('MATRIZ: cliente PAGA (mesma linha, next_due_date passa a futuro) enquanto segue owner_request -> VOLTA A PROCESSAR, seguindo pausado (prova a frase do Bruno: pagar remove só a camada de inadimplência, não a pausa do dono)', () => {
    const antesDePagar = resolveSilenceGate(
      {
        flow_enabled: false,
        suspended_kind: 'owner_request',
        next_due_date: '2026-01-01',
        billing_amount_cents: 8500,
      },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(-4), billingOverdueSilenceOn: true },
    );
    expect(antesDePagar).toEqual({ silenced: true, reason: 'billing-overdue', diasRestantes: -4 });

    // Mesmo clone, next_due_date agora no futuro (pagou) — flow_enabled/suspended_kind
    // intactos (pagar NUNCA reativa owner_request, regra 8 do regras-negocio.md).
    const depoisDePagar = resolveSilenceGate(
      {
        flow_enabled: false,
        suspended_kind: 'owner_request',
        next_due_date: '2026-09-01',
        billing_amount_cents: 8500,
      },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(30), billingOverdueSilenceOn: true },
    );
    // silenced:false + respond:false = "volta a processar" (grava human_reply/antibot) mas
    // o bot segue mudo porque `owner_request` continua ativo — é o próprio gate que resolve
    // isso agora (respond), o caller só consome o campo.
    expect(depoisDePagar).toEqual({ silenced: false, respond: false });
  });

  describe('casos REAIS medidos em prod 31/07 e 03/08 (clones com flow_enabled=false, todos owner_request)', () => {
    it('Ingrid — owner_request, EM DIA (vence 23/08) -> PROCESSA, NÃO responde (pausas continuam sendo gravadas)', () => {
      const result = resolveSilenceGate(
        {
          flow_enabled: false,
          suspended_kind: 'owner_request',
          next_due_date: '2026-08-23',
          billing_amount_cents: 8500,
        },
        { graceDays: 3, daysUntilDue: fixedDaysUntilDue(23), billingOverdueSilenceOn: true },
      );
      expect(result).toEqual({ silenced: false, respond: false });
    });

    it('MVS — owner_request, vencido 2 dias (26/07), DENTRO da carência de 3 -> PROCESSA, NÃO responde', () => {
      const result = resolveSilenceGate(
        {
          flow_enabled: false,
          suspended_kind: 'owner_request',
          next_due_date: '2026-07-26',
          billing_amount_cents: 8500,
        },
        { graceDays: 3, daysUntilDue: fixedDaysUntilDue(-2), billingOverdueSilenceOn: true },
      );
      expect(result).toEqual({ silenced: false, respond: false });
    });

    it('Samuel — owner_request, EM DIA (vence em +21d) -> PROCESSA, NÃO responde (bug real medido 03/08, PR de fix)', () => {
      const result = resolveSilenceGate(
        {
          flow_enabled: false,
          suspended_kind: 'owner_request',
          next_due_date: '2026-08-24',
          billing_amount_cents: 5000,
        },
        { graceDays: 3, daysUntilDue: fixedDaysUntilDue(21), billingOverdueSilenceOn: true },
      );
      expect(result).toEqual({ silenced: false, respond: false });
    });

    it('Meduzza — owner_request desde 20/07, vencida 4 dias (27/07), ALÉM da carência de 3 -> SILÊNCIO TOTAL', () => {
      const result = resolveSilenceGate(
        {
          flow_enabled: false,
          suspended_kind: 'owner_request',
          next_due_date: '2026-07-27',
          billing_amount_cents: 8500,
        },
        { graceDays: 3, daysUntilDue: fixedDaysUntilDue(-4), billingOverdueSilenceOn: true },
      );
      expect(result).toEqual({ silenced: true, reason: 'billing-overdue', diasRestantes: -4 });
    });

    it('Meduzza — pausado (owner_request) + vencido -7d (bem além da carência) -> SILÊNCIO TOTAL (matriz linha 3, eixos coexistem)', () => {
      const result = resolveSilenceGate(
        {
          flow_enabled: false,
          suspended_kind: 'owner_request',
          next_due_date: '2026-07-24',
          billing_amount_cents: 8500,
        },
        { graceDays: 3, daysUntilDue: fixedDaysUntilDue(-7), billingOverdueSilenceOn: true },
      );
      expect(result).toEqual({ silenced: true, reason: 'billing-overdue', diasRestantes: -7 });
    });
  });

  it('(b) flow_enabled=false + suspended_kind=billing (suspensão da Startap por inadimplência) -> silencia', () => {
    const result = resolveSilenceGate(
      {
        flow_enabled: false,
        suspended_kind: 'billing',
        next_due_date: null,
        billing_amount_cents: null,
      },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(null), billingOverdueSilenceOn: true },
    );
    expect(result).toEqual({ silenced: true, reason: 'flow-suspended', diasRestantes: null });
  });

  it('(b) flow_enabled=false + suspended_kind=manual_other (suspensão manual da Startap) -> silencia', () => {
    const result = resolveSilenceGate(
      {
        flow_enabled: false,
        suspended_kind: 'manual_other',
        next_due_date: null,
        billing_amount_cents: null,
      },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(null), billingOverdueSilenceOn: true },
    );
    expect(result).toEqual({ silenced: true, reason: 'flow-suspended', diasRestantes: null });
  });

  it('(b) flow_enabled=false + suspended_kind=abuse -> silencia', () => {
    const result = resolveSilenceGate(
      {
        flow_enabled: false,
        suspended_kind: 'abuse',
        next_due_date: null,
        billing_amount_cents: null,
      },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(null), billingOverdueSilenceOn: true },
    );
    expect(result).toEqual({ silenced: true, reason: 'flow-suspended', diasRestantes: null });
  });

  it('(c) flow_enabled=false + suspended_kind=null (fail-safe) -> NÃO silencia; RESPONDE (fail-safe protege processamento, não é pausa reconhecida do dono)', () => {
    const result = resolveSilenceGate(
      {
        flow_enabled: false,
        suspended_kind: null,
        next_due_date: null,
        billing_amount_cents: null,
      },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(null), billingOverdueSilenceOn: true },
    );
    expect(result).toEqual({ silenced: false, respond: true });
  });

  it('(d) vencido além da carência + flag ON + flow_enabled=true -> silenced (billing-overdue), eixo billing intacto', () => {
    const result = resolveSilenceGate(
      {
        flow_enabled: true,
        suspended_kind: null,
        next_due_date: '2026-01-01',
        billing_amount_cents: 8500,
      },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(-4), billingOverdueSilenceOn: true },
    );
    expect(result).toEqual({ silenced: true, reason: 'billing-overdue', diasRestantes: -4 });
  });

  it('(e) caso do Bruno E2E: cliente novo, bot pausado por ele (owner_request), sem billing configurado ainda -> NÃO silencia, NÃO responde (human_reply seria gravado normalmente pelo caller)', () => {
    const result = resolveSilenceGate(
      {
        flow_enabled: false,
        suspended_kind: 'owner_request',
        next_due_date: null,
        billing_amount_cents: null,
      },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(null), billingOverdueSilenceOn: true },
    );
    expect(result.silenced).toBe(false);
    if (!result.silenced) expect(result.respond).toBe(false);
  });

  it('dragon — NÃO pausado + EM DIA -> responde normal (MATRIZ 1ª linha)', () => {
    const result = resolveSilenceGate(
      {
        flow_enabled: true,
        suspended_kind: null,
        next_due_date: '2026-12-01',
        billing_amount_cents: 8500,
      },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(120), billingOverdueSilenceOn: true },
    );
    expect(result).toEqual({ silenced: false, respond: true });
  });

  it('vencido dentro da carência (-3, último dia) -> NÃO silencia, responde', () => {
    const result = resolveSilenceGate(
      {
        flow_enabled: true,
        suspended_kind: null,
        next_due_date: '2026-01-01',
        billing_amount_cents: 8500,
      },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(-3), billingOverdueSilenceOn: true },
    );
    expect(result).toEqual({ silenced: false, respond: true });
  });

  it('(f) flag OFF -> nunca silencia por vencimento (só o eixo manual continua valendo)', () => {
    const result = resolveSilenceGate(
      {
        flow_enabled: true,
        suspended_kind: null,
        next_due_date: '2026-01-01',
        billing_amount_cents: 8500,
      },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(-30), billingOverdueSilenceOn: false },
    );
    expect(result).toEqual({ silenced: false, respond: true });
  });

  it('sem billing (next_due_date null) -> nunca silencia por vencimento', () => {
    const result = resolveSilenceGate(
      { flow_enabled: true, suspended_kind: null, next_due_date: null, billing_amount_cents: 8500 },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(-30), billingOverdueSilenceOn: true },
    );
    expect(result).toEqual({ silenced: false, respond: true });
  });

  it('amount_cents=0 (guard) -> nunca silencia por vencimento mesmo vencido', () => {
    const result = resolveSilenceGate(
      {
        flow_enabled: true,
        suspended_kind: null,
        next_due_date: '2026-01-01',
        billing_amount_cents: 0,
      },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(-30), billingOverdueSilenceOn: true },
    );
    expect(result).toEqual({ silenced: false, respond: true });
  });

  it('em dia (diasRestantes positivo) -> NÃO silencia', () => {
    const result = resolveSilenceGate(
      {
        flow_enabled: true,
        suspended_kind: null,
        next_due_date: '2026-12-01',
        billing_amount_cents: 8500,
      },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(20), billingOverdueSilenceOn: true },
    );
    expect(result).toEqual({ silenced: false, respond: true });
  });

  it('suspensão não-do-dono (billing) tem precedência no motivo sobre vencido (ambos os eixos true)', () => {
    const result = resolveSilenceGate(
      {
        flow_enabled: false,
        suspended_kind: 'billing',
        next_due_date: '2026-01-01',
        billing_amount_cents: 8500,
      },
      { graceDays: 3, daysUntilDue: fixedDaysUntilDue(-100), billingOverdueSilenceOn: true },
    );
    expect(result.silenced).toBe(true);
    if (result.silenced) expect(result.reason).toBe('flow-suspended');
  });
});
