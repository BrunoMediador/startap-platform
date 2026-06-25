import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import type { GoogleContaResponse } from './api-types';
import {
  hasGoogleConta,
  isGoogleContaFeatureOff,
  showPrestadorField,
  toGoogleContaState,
} from './google-conta';

describe('isGoogleContaFeatureOff', () => {
  it('trata 404 como feature-off (flag GOOGLE_ACCOUNT_PORTAL_ENABLED desligada)', () => {
    expect(isGoogleContaFeatureOff(new ApiError(404, 'not found', null))).toBe(true);
  });

  it('NÃO é feature-off pra erro de rede (status 0) nem 500', () => {
    expect(isGoogleContaFeatureOff(new ApiError(0, 'sem conexao', null))).toBe(false);
    expect(isGoogleContaFeatureOff(new ApiError(500, 'boom', null))).toBe(false);
  });

  it('ignora erros que não são ApiError', () => {
    expect(isGoogleContaFeatureOff(new Error('qualquer'))).toBe(false);
    expect(isGoogleContaFeatureOff(null)).toBe(false);
    expect(isGoogleContaFeatureOff(undefined)).toBe(false);
  });
});

describe('toGoogleContaState', () => {
  it('com credencial -> hasCredencial true e expõe e-mail + senha', () => {
    const data: GoogleContaResponse = {
      google_account_email: 'barbearia@gmail.com',
      google_account_password: 'segredo123',
    };
    expect(toGoogleContaState(data)).toEqual({
      hasCredencial: true,
      email: 'barbearia@gmail.com',
      password: 'segredo123',
    });
  });

  it('feature ON sem credencial (campos null) -> hasCredencial false (some)', () => {
    const data: GoogleContaResponse = {
      google_account_email: null,
      google_account_password: null,
    };
    expect(toGoogleContaState(data).hasCredencial).toBe(false);
  });

  it('precisa de e-mail E senha — só um dos dois não basta', () => {
    expect(
      toGoogleContaState({ google_account_email: 'a@b.com', google_account_password: null })
        .hasCredencial,
    ).toBe(false);
    expect(
      toGoogleContaState({ google_account_email: null, google_account_password: 'x' })
        .hasCredencial,
    ).toBe(false);
  });

  it('e-mail só com espaços conta como vazio (não renderiza)', () => {
    expect(
      toGoogleContaState({ google_account_email: '   ', google_account_password: 'x' })
        .hasCredencial,
    ).toBe(false);
  });

  it('trima o e-mail mas preserva a senha exatamente (espaços podem ser do segredo)', () => {
    const state = toGoogleContaState({
      google_account_email: '  a@b.com  ',
      google_account_password: ' pw com espaco ',
    });
    expect(state.email).toBe('a@b.com');
    expect(state.password).toBe(' pw com espaco ');
    expect(state.hasCredencial).toBe(true);
  });

  it('undefined/null -> estado vazio', () => {
    expect(toGoogleContaState(undefined).hasCredencial).toBe(false);
    expect(toGoogleContaState(null).hasCredencial).toBe(false);
  });
});

describe('hasGoogleConta', () => {
  it('é o atalho do hasCredencial do estado', () => {
    expect(hasGoogleConta({ google_account_email: 'a@b.com', google_account_password: 'x' })).toBe(
      true,
    );
    expect(hasGoogleConta({ google_account_email: null, google_account_password: null })).toBe(
      false,
    );
  });
});

describe('showPrestadorField', () => {
  it('esconde o campo de prestador no ESTABELECIMENTO', () => {
    expect(showPrestadorField('estabelecimento')).toBe(false);
  });

  it('mostra o campo no SOLO/individual', () => {
    expect(showPrestadorField('individual')).toBe(true);
  });

  it('ausente/null/undefined -> mostra (default individual, não regride)', () => {
    expect(showPrestadorField(undefined)).toBe(true);
    expect(showPrestadorField(null)).toBe(true);
  });
});
