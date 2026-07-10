import { describe, expect, it } from 'vitest';
import {
  isFaqPersonalizadoEnabled,
  resolveFaqPersonalizadoEnabled,
} from './faq-personalizado-gate.js';

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

describe('resolveFaqPersonalizadoEnabled (env→coluna, ADR 0030 D1)', () => {
  const MEDUZZA = 'clone_meduzza_barbearia_q23psc';
  const OUTRO = 'clone_cirilobarbearia_c8w2f0';

  it('env liga sem coluna (env é kill-switch/override global)', () => {
    expect(resolveFaqPersonalizadoEnabled(MEDUZZA, MEDUZZA, false)).toBe(true);
    expect(resolveFaqPersonalizadoEnabled(OUTRO, '*', false)).toBe(true);
    expect(resolveFaqPersonalizadoEnabled(OUTRO, '*', undefined)).toBe(true);
  });

  it('coluna liga sem env (self-service por-clone quando env deixar de ser "*")', () => {
    expect(resolveFaqPersonalizadoEnabled(MEDUZZA, '', true)).toBe(true);
    expect(resolveFaqPersonalizadoEnabled(OUTRO, undefined, true)).toBe(true);
  });

  it('ambos off -> off', () => {
    expect(resolveFaqPersonalizadoEnabled(MEDUZZA, '', false)).toBe(false);
    expect(resolveFaqPersonalizadoEnabled(OUTRO, 'outro_slot', false)).toBe(false);
    expect(resolveFaqPersonalizadoEnabled(MEDUZZA, undefined, undefined)).toBe(false);
  });

  it('BYTE-IDENTIDADE: com o env atual "*", o efetivo == env-only (ON) p/ qualquer coluna', () => {
    // env de produção hoje: FAQ_PERSONALIZADO_SLOTS = '*' -> cobre TODOS via a UNIÃO.
    const env = '*';
    for (const slot of [
      'clone_meduzza_barbearia_q23psc',
      'clone_cirilobarbearia_c8w2f0',
      'clone_barbearia_samuel_uefpqc',
      'clone_barber_dragon_caly8b',
    ]) {
      for (const col of [true, false, undefined, null] as const) {
        expect(resolveFaqPersonalizadoEnabled(slot, env, col)).toBe(
          isFaqPersonalizadoEnabled(slot, env),
        );
        expect(resolveFaqPersonalizadoEnabled(slot, env, col)).toBe(true);
      }
    }
  });
});
