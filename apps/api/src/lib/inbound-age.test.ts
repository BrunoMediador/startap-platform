/**
 * Testes do corte de idade de mensagem inbound (incidente WAHA 26h fora do ar,
 * 28-30/07 — backlog reentregue processado como novo).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import type { WahaWebhookBody } from '@startap/core/types';
import { checkInboundAge } from './inbound-age.js';

const MAX_AGE = 20; // minutos, mesmo default do config.schema.ts

function bodyWithTimestampSeconds(tsSeconds: number | string | null): WahaWebhookBody {
  return {
    event: 'message',
    session: 'clone_teste',
    payload: {
      id: 'msg1',
      from: '5535999998888@c.us',
      fromMe: false,
      body: 'oi',
      _data: tsSeconds === null ? {} : { messageTimestamp: tsSeconds },
    },
  } as WahaWebhookBody;
}

describe('checkInboundAge', () => {
  const NOW_MS = 1_753_833_600_000; // fixo, arbitrário

  it('mensagem recente (5min) -> stale:false', () => {
    const tsSeconds = Math.floor(NOW_MS / 1000) - 5 * 60;
    const result = checkInboundAge(bodyWithTimestampSeconds(tsSeconds), MAX_AGE, NOW_MS);
    expect(result.stale).toBe(false);
    expect(result.ageMinutes).toBeCloseTo(5, 5);
  });

  it('mensagem de 21min (> teto de 20min) -> stale:true', () => {
    const tsSeconds = Math.floor(NOW_MS / 1000) - 21 * 60;
    const result = checkInboundAge(bodyWithTimestampSeconds(tsSeconds), MAX_AGE, NOW_MS);
    expect(result.stale).toBe(true);
    expect(result.ageMinutes).toBeCloseTo(21, 5);
  });

  it('fronteira exata de 20min (== teto) -> stale:false (só > descarta, não >=)', () => {
    const tsSeconds = Math.floor(NOW_MS / 1000) - 20 * 60;
    const result = checkInboundAge(bodyWithTimestampSeconds(tsSeconds), MAX_AGE, NOW_MS);
    expect(result.stale).toBe(false);
    expect(result.ageMinutes).toBeCloseTo(20, 5);
  });

  it('fronteira 20min + 1s (logo acima do teto) -> stale:true', () => {
    const tsSeconds = Math.floor(NOW_MS / 1000) - (20 * 60 + 1);
    const result = checkInboundAge(bodyWithTimestampSeconds(tsSeconds), MAX_AGE, NOW_MS);
    expect(result.stale).toBe(true);
  });

  it('sem messageTimestamp -> fail-open, stale:false, ageMinutes:null', () => {
    const result = checkInboundAge(bodyWithTimestampSeconds(null), MAX_AGE, NOW_MS);
    expect(result.stale).toBe(false);
    expect(result.ageMinutes).toBeNull();
  });

  it('messageTimestamp como string (serialização NOWEB) -> mesmo resultado que number', () => {
    const tsSeconds = Math.floor(NOW_MS / 1000) - 25 * 60;
    const result = checkInboundAge(bodyWithTimestampSeconds(String(tsSeconds)), MAX_AGE, NOW_MS);
    expect(result.stale).toBe(true);
    expect(result.ageMinutes).toBeCloseTo(25, 5);
  });

  it('messageTimestamp inválido (não-numérico) -> fail-open, stale:false', () => {
    const result = checkInboundAge(bodyWithTimestampSeconds('not-a-number'), MAX_AGE, NOW_MS);
    expect(result.stale).toBe(false);
    expect(result.ageMinutes).toBeNull();
  });

  it('messageTimestamp futuro (relógio adiantado/skew) -> idade negativa, nunca stale', () => {
    const tsSeconds = Math.floor(NOW_MS / 1000) + 60;
    const result = checkInboundAge(bodyWithTimestampSeconds(tsSeconds), MAX_AGE, NOW_MS);
    expect(result.stale).toBe(false);
    expect(result.ageMinutes).toBeLessThan(0);
  });
});
