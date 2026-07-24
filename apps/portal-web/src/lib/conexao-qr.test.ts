import { describe, expect, it } from 'vitest';
import { QR_SUGERIDO_APOS_TENTATIVAS, deveSugerirQr } from './conexao-qr';

describe('deveSugerirQr (SCRUM-82 — fallback esperto pro QR)', () => {
  it('não sugere o QR na 1ª tentativa (ainda pode ser um deslize)', () => {
    expect(deveSugerirQr(0)).toBe(false);
    expect(deveSugerirQr(1)).toBe(false);
  });

  it('sugere o QR a partir da 2ª tentativa (o código não está fechando)', () => {
    expect(deveSugerirQr(2)).toBe(true);
    expect(deveSugerirQr(3)).toBe(true);
    expect(deveSugerirQr(9)).toBe(true);
  });

  it('o limiar é exatamente QR_SUGERIDO_APOS_TENTATIVAS', () => {
    expect(deveSugerirQr(QR_SUGERIDO_APOS_TENTATIVAS - 1)).toBe(false);
    expect(deveSugerirQr(QR_SUGERIDO_APOS_TENTATIVAS)).toBe(true);
  });
});
