import { describe, expect, it } from 'vitest';
import { isHumanReplyAgendaEnabled } from './human-reply-agenda-gate.js';

describe('isHumanReplyAgendaEnabled (SCRUM-68 Onda 4)', () => {
  const DRAGON = 'clone_barber_dragon_caly8b';

  it('vazio -> OFF pra todos (default seguro = byte-idêntico)', () => {
    expect(isHumanReplyAgendaEnabled(DRAGON, '')).toBe(false);
  });

  it('undefined / null -> OFF pra todos', () => {
    expect(isHumanReplyAgendaEnabled(DRAGON, undefined)).toBe(false);
    expect(isHumanReplyAgendaEnabled(DRAGON, null)).toBe(false);
  });

  it('slot listado -> ON só nesse slot', () => {
    expect(isHumanReplyAgendaEnabled(DRAGON, DRAGON)).toBe(true);
  });

  it('outro slot fora da lista -> OFF (Cirilo/Samuel inalterados)', () => {
    expect(isHumanReplyAgendaEnabled('clone_cirilobarbearia_c8w2f0', DRAGON)).toBe(false);
    expect(isHumanReplyAgendaEnabled('clone_barbearia_samuel_uefpqc', DRAGON)).toBe(false);
  });

  it('wildcard "*" -> ON pra qualquer slot', () => {
    expect(isHumanReplyAgendaEnabled(DRAGON, '*')).toBe(true);
    expect(isHumanReplyAgendaEnabled('clone_cirilobarbearia_c8w2f0', '*')).toBe(true);
  });

  it('lista com vários slots -> ON só nos listados', () => {
    const cfg = 'clone_a,clone_barber_dragon_caly8b,clone_b';
    expect(isHumanReplyAgendaEnabled(DRAGON, cfg)).toBe(true);
    expect(isHumanReplyAgendaEnabled('clone_a', cfg)).toBe(true);
    expect(isHumanReplyAgendaEnabled('clone_c', cfg)).toBe(false);
  });

  it('tolera espaços e trailing/leading comma', () => {
    expect(isHumanReplyAgendaEnabled(DRAGON, ` , ${DRAGON} , `)).toBe(true);
    expect(isHumanReplyAgendaEnabled('clone_c', '  clone_a  ,  clone_b  ')).toBe(false);
  });

  it('só vírgulas/espaços (sem entradas reais) -> OFF', () => {
    expect(isHumanReplyAgendaEnabled(DRAGON, ' , , ')).toBe(false);
  });

  it('match é EXATO — prefixo não liga (sem cruzar tenant)', () => {
    expect(isHumanReplyAgendaEnabled('clone_barber_dragon_caly8b_extra', DRAGON)).toBe(false);
    expect(isHumanReplyAgendaEnabled('clone_barber_dragon', DRAGON)).toBe(false);
  });
});
