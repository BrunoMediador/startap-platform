import { describe, expect, it } from 'vitest';
import { isFaqPersonalizadoEnabled } from './faq-personalizado-gate.js';

describe('isFaqPersonalizadoEnabled', () => {
  const MEDUZZA = 'clone_meduzza_barbearia_q23psc';

  it('vazio -> OFF pra todos (default seguro)', () => {
    expect(isFaqPersonalizadoEnabled(MEDUZZA, '')).toBe(false);
  });

  it('undefined / null -> OFF pra todos', () => {
    expect(isFaqPersonalizadoEnabled(MEDUZZA, undefined)).toBe(false);
    expect(isFaqPersonalizadoEnabled(MEDUZZA, null)).toBe(false);
  });

  it('slot listado -> ON só nesse slot', () => {
    expect(isFaqPersonalizadoEnabled(MEDUZZA, MEDUZZA)).toBe(true);
  });

  it('outro slot fora da lista -> OFF (Cirilo/Samuel inalterados)', () => {
    expect(isFaqPersonalizadoEnabled('cirilobarbearia', MEDUZZA)).toBe(false);
    expect(isFaqPersonalizadoEnabled('samuel_slot', MEDUZZA)).toBe(false);
  });

  it('wildcard "*" -> ON pra qualquer slot', () => {
    expect(isFaqPersonalizadoEnabled(MEDUZZA, '*')).toBe(true);
    expect(isFaqPersonalizadoEnabled('cirilobarbearia', '*')).toBe(true);
  });

  it('lista com vários slots -> ON só nos listados', () => {
    const cfg = `clone_a,${MEDUZZA},clone_b`;
    expect(isFaqPersonalizadoEnabled(MEDUZZA, cfg)).toBe(true);
    expect(isFaqPersonalizadoEnabled('clone_a', cfg)).toBe(true);
    expect(isFaqPersonalizadoEnabled('clone_c', cfg)).toBe(false);
  });

  it('tolera espaços e trailing/leading comma', () => {
    expect(isFaqPersonalizadoEnabled(MEDUZZA, ` , ${MEDUZZA} , `)).toBe(true);
    expect(isFaqPersonalizadoEnabled('clone_c', '  clone_a  ,  clone_b  ')).toBe(false);
  });

  it('só vírgulas/espaços (sem entradas reais) -> OFF', () => {
    expect(isFaqPersonalizadoEnabled(MEDUZZA, ' , , ')).toBe(false);
  });

  it('match é EXATO — prefixo não liga (sem cruzar tenant)', () => {
    expect(isFaqPersonalizadoEnabled(`${MEDUZZA}_extra`, MEDUZZA)).toBe(false);
    expect(isFaqPersonalizadoEnabled('clone_meduzza', MEDUZZA)).toBe(false);
  });
});
