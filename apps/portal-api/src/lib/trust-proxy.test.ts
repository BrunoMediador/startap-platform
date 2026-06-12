import { describe, expect, it } from 'vitest';
import { parseTrustProxy } from './trust-proxy.js';

describe('parseTrustProxy (security review PR #268, P1 #3)', () => {
  it('default (env ausente/vazia) = só hops em faixa privada — NUNCA true', () => {
    expect(parseTrustProxy(undefined)).toEqual(['loopback', 'uniquelocal']);
    expect(parseTrustProxy('')).toEqual(['loopback', 'uniquelocal']);
    expect(parseTrustProxy('   ')).toEqual(['loopback', 'uniquelocal']);
  });

  it("'true'/'false' explícitos viram boolean (escape hatch operacional)", () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('CSV de IPs/CIDRs vira array trimado (config fina por env, sem deploy)', () => {
    expect(parseTrustProxy('172.18.0.0/16, 10.0.0.5')).toEqual(['172.18.0.0/16', '10.0.0.5']);
  });
});
