/**
 * Testa o autofill do alert_owner_phone (#329) com o guard do MODO ATENDENTE (SCRUM-62).
 *
 * Regra nova: clones em MODO_ATENDENTE_SLOTS NÃO são re-preenchidos — o dono pode LIMPAR o
 * campo no portal (NULL) e o clear precisa PERSISTIR (senão o próximo WORKING re-gravaria o
 * me.id). Demais clones seguem preenchendo normal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setCloneAlertOwnerPhoneIfEmpty: vi.fn(),
  // Resolver env→coluna (ADR 0030 D1) mockado como env-only — o teste usa process.env
  // (stubEnv MODO_ATENDENTE_SLOTS); byte-idêntico ao isModoAtendenteEnabled de antes.
  csvGate: (slot: string, csv?: string | null): boolean => {
    if (!csv) return false;
    const e = csv
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return e.includes('*') || e.includes(slot);
  },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('@startap/db', () => ({
  flowClones: {
    setCloneAlertOwnerPhoneIfEmpty: mocks.setCloneAlertOwnerPhoneIfEmpty,
    resolveModoAtendenteEnabledForSlot: (slot: string, csv?: string | null) =>
      mocks.csvGate(slot, csv),
  },
}));

import { autofillAlertOwnerPhone } from './alert-owner-autofill.js';

const MODO_SLOT = 'clone_meduzza_barbearia_q23psc';
const OUTRO_SLOT = 'clone_cirilo_barbearia';
const ME_ID = '5531999998842@c.us';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setCloneAlertOwnerPhoneIfEmpty.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('autofillAlertOwnerPhone — guard do modo atendente (SCRUM-62)', () => {
  it('PULA clones em MODO_ATENDENTE_SLOTS (não re-preenche, pro clear persistir)', async () => {
    vi.stubEnv('MODO_ATENDENTE_SLOTS', MODO_SLOT);

    const r = await autofillAlertOwnerPhone(MODO_SLOT, ME_ID);

    expect(r).toEqual({ status: 'skipped', reason: 'modo-atendente' });
    expect(mocks.setCloneAlertOwnerPhoneIfEmpty).not.toHaveBeenCalled();
  });

  it('SEGUE preenchendo os demais clones (fora do gate)', async () => {
    vi.stubEnv('MODO_ATENDENTE_SLOTS', MODO_SLOT);

    const r = await autofillAlertOwnerPhone(OUTRO_SLOT, ME_ID);

    expect(r).toEqual({ status: 'filled', slot: OUTRO_SLOT });
    expect(mocks.setCloneAlertOwnerPhoneIfEmpty).toHaveBeenCalledWith(OUTRO_SLOT, ME_ID);
  });

  it('gate vazio (default): preenche normal (byte-idêntico ao de antes)', async () => {
    vi.stubEnv('MODO_ATENDENTE_SLOTS', '');

    const r = await autofillAlertOwnerPhone(MODO_SLOT, ME_ID);

    expect(r).toEqual({ status: 'filled', slot: MODO_SLOT });
    expect(mocks.setCloneAlertOwnerPhoneIfEmpty).toHaveBeenCalledWith(MODO_SLOT, ME_ID);
  });
});
