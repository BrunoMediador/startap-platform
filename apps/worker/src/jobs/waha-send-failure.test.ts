/**
 * Taxonomia de falha de envio WAHA (SCRUM-53, P2 do security).
 * DEFINITIVA (rollback) só quando temos CERTEZA de que não saiu; AMBÍGUA (mantém carimbo) no resto.
 */
import { describe, expect, it } from 'vitest';
import { isDefinitiveNonDelivery } from './waha-send-failure.js';

describe('isDefinitiveNonDelivery — DEFINITIVA (rollback seguro)', () => {
  it('WAHA HTTP 422 (sessão não-WORKING/FAILED) = definitiva (caso do incidente ALERTAS morta)', () => {
    expect(
      isDefinitiveNonDelivery(
        new Error('WAHA /api/sendText -> HTTP 422: {"message":"Session status is not WORKING"}'),
      ),
    ).toBe(true);
  });

  it('WAHA HTTP 404 (sessão/chat não encontrado) = definitiva', () => {
    expect(
      isDefinitiveNonDelivery(new Error('WAHA /api/sendText -> HTTP 404: session not found')),
    ).toBe(true);
  });

  it('ECONNREFUSED / ENOTFOUND (nem conectou) = definitiva — via err.cause.code e via mensagem', () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    expect(isDefinitiveNonDelivery(refused)).toBe(true);
    const dns = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    expect(isDefinitiveNonDelivery(dns)).toBe(true);
    expect(isDefinitiveNonDelivery(new Error('connect ECONNREFUSED 127.0.0.1:3000'))).toBe(true);
  });

  it('texto "session status" independente do status = definitiva', () => {
    expect(isDefinitiveNonDelivery(new Error('session status is FAILED'))).toBe(true);
  });
});

describe('isDefinitiveNonDelivery — AMBÍGUA (mantém carimbo, não arrisca duplicar)', () => {
  it('timeout do Promise.race = AMBÍGUO (pode ter entregue)', () => {
    expect(isDefinitiveNonDelivery(new Error('sendText timeout'))).toBe(false);
  });

  it('HTTP 5xx genérico = AMBÍGUO (WAHA pode ter processado)', () => {
    expect(
      isDefinitiveNonDelivery(new Error('WAHA /api/sendText -> HTTP 500: internal error')),
    ).toBe(false);
    expect(isDefinitiveNonDelivery(new Error('WAHA /api/sendText -> HTTP 502: bad gateway'))).toBe(
      false,
    );
  });

  it('ECONNRESET (conexão resetada, pode ter saído) = AMBÍGUO', () => {
    const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    expect(isDefinitiveNonDelivery(reset)).toBe(false);
  });

  it('erro desconhecido / não-Error = AMBÍGUO (default conservador)', () => {
    expect(isDefinitiveNonDelivery(new Error('boom'))).toBe(false);
    expect(isDefinitiveNonDelivery('deu ruim')).toBe(false);
    expect(isDefinitiveNonDelivery(undefined)).toBe(false);
  });
});
