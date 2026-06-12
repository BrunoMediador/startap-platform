import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrialPepperMissingError, isTrialPepperConfigured, trialPhoneHmac } from './trial.js';

const PEPPER = 'pepper-de-teste-com-32-caracteres!';

describe('trialPhoneHmac', () => {
  beforeEach(() => {
    vi.stubEnv('TRIAL_PHONE_PEPPER', PEPPER);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('é determinístico: mesmo número => mesmo hash (lookup O(1) no ledger)', () => {
    expect(trialPhoneHmac('553199998842')).toBe(trialPhoneHmac('553199998842'));
  });

  it('números diferentes => hashes diferentes', () => {
    expect(trialPhoneHmac('553199998842')).not.toBe(trialPhoneHmac('553199998843'));
  });

  it('o hash NUNCA contém o número (LGPD)', () => {
    const h = trialPhoneHmac('553199998842');
    expect(h).not.toContain('99998842');
    expect(h).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it('lança TrialPepperMissingError sem pepper (validação LAZY — boot nunca crasha)', () => {
    vi.stubEnv('TRIAL_PHONE_PEPPER', '');
    expect(() => trialPhoneHmac('553199998842')).toThrow(TrialPepperMissingError);
  });

  it('lança com pepper curto demais (<16 chars)', () => {
    vi.stubEnv('TRIAL_PHONE_PEPPER', 'curto');
    expect(() => trialPhoneHmac('553199998842')).toThrow(TrialPepperMissingError);
  });

  it('isTrialPepperConfigured reflete o estado sem lançar', () => {
    expect(isTrialPepperConfigured()).toBe(true);
    vi.stubEnv('TRIAL_PHONE_PEPPER', '');
    expect(isTrialPepperConfigured()).toBe(false);
  });
});
