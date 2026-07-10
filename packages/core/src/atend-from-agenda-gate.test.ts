import { describe, expect, it } from 'vitest';
import {
  isAtendFromAgendaEnabled,
  resolveAtendFromAgendaEnabled,
} from './atend-from-agenda-gate.js';

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

describe('resolveAtendFromAgendaEnabled (env→coluna, ADR 0030 D1)', () => {
  const DRAGON = 'clone_barber_dragon_caly8b';
  const OUTRO = 'clone_novo_individual';

  it('env liga sem coluna (env é kill-switch/override global)', () => {
    expect(resolveAtendFromAgendaEnabled(DRAGON, DRAGON, false)).toBe(true);
    expect(resolveAtendFromAgendaEnabled(DRAGON, DRAGON, undefined)).toBe(true);
    expect(resolveAtendFromAgendaEnabled(OUTRO, '*', null)).toBe(true);
  });

  it('coluna liga sem env (self-service por-clone)', () => {
    expect(resolveAtendFromAgendaEnabled(DRAGON, '', true)).toBe(true);
    expect(resolveAtendFromAgendaEnabled(OUTRO, undefined, true)).toBe(true);
  });

  it('ambos off -> off', () => {
    expect(resolveAtendFromAgendaEnabled(DRAGON, '', false)).toBe(false);
    expect(resolveAtendFromAgendaEnabled(OUTRO, 'outro_slot', false)).toBe(false);
    expect(resolveAtendFromAgendaEnabled(DRAGON, undefined, undefined)).toBe(false);
  });

  it('BYTE-IDENTIDADE: com o env atual (dragon,cirilo,samuel), efetivo == env-only p/ qualquer coluna', () => {
    // env de produção hoje: ATEND_FROM_AGENDA_SLOTS = dragon,cirilo,samuel (slugs reais).
    const env =
      'clone_barber_dragon_caly8b,clone_cirilobarbearia_c8w2f0,clone_barbearia_samuel_uefpqc';
    const backfilled = [
      'clone_barber_dragon_caly8b',
      'clone_cirilobarbearia_c8w2f0',
      'clone_barbearia_samuel_uefpqc',
    ];
    // Os 3 no env E backfillados na coluna: ON antes e depois; coluna não altera.
    for (const slot of backfilled) {
      for (const col of [true, false, undefined, null] as const) {
        expect(resolveAtendFromAgendaEnabled(slot, env, col)).toBe(
          isAtendFromAgendaEnabled(slot, env),
        );
      }
      expect(resolveAtendFromAgendaEnabled(slot, env, false)).toBe(true);
    }
    // Meduzza (fora do env de billing, coluna false): OFF antes e depois.
    expect(resolveAtendFromAgendaEnabled('clone_meduzza_barbearia_q23psc', env, false)).toBe(
      isAtendFromAgendaEnabled('clone_meduzza_barbearia_q23psc', env),
    );
    expect(resolveAtendFromAgendaEnabled('clone_meduzza_barbearia_q23psc', env, false)).toBe(false);
  });
});
