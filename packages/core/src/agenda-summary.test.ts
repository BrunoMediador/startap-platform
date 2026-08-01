import { describe, expect, it } from 'vitest';
import {
  buildEventSummary,
  mesmoTelefone,
  normalizeClientePhone,
  parseEventSummary,
} from './agenda-summary.js';

describe('normalizeClientePhone — delega a ensureDddBr (ADR 0028)', () => {
  it('nacional sem DDI ganha o 55 (caso do dragon)', () => {
    expect(normalizeClientePhone('3599247411')).toEqual({ ok: true, digits: '553599247411' });
  });

  it('preserva o 9º dígito quando já presente (Cirilo/Samuel)', () => {
    expect(normalizeClientePhone('5511979630828')).toEqual({ ok: true, digits: '5511979630828' });
    expect(normalizeClientePhone('5535991746797')).toEqual({ ok: true, digits: '5535991746797' });
  });

  it('preserva a ausência do 9º dígito (Seven 7)', () => {
    expect(normalizeClientePhone('556599453860')).toEqual({ ok: true, digits: '556599453860' });
  });

  it('vazio → reason=vazio', () => {
    expect(normalizeClientePhone('')).toEqual({ ok: false, reason: 'vazio' });
    expect(normalizeClientePhone('   ')).toEqual({ ok: false, reason: 'vazio' });
  });

  it('DDD inexistente → reason=invalido (não passa lixo pra frente)', () => {
    expect(normalizeClientePhone('00999999999')).toEqual({ ok: false, reason: 'invalido' });
  });

  it('lixo/JID de grupo → reason=invalido', () => {
    expect(normalizeClientePhone('12345')).toEqual({ ok: false, reason: 'invalido' });
  });
});

describe('buildEventSummary — fonte única de montagem do título', () => {
  it('com telefone: "Nome - Servico | WhatsApp: digitos"', () => {
    expect(
      buildEventSummary({ nome: 'João Pedro', servico: 'Corte', telefoneDigits: '5511999998888' }),
    ).toBe('João Pedro - Corte | WhatsApp: 5511999998888');
  });

  it('sem telefone: "Nome - Servico" (compat com legado)', () => {
    expect(buildEventSummary({ nome: 'João Pedro', servico: 'Corte' })).toBe('João Pedro - Corte');
  });

  it('sanitiza " - " e "|" em nome/serviço para não quebrar o parser (bug latente corrigido)', () => {
    expect(
      buildEventSummary({
        nome: 'Ana - Maria',
        servico: 'Corte | Barba',
        telefoneDigits: '5511999998888',
      }),
    ).toBe('Ana Maria - Corte Barba | WhatsApp: 5511999998888');
  });
});

describe('mesmoTelefone — comparação por IDENTIDADE (canonicalE164, não ensureDddBr)', () => {
  it('COM-9 vs SEM-9 do mesmo número → true (o caso que o includes() quebrava)', () => {
    expect(mesmoTelefone('5511979630828', '551179630828')).toBe(true);
  });

  it('nacional sem DDI vs E.164 completo do mesmo número → true', () => {
    expect(mesmoTelefone('11979630828', '5511979630828')).toBe(true);
  });

  it('JID/pontuação variados do mesmo número → true', () => {
    expect(mesmoTelefone('5511979630828@c.us', '+55 (11) 97963-0828')).toBe(true);
  });

  it('números genuinamente diferentes → false', () => {
    expect(mesmoTelefone('5511979630828', '5531999998842')).toBe(false);
  });

  it('um lado vazio/null/undefined → false (nunca combina por ausência)', () => {
    expect(mesmoTelefone('', '5511979630828')).toBe(false);
    expect(mesmoTelefone(null, '5511979630828')).toBe(false);
    expect(mesmoTelefone(undefined, undefined)).toBe(false);
  });

  it('ambos lixo/inválido (dois null de canonicalE164) → false, NUNCA true', () => {
    expect(mesmoTelefone('abc', 'xyz')).toBe(false);
    expect(mesmoTelefone('123', '456')).toBe(false);
  });
});

describe('parseEventSummary — fonte única de parse (unifica portal + worker)', () => {
  it('formato completo: nome, serviço e telefone', () => {
    expect(parseEventSummary('João Pedro - Corte | WhatsApp: 5511999998888')).toEqual({
      nome: 'João Pedro',
      servico: 'Corte',
      telefone: '5511999998888',
    });
  });

  it('sem telefone: telefone fica undefined', () => {
    expect(parseEventSummary('João Pedro - Corte')).toEqual({
      nome: 'João Pedro',
      servico: 'Corte',
      telefone: undefined,
    });
  });

  it('sem separador " - " (texto solto): nome = texto inteiro, servico vazio', () => {
    expect(parseEventSummary('Fulano Atendimento')).toEqual({
      nome: 'Fulano Atendimento',
      servico: '',
      telefone: undefined,
    });
  });

  it('sufixo "| WhatsApp:" vazio → telefone undefined (não string vazia)', () => {
    expect(parseEventSummary('João - Corte | WhatsApp: ')).toEqual({
      nome: 'João',
      servico: 'Corte',
      telefone: undefined,
    });
  });

  it('é o inverso de buildEventSummary no caminho feliz', () => {
    const summary = buildEventSummary({
      nome: 'Maria',
      servico: 'Barba',
      telefoneDigits: '5531999998842',
    });
    expect(parseEventSummary(summary)).toEqual({
      nome: 'Maria',
      servico: 'Barba',
      telefone: '5531999998842',
    });
  });
});
