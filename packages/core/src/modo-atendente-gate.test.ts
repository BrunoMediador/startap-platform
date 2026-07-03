import { describe, expect, it } from 'vitest';
import { isModoAtendenteEnabled } from './modo-atendente-gate.js';

describe('isModoAtendenteEnabled', () => {
  const PILOTO = 'clone_piloto_atendente';

  it('vazio -> OFF pra todos (default seguro)', () => {
    expect(isModoAtendenteEnabled(PILOTO, '')).toBe(false);
  });

  it('undefined / null -> OFF pra todos', () => {
    expect(isModoAtendenteEnabled(PILOTO, undefined)).toBe(false);
    expect(isModoAtendenteEnabled(PILOTO, null)).toBe(false);
  });

  it('slot listado -> ON só nesse slot', () => {
    expect(isModoAtendenteEnabled(PILOTO, PILOTO)).toBe(true);
  });

  it('outro slot fora da lista -> OFF (Cirilo/Samuel inalterados)', () => {
    expect(isModoAtendenteEnabled('cirilobarbearia', PILOTO)).toBe(false);
    expect(isModoAtendenteEnabled('samuel_slot', PILOTO)).toBe(false);
  });

  it('wildcard "*" -> ON pra qualquer slot', () => {
    expect(isModoAtendenteEnabled(PILOTO, '*')).toBe(true);
    expect(isModoAtendenteEnabled('cirilobarbearia', '*')).toBe(true);
  });

  it('lista com vários slots -> ON só nos listados', () => {
    const cfg = 'clone_a,clone_piloto_atendente,clone_b';
    expect(isModoAtendenteEnabled(PILOTO, cfg)).toBe(true);
    expect(isModoAtendenteEnabled('clone_a', cfg)).toBe(true);
    expect(isModoAtendenteEnabled('clone_c', cfg)).toBe(false);
  });

  it('tolera espaços e trailing/leading comma', () => {
    expect(isModoAtendenteEnabled(PILOTO, ` , ${PILOTO} , `)).toBe(true);
    expect(isModoAtendenteEnabled('clone_c', '  clone_a  ,  clone_b  ')).toBe(false);
  });

  it('só vírgulas/espaços (sem entradas reais) -> OFF', () => {
    expect(isModoAtendenteEnabled(PILOTO, ' , , ')).toBe(false);
  });

  it('match é EXATO — prefixo não liga (sem cruzar tenant)', () => {
    expect(isModoAtendenteEnabled('clone_piloto_atendente_extra', PILOTO)).toBe(false);
    expect(isModoAtendenteEnabled('clone_piloto', PILOTO)).toBe(false);
  });
});
