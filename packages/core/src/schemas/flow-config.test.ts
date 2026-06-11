import { describe, expect, it } from 'vitest';
import { horarioDiaSchema, horariosSchema, servicoSchema, servicosSchema } from './flow-config.js';

describe('servicoSchema', () => {
  it('aceita servico valido', () => {
    const r = servicoSchema.safeParse({ nome: 'Corte', preco_cents: 4500, duracao_min: 30 });
    expect(r.success).toBe(true);
  });

  it('rejeita preco_cents negativo', () => {
    const r = servicoSchema.safeParse({ nome: 'Corte', preco_cents: -1, duracao_min: 30 });
    expect(r.success).toBe(false);
  });

  it('rejeita preco_cents nao-inteiro (centavos devem ser inteiros)', () => {
    const r = servicoSchema.safeParse({ nome: 'Corte', preco_cents: 45.5, duracao_min: 30 });
    expect(r.success).toBe(false);
  });

  it('rejeita duracao_min zero ou negativa', () => {
    expect(servicoSchema.safeParse({ nome: 'X', preco_cents: 100, duracao_min: 0 }).success).toBe(
      false,
    );
    expect(servicoSchema.safeParse({ nome: 'X', preco_cents: 100, duracao_min: -5 }).success).toBe(
      false,
    );
  });

  it('aceita duracao_min multipla de 5 (grade de agenda em passos de 5min)', () => {
    expect(servicoSchema.safeParse({ nome: 'X', preco_cents: 100, duracao_min: 5 }).success).toBe(
      true,
    );
    expect(servicoSchema.safeParse({ nome: 'X', preco_cents: 100, duracao_min: 25 }).success).toBe(
      true,
    );
  });

  it('rejeita duracao_min fora do passo de 5 minutos', () => {
    expect(servicoSchema.safeParse({ nome: 'X', preco_cents: 100, duracao_min: 7 }).success).toBe(
      false,
    );
    expect(servicoSchema.safeParse({ nome: 'X', preco_cents: 100, duracao_min: 23 }).success).toBe(
      false,
    );
  });

  it('rejeita nome vazio', () => {
    const r = servicoSchema.safeParse({ nome: '   ', preco_cents: 100, duracao_min: 30 });
    expect(r.success).toBe(false);
  });

  it('rejeita campos extras (strict)', () => {
    const r = servicoSchema.safeParse({
      nome: 'Corte',
      preco_cents: 100,
      duracao_min: 30,
      slot: 'outro_clone',
    });
    expect(r.success).toBe(false);
  });
});

describe('servicosSchema', () => {
  it('aceita array vazio', () => {
    expect(servicosSchema.safeParse([]).success).toBe(true);
  });

  it('rejeita item invalido dentro do array', () => {
    const r = servicosSchema.safeParse([
      { nome: 'Corte', preco_cents: 4500, duracao_min: 30 },
      { nome: 'Barba', preco_cents: -1, duracao_min: 20 },
    ]);
    expect(r.success).toBe(false);
  });

  it('rejeita mais de 100 servicos', () => {
    const big = Array.from({ length: 101 }, (_, i) => ({
      nome: `S${i}`,
      preco_cents: 100,
      duracao_min: 10,
    }));
    expect(servicosSchema.safeParse(big).success).toBe(false);
  });
});

describe('horarioDiaSchema', () => {
  it('aceita dia aberto com abre < fecha', () => {
    const r = horarioDiaSchema.safeParse({ abre: '09:00', fecha: '18:00', fechado: false });
    expect(r.success).toBe(true);
  });

  it('rejeita abre >= fecha', () => {
    expect(
      horarioDiaSchema.safeParse({ abre: '18:00', fecha: '09:00', fechado: false }).success,
    ).toBe(false);
    expect(
      horarioDiaSchema.safeParse({ abre: '09:00', fecha: '09:00', fechado: false }).success,
    ).toBe(false);
  });

  it('rejeita HH:MM invalido', () => {
    expect(
      horarioDiaSchema.safeParse({ abre: '25:00', fecha: '26:00', fechado: false }).success,
    ).toBe(false);
    expect(
      horarioDiaSchema.safeParse({ abre: '9:0', fecha: '18:00', fechado: false }).success,
    ).toBe(false);
  });

  it('aceita dia fechado com abre/fecha nulos', () => {
    const r = horarioDiaSchema.safeParse({ abre: null, fecha: null, fechado: true });
    expect(r.success).toBe(true);
  });

  it('rejeita dia fechado com horario preenchido (incoerente)', () => {
    const r = horarioDiaSchema.safeParse({ abre: '09:00', fecha: '18:00', fechado: true });
    expect(r.success).toBe(false);
  });

  it('rejeita dia aberto sem abre/fecha', () => {
    const r = horarioDiaSchema.safeParse({ abre: null, fecha: null, fechado: false });
    expect(r.success).toBe(false);
  });
});

describe('horariosSchema', () => {
  it('aceita grade parcial valida', () => {
    const r = horariosSchema.safeParse({
      segunda: { abre: null, fecha: null, fechado: true },
      terca: { abre: '09:00', fecha: '18:00', fechado: false },
    });
    expect(r.success).toBe(true);
  });

  it('rejeita dia desconhecido (strict)', () => {
    const r = horariosSchema.safeParse({
      funday: { abre: '09:00', fecha: '18:00', fechado: false },
    });
    expect(r.success).toBe(false);
  });
});
