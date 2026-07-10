import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ESTABELECIMENTO_SEAT_CAP,
  SIGNUP_AMOUNT_CENTS_BY_FORMAT,
  mapSignupFormat,
} from './signup-format.js';

// PORTAL_SIGNUP_AMOUNT_CENTS de produção hoje (R$99,99). O combo individual+agenda
// tem que usar EXATAMENTE este valor (byte-identidade do funil vivo).
const BASE = 9999;

describe('mapSignupFormat (ADR 0030 D2) — 4 combos', () => {
  it('sozinho + agenda = FUNIL VIVO: individual, sem gate novo, preço = base (byte-idêntico)', () => {
    const r = mapSignupFormat('sozinho', 'agenda', BASE);
    expect(r).toEqual({
      productType: 'individual',
      seatCap: null,
      agendaAutomatica: true,
      modoAtendenteEnabled: false,
      billingFromAgendaEnabled: false,
      amountCents: BASE,
    });
  });

  it('sozinho + atende: individual + modo_atendente_enabled + preço R$97', () => {
    const r = mapSignupFormat('sozinho', 'atende', BASE);
    expect(r.productType).toBe('individual');
    expect(r.seatCap).toBeNull();
    expect(r.agendaAutomatica).toBe(false);
    expect(r.modoAtendenteEnabled).toBe(true);
    expect(r.billingFromAgendaEnabled).toBe(false);
    expect(r.amountCents).toBe(SIGNUP_AMOUNT_CENTS_BY_FORMAT.individual_atendente);
    expect(r.amountCents).toBe(9700);
  });

  it('equipe + agenda: estabelecimento + seat_cap + billing_from_agenda + preço R$297', () => {
    const r = mapSignupFormat('equipe', 'agenda', BASE);
    expect(r.productType).toBe('estabelecimento');
    expect(r.seatCap).toBe(DEFAULT_ESTABELECIMENTO_SEAT_CAP);
    expect(r.agendaAutomatica).toBe(true);
    expect(r.modoAtendenteEnabled).toBe(false);
    expect(r.billingFromAgendaEnabled).toBe(true);
    expect(r.amountCents).toBe(SIGNUP_AMOUNT_CENTS_BY_FORMAT.estabelecimento_agenda);
    expect(r.amountCents).toBe(29700);
  });

  it('equipe + atende: estabelecimento + seat_cap + modo_atendente + preço R$197', () => {
    const r = mapSignupFormat('equipe', 'atende', BASE);
    expect(r.productType).toBe('estabelecimento');
    expect(r.seatCap).toBe(DEFAULT_ESTABELECIMENTO_SEAT_CAP);
    expect(r.agendaAutomatica).toBe(false);
    expect(r.modoAtendenteEnabled).toBe(true);
    expect(r.billingFromAgendaEnabled).toBe(false);
    expect(r.amountCents).toBe(SIGNUP_AMOUNT_CENTS_BY_FORMAT.estabelecimento_atendente);
    expect(r.amountCents).toBe(19700);
  });

  it('individual+agenda acompanha o base env (não é hardcoded)', () => {
    expect(mapSignupFormat('sozinho', 'agenda', 14700).amountCents).toBe(14700);
    expect(mapSignupFormat('sozinho', 'agenda', 5000).amountCents).toBe(5000);
  });
});
