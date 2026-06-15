/**
 * Testes do package-phone — HMAC do telefone do cliente final para saldo de pacote
 * (ADR 0025 §4). Pontos críticos:
 *  - pepper PRÓPRIO (PACKAGE_PHONE_PEPPER), NÃO o do trial → impede join cross-tabela;
 *  - validação LAZY (boot nunca crasha sem a env — lição #247);
 *  - determinístico, sem vazar o número (LGPD).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PackagePepperMissingError,
  isPackagePepperConfigured,
  packagePhoneHmac,
} from './package-phone.js';
import { trialPhoneHmac } from './trial.js';

const PKG_PEPPER = 'package-pepper-de-teste-32-chars!!';
const TRIAL_PEPPER = 'trial-pepper-de-teste-com-32-chars';

describe('packagePhoneHmac', () => {
  beforeEach(() => {
    vi.stubEnv('PACKAGE_PHONE_PEPPER', PKG_PEPPER);
    vi.stubEnv('TRIAL_PHONE_PEPPER', TRIAL_PEPPER);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('é determinístico: mesmo número => mesmo hash (lookup O(1) no índice)', () => {
    expect(packagePhoneHmac('553199998842')).toBe(packagePhoneHmac('553199998842'));
  });

  it('números diferentes => hashes diferentes', () => {
    expect(packagePhoneHmac('553199998842')).not.toBe(packagePhoneHmac('553199998843'));
  });

  it('o hash NUNCA contém o número (LGPD)', () => {
    const h = packagePhoneHmac('553199998842');
    expect(h).not.toContain('99998842');
    expect(h).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it('USA PEPPER PRÓPRIO: hash de pacote ≠ hash de trial p/ o MESMO número (sem join trivial)', () => {
    // Decisão LGPD do ADR 0025 §4: peppers separados impedem join entre
    // trial_ledger e client_package_credits pelo hash.
    const num = '553199998842';
    expect(packagePhoneHmac(num)).not.toBe(trialPhoneHmac(num));
  });

  it('lança PackagePepperMissingError sem pepper (validação LAZY — boot nunca crasha)', () => {
    vi.stubEnv('PACKAGE_PHONE_PEPPER', '');
    expect(() => packagePhoneHmac('553199998842')).toThrow(PackagePepperMissingError);
  });

  it('lança com pepper curto demais (<16 chars)', () => {
    vi.stubEnv('PACKAGE_PHONE_PEPPER', 'curto');
    expect(() => packagePhoneHmac('553199998842')).toThrow(PackagePepperMissingError);
  });

  it('NÃO cai no pepper do trial quando o de pacote falta (são independentes)', () => {
    // Só o trial configurado: pacote AINDA deve falhar (não há fallback p/ a chave do trial).
    vi.stubEnv('PACKAGE_PHONE_PEPPER', '');
    expect(isPackagePepperConfigured()).toBe(false);
    expect(() => packagePhoneHmac('553199998842')).toThrow(PackagePepperMissingError);
  });

  it('isPackagePepperConfigured reflete o estado sem lançar', () => {
    expect(isPackagePepperConfigured()).toBe(true);
    vi.stubEnv('PACKAGE_PHONE_PEPPER', '');
    expect(isPackagePepperConfigured()).toBe(false);
  });
});
