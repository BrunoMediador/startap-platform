import { describe, expect, it } from 'vitest';
import { isGcalForbiddenOrAuthError, isGcalRateLimitError } from './gcal-rate-limit.js';

describe('isGcalRateLimitError', () => {
  it('detecta rateLimitExceeded no corpo JSON', () => {
    const msg =
      'GCal /calendars/x/events -> HTTP 403: {"error":{"errors":[{"reason":"rateLimitExceeded"}]}}';
    expect(isGcalRateLimitError(msg)).toBe(true);
  });

  it('detecta userRateLimitExceeded no corpo JSON', () => {
    const msg =
      'GCal /calendars/x/events -> HTTP 403: {"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}';
    expect(isGcalRateLimitError(msg)).toBe(true);
  });

  it('detecta variacao textual quota/rate limit em 403', () => {
    const msg = 'GCal /calendars/x/events -> HTTP 403: Quota exceeded for quota metric';
    expect(isGcalRateLimitError(msg)).toBe(true);
  });

  it('NAO classifica 403 forbidden real (credencial revogada) como rate-limit', () => {
    const msg =
      'GCal /calendars/x/events -> HTTP 403: {"error":{"errors":[{"reason":"forbidden"}]}}';
    expect(isGcalRateLimitError(msg)).toBe(false);
  });

  it('NAO classifica 401 como rate-limit', () => {
    const msg = 'GCal /calendars/x/events -> HTTP 401: invalid_grant';
    expect(isGcalRateLimitError(msg)).toBe(false);
  });

  it('NAO classifica 500 como rate-limit', () => {
    const msg = 'GCal /calendars/x/events -> HTTP 500: backend error';
    expect(isGcalRateLimitError(msg)).toBe(false);
  });
});

describe('isGcalForbiddenOrAuthError', () => {
  it('403 forbidden real -> true', () => {
    const msg =
      'GCal /calendars/x/events -> HTTP 403: {"error":{"errors":[{"reason":"forbidden"}]}}';
    expect(isGcalForbiddenOrAuthError(msg)).toBe(true);
  });

  it('401 -> true', () => {
    expect(isGcalForbiddenOrAuthError('GCal /x -> HTTP 401: invalid_grant')).toBe(true);
  });

  it('403 rate-limit -> false (nao é forbidden real)', () => {
    const msg =
      'GCal /calendars/x/events -> HTTP 403: {"error":{"errors":[{"reason":"rateLimitExceeded"}]}}';
    expect(isGcalForbiddenOrAuthError(msg)).toBe(false);
  });

  it('500 -> false', () => {
    expect(isGcalForbiddenOrAuthError('GCal /x -> HTTP 500: boom')).toBe(false);
  });
});
