import { describe, expect, it } from 'vitest';
import { isAtendFromAgendaEnabled } from './atend-from-agenda-gate.js';

describe('isAtendFromAgendaEnabled', () => {
  const DRAGON = 'clone_barber_dragon_caly8b';

  it('vazio -> OFF pra todos (default seguro)', () => {
    expect(isAtendFromAgendaEnabled(DRAGON, '')).toBe(false);
  });

  it('undefined / null -> OFF pra todos', () => {
    expect(isAtendFromAgendaEnabled(DRAGON, undefined)).toBe(false);
    expect(isAtendFromAgendaEnabled(DRAGON, null)).toBe(false);
  });

  it('slot listado -> ON só nesse slot', () => {
    expect(isAtendFromAgendaEnabled(DRAGON, DRAGON)).toBe(true);
  });

  it('outro slot fora da lista -> OFF (Cirilo/Samuel inalterados)', () => {
    expect(isAtendFromAgendaEnabled('cirilobarbearia', DRAGON)).toBe(false);
    expect(isAtendFromAgendaEnabled('samuel_slot', DRAGON)).toBe(false);
  });

  it('wildcard "*" -> ON pra qualquer slot', () => {
    expect(isAtendFromAgendaEnabled(DRAGON, '*')).toBe(true);
    expect(isAtendFromAgendaEnabled('cirilobarbearia', '*')).toBe(true);
    expect(isAtendFromAgendaEnabled('qualquer_slot', '*')).toBe(true);
  });

  it('lista com vários slots -> ON só nos listados', () => {
    const cfg = 'clone_a,clone_barber_dragon_caly8b,clone_b';
    expect(isAtendFromAgendaEnabled(DRAGON, cfg)).toBe(true);
    expect(isAtendFromAgendaEnabled('clone_a', cfg)).toBe(true);
    expect(isAtendFromAgendaEnabled('clone_c', cfg)).toBe(false);
  });

  it('tolera espaços e trailing/leading comma', () => {
    expect(isAtendFromAgendaEnabled(DRAGON, ` , ${DRAGON} , `)).toBe(true);
    expect(isAtendFromAgendaEnabled('clone_a', '  clone_a  ,  clone_b  ')).toBe(true);
    expect(isAtendFromAgendaEnabled('clone_c', '  clone_a  ,  clone_b  ')).toBe(false);
  });

  it('só vírgulas/espaços (sem entradas reais) -> OFF', () => {
    expect(isAtendFromAgendaEnabled(DRAGON, ' , , ')).toBe(false);
  });

  it('match é EXATO — prefixo não liga (sem cruzar tenant)', () => {
    expect(isAtendFromAgendaEnabled('clone_barber_dragon_caly8b_extra', DRAGON)).toBe(false);
    expect(isAtendFromAgendaEnabled('clone_barber', DRAGON)).toBe(false);
  });
});
