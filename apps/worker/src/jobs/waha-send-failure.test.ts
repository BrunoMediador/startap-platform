/**
 * Taxonomia de falha de envio WAHA (SCRUM-53, P2 do security).
 * DEFINITIVA (rollback) só quando temos CERTEZA de que não saiu; AMBÍGUA (mantém carimbo) no resto.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDefinitiveNonDelivery, sendWithSettleTimeout } from './waha-send-failure.js';

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

describe('sendWithSettleTimeout — erro do WAHA colado no deadline classifica pelo STATUS (SCRUM-126)', () => {
  const OPTS = { deadlineMs: 10_000, settleGraceMs: 3_000 };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('422 que chega ~20ms APÓS o deadline é RELANÇADO e classifica DEFINITIVO — não vira "timeout" ambíguo', async () => {
    // O bug do incidente Cirilo: o 422 (sessão FAILED) chegava logo depois do timeout de 10s; o
    // Promise.race ingênuo descartava a resposta e rotulava tudo como "sendText timeout" (ambíguo).
    const send = () =>
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error('WAHA /api/sendText -> HTTP 422: Session status is not WORKING')),
          OPTS.deadlineMs + 20,
        ),
      );
    const p = sendWithSettleTimeout(send, OPTS).catch((e) => e as Error);
    await vi.advanceTimersByTimeAsync(OPTS.deadlineMs + OPTS.settleGraceMs);
    const err = (await p) as Error;
    expect(err.message).toMatch(/HTTP 422/);
    // O ponto: esse erro relançado é DEFINITIVO → dispara rollback do carimbo → reenvia.
    expect(isDefinitiveNonDelivery(err)).toBe(true);
  });

  it('SEM resposta nenhuma dentro de deadline+grace (rede pendurada) → lança "sendText timeout" (AMBÍGUO)', async () => {
    const send = () => new Promise<void>(() => {}); // nunca assenta
    const p = sendWithSettleTimeout(send, OPTS).catch((e) => e as Error);
    await vi.advanceTimersByTimeAsync(OPTS.deadlineMs + OPTS.settleGraceMs + 5);
    const err = (await p) as Error;
    // Falta-de-resposta genuína = AMBÍGUO → mantém o carimbo → NÃO reenvia (não duplica pra pagante).
    expect(err.message).toBe('sendText timeout');
    expect(isDefinitiveNonDelivery(err)).toBe(false);
  });

  it('envio OK dentro do deadline → resolve normalmente (caminho saudável, sem esperar o grace)', async () => {
    const send = () => new Promise<string>((resolve) => setTimeout(() => resolve('ok'), 200));
    const p = sendWithSettleTimeout(send, OPTS);
    await vi.advanceTimersByTimeAsync(300);
    await expect(p).resolves.toBe('ok');
  });

  it('422 DENTRO do deadline também classifica definitivo (não precisa do grace)', async () => {
    const send = () =>
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('WAHA /api/sendText -> HTTP 422: not WORKING')), 500),
      );
    const p = sendWithSettleTimeout(send, OPTS).catch((e) => e as Error);
    await vi.advanceTimersByTimeAsync(600);
    expect(isDefinitiveNonDelivery(await p)).toBe(true);
  });
});
