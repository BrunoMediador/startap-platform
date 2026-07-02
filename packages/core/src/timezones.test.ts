import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMEZONE, isValidIanaTimezone, timezoneSchema } from './timezones.js';

describe('isValidIanaTimezone', () => {
  it('aceita o default America/Sao_Paulo', () => {
    expect(isValidIanaTimezone('America/Sao_Paulo')).toBe(true);
    expect(isValidIanaTimezone(DEFAULT_TIMEZONE)).toBe(true);
  });

  it('aceita fuso IANA válido não-SP (ex.: America/Cuiaba — Mato Grosso)', () => {
    // Nomes de zona canônicos (estáveis em qualquer ICU); NÃO uso abreviações como
    // 'UTC', que Intl.supportedValuesOf inclui ou não conforme o build do runtime.
    expect(isValidIanaTimezone('America/Cuiaba')).toBe(true);
    expect(isValidIanaTimezone('Europe/Lisbon')).toBe(true);
    expect(isValidIanaTimezone('America/New_York')).toBe(true);
  });

  it('rejeita nome fora da lista IANA', () => {
    expect(isValidIanaTimezone('Marte/Olympus')).toBe(false);
    expect(isValidIanaTimezone('America/SaoPaulo')).toBe(false); // sem underscore
  });

  it('rejeita offset cru / string livre (guardar SEMPRE nome IANA)', () => {
    expect(isValidIanaTimezone('UTC-3')).toBe(false);
    expect(isValidIanaTimezone('-03:00')).toBe(false);
    expect(isValidIanaTimezone('GMT-3')).toBe(false);
  });

  it('é case-sensitive (a lista IANA é canônica)', () => {
    expect(isValidIanaTimezone('america/cuiaba')).toBe(false);
  });

  it('rejeita não-strings', () => {
    expect(isValidIanaTimezone(undefined)).toBe(false);
    expect(isValidIanaTimezone(null)).toBe(false);
    expect(isValidIanaTimezone(123)).toBe(false);
    expect(isValidIanaTimezone({})).toBe(false);
  });
});

describe('timezoneSchema', () => {
  it('ausente (undefined) => default America/Sao_Paulo (invariante byte-idêntico)', () => {
    const r = timezoneSchema.safeParse(undefined);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe('America/Sao_Paulo');
  });

  it('fuso válido não-SP passa e é preservado', () => {
    const r = timezoneSchema.safeParse('America/Cuiaba');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe('America/Cuiaba');
  });

  it('fuso inválido => erro com mensagem timezone_invalido', () => {
    const r = timezoneSchema.safeParse('Marte/Olympus');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe('timezone_invalido');
  });

  it('offset cru => rejeitado', () => {
    expect(timezoneSchema.safeParse('UTC-3').success).toBe(false);
  });

  it('tipo inválido (número) => rejeitado com timezone_invalido', () => {
    const r = timezoneSchema.safeParse(123);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe('timezone_invalido');
  });
});
