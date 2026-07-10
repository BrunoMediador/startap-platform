import { describe, expect, it } from 'vitest';
import { isModoAtendenteEnabled, resolveModoAtendenteEnabled } from './modo-atendente-gate.js';

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

describe('resolveModoAtendenteEnabled (env→coluna, ADR 0030 D1)', () => {
  const PILOTO = 'clone_piloto_atendente';
  const OUTRO = 'cirilobarbearia';

  it('env liga sem coluna (env é kill-switch/override global)', () => {
    expect(resolveModoAtendenteEnabled(PILOTO, PILOTO, false)).toBe(true);
    expect(resolveModoAtendenteEnabled(PILOTO, PILOTO, undefined)).toBe(true);
    expect(resolveModoAtendenteEnabled(OUTRO, '*', null)).toBe(true);
  });

  it('coluna liga sem env (self-service por-clone)', () => {
    expect(resolveModoAtendenteEnabled(PILOTO, '', true)).toBe(true);
    expect(resolveModoAtendenteEnabled(PILOTO, undefined, true)).toBe(true);
    expect(resolveModoAtendenteEnabled(OUTRO, null, true)).toBe(true);
  });

  it('ambos off -> off', () => {
    expect(resolveModoAtendenteEnabled(PILOTO, '', false)).toBe(false);
    expect(resolveModoAtendenteEnabled(PILOTO, undefined, undefined)).toBe(false);
    expect(resolveModoAtendenteEnabled(OUTRO, 'outro_slot', false)).toBe(false);
  });

  it('só === true liga a coluna (não-boolean/undefined = off)', () => {
    expect(resolveModoAtendenteEnabled(PILOTO, '', null)).toBe(false);
    expect(resolveModoAtendenteEnabled(PILOTO, '', undefined)).toBe(false);
  });

  it('BYTE-IDENTIDADE: com o env atual (Meduzza), o efetivo == env-only p/ qualquer coluna', () => {
    // env de produção hoje: MODO_ATENDENTE_SLOTS = slug da Meduzza.
    const env = 'clone_meduzza_barbearia_q23psc';
    // Meduzza (no env E backfillada na coluna): ON antes e depois, coluna não altera nada.
    for (const col of [true, false, undefined, null] as const) {
      expect(resolveModoAtendenteEnabled('clone_meduzza_barbearia_q23psc', env, col)).toBe(
        isModoAtendenteEnabled('clone_meduzza_barbearia_q23psc', env),
      );
    }
    // Cirilo/Samuel/dragon (fora do env de modo, coluna false no backfill): OFF antes e depois.
    for (const slot of [
      'clone_cirilobarbearia_c8w2f0',
      'clone_barbearia_samuel_uefpqc',
      'clone_barber_dragon_caly8b',
    ]) {
      expect(resolveModoAtendenteEnabled(slot, env, false)).toBe(isModoAtendenteEnabled(slot, env));
      expect(resolveModoAtendenteEnabled(slot, env, false)).toBe(false);
    }
  });
});
