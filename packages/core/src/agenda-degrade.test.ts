import { describe, expect, it } from 'vitest';
import { isAgendaAutomaticaIntent, resolveEffectiveAgenda } from './agenda-degrade.js';

describe('isAgendaAutomaticaIntent (ADR 0030 D3)', () => {
  it('AUSENTE (undefined) = agenda por default (byte-idêntico ao funil vivo)', () => {
    expect(isAgendaAutomaticaIntent(undefined)).toBe(true);
    expect(isAgendaAutomaticaIntent(null)).toBe(true);
  });

  it('true / "true" = agenda', () => {
    expect(isAgendaAutomaticaIntent(true)).toBe(true);
    expect(isAgendaAutomaticaIntent('true')).toBe(true);
  });

  it('SÓ false / "false" = atendente (não é agenda)', () => {
    expect(isAgendaAutomaticaIntent(false)).toBe(false);
    expect(isAgendaAutomaticaIntent('false')).toBe(false);
  });

  it('valor lixo != false => cai no default agenda (não vira atendente por engano)', () => {
    expect(isAgendaAutomaticaIntent('sim')).toBe(true);
    expect(isAgendaAutomaticaIntent(0)).toBe(true);
  });
});

describe('resolveEffectiveAgenda (efetivo = intent && gcalConfigured)', () => {
  it('agenda escolhida MAS gcal não conectado => efetivo ATENDENTE (degrade)', () => {
    expect(resolveEffectiveAgenda(true, false)).toBe(false);
  });

  it('agenda escolhida E gcal conectado => efetivo AGENDA (Cirilo/Samuel inalterados)', () => {
    expect(resolveEffectiveAgenda(true, true)).toBe(true);
  });

  it('atendente por escolha => sempre atendente, tenha gcal ou não', () => {
    expect(resolveEffectiveAgenda(false, false)).toBe(false);
    expect(resolveEffectiveAgenda(false, true)).toBe(false);
  });
});
