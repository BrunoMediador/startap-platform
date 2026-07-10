import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ESTABELECIMENTO_SEAT_CAP,
  SIGNUP_AMOUNT_CENTS_BY_FORMAT,
  mapSignupFormat,
} from './signup-format.js';

describe('mapSignupFormat (ADR 0030 D2 / SCRUM-68 Onda 3) — 4 combos', () => {
  it('individual + agenda = FUNIL VIVO: individual, sem gate atendente, billing-da-agenda ON, R$147', () => {
    const r = mapSignupFormat('individual', 'agenda');
    expect(r).toEqual({
      productType: 'individual',
      seatCap: null,
      agendaAutomatica: true,
      modoAtendenteEnabled: false,
      // ADR 0027: agenda ⇒ billing-da-agenda também no individual (formato novo ganha o /billing).
      billingFromAgendaEnabled: true,
      amountCents: 14700,
    });
    expect(r.amountCents).toBe(SIGNUP_AMOUNT_CENTS_BY_FORMAT.individual_agenda);
  });

  it('individual + atende: individual + modo_atendente_enabled + billing OFF + R$97', () => {
    const r = mapSignupFormat('individual', 'atende');
    expect(r.productType).toBe('individual');
    expect(r.seatCap).toBeNull();
    expect(r.agendaAutomatica).toBe(false);
    expect(r.modoAtendenteEnabled).toBe(true);
    expect(r.billingFromAgendaEnabled).toBe(false);
    expect(r.amountCents).toBe(SIGNUP_AMOUNT_CENTS_BY_FORMAT.individual_atendente);
    expect(r.amountCents).toBe(9700);
  });

  it("'atendente' (valor REAL do front) === 'atende' — sinônimos do modo atendente", () => {
    const a = mapSignupFormat('individual', 'atendente');
    const b = mapSignupFormat('individual', 'atende');
    expect(a).toEqual(b);
    expect(a.agendaAutomatica).toBe(false);
    expect(a.modoAtendenteEnabled).toBe(true);
  });

  it('estabelecimento + agenda: estabelecimento + seat_cap + billing_from_agenda + R$297', () => {
    const r = mapSignupFormat('estabelecimento', 'agenda');
    expect(r.productType).toBe('estabelecimento');
    expect(r.seatCap).toBe(DEFAULT_ESTABELECIMENTO_SEAT_CAP);
    expect(r.agendaAutomatica).toBe(true);
    expect(r.modoAtendenteEnabled).toBe(false);
    expect(r.billingFromAgendaEnabled).toBe(true);
    expect(r.amountCents).toBe(SIGNUP_AMOUNT_CENTS_BY_FORMAT.estabelecimento_agenda);
    expect(r.amountCents).toBe(29700);
  });

  it('estabelecimento + atende: estabelecimento + seat_cap + modo_atendente + R$197', () => {
    const r = mapSignupFormat('estabelecimento', 'atende');
    expect(r.productType).toBe('estabelecimento');
    expect(r.seatCap).toBe(DEFAULT_ESTABELECIMENTO_SEAT_CAP);
    expect(r.agendaAutomatica).toBe(false);
    expect(r.modoAtendenteEnabled).toBe(true);
    expect(r.billingFromAgendaEnabled).toBe(false);
    expect(r.amountCents).toBe(SIGNUP_AMOUNT_CENTS_BY_FORMAT.estabelecimento_atendente);
    expect(r.amountCents).toBe(19700);
  });

  it('preço vem SÓ da grade — individual+agenda é 14700 fixo (não amarrado a env)', () => {
    // Chamado N vezes: sempre 14700 (sem parâmetro de base env; grade oficial do PM).
    expect(mapSignupFormat('individual', 'agenda').amountCents).toBe(14700);
    expect(mapSignupFormat('estabelecimento', 'atendente').amountCents).toBe(19700);
  });
});
