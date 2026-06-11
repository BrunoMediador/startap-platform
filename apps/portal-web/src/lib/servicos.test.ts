import { describe, expect, it } from 'vitest';
import { toDraft, validate } from './servicos';

describe('validate (draft de servico)', () => {
  it('aceita servico valido com duracao multipla de 5', () => {
    const res = validate({ nome: 'Corte', duracao: '25', preco: '35,00' });
    expect(res).toEqual({
      ok: true,
      value: { nome: 'Corte', duracao_min: 25, preco_cents: 3500 },
    });
  });

  it('rejeita duracao que nao e multiplo de 5 (espelha .multipleOf(5) do backend)', () => {
    const res = validate({ nome: 'Corte', duracao: '23', preco: '35,00' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.duracao).toBe('Use múltiplos de 5 min (5, 10, 15…)');
  });

  it('rejeita duracao zero, negativa ou nao-inteira', () => {
    for (const duracao of ['0', '-5', '2.5', '']) {
      const res = validate({ nome: 'Corte', duracao, preco: '35,00' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.errors.duracao).toBe('Duração deve ser maior que zero');
    }
  });

  it('rejeita nome vazio e preco invalido', () => {
    const res = validate({ nome: '  ', duracao: '30', preco: 'abc' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.nome).toBeDefined();
      expect(res.errors.preco).toBeDefined();
      expect(res.errors.duracao).toBeUndefined();
    }
  });
});

describe('toDraft', () => {
  it('converte Servico em draft de edicao', () => {
    expect(toDraft({ nome: 'Barba', duracao_min: 20, preco_cents: 2550 })).toEqual({
      nome: 'Barba',
      duracao: '20',
      preco: '25,50',
    });
  });
});
