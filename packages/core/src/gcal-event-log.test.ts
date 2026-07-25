import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashEventIdForLog } from './gcal-event-log.js';

describe('hashEventIdForLog (SCRUM-91 — id do log nunca é cru)', () => {
  it('prefixa sha256:, tem 16 hex chars e NÃO contém o id cru', () => {
    const raw = 'abc123_evento_cru';
    const h = hashEventIdForLog(raw);
    expect(h).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(h).not.toContain(raw);
  });

  it('é determinístico (mesmo id → mesmo hash)', () => {
    expect(hashEventIdForLog('ev_x')).toBe(hashEventIdForLog('ev_x'));
  });

  it('ids distintos → hashes distintos', () => {
    expect(hashEventIdForLog('ev_a')).not.toBe(hashEventIdForLog('ev_b'));
  });

  it('bate com o sha256 hex truncado a 16 (transformação estável)', () => {
    const raw = 'gcal_event_deterministico';
    const esperado = `sha256:${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
    expect(hashEventIdForLog(raw)).toBe(esperado);
  });
});
