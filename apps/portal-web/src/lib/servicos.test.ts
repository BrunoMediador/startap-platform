import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { isConflitoPersona, isValidacaoIndisponivel, toDraft, validate } from './servicos';

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

describe('isConflitoPersona (409 do PUT /portal/servicos — ADR 0035 §D2)', () => {
  it('extrai servico/trecho/mensagem de um 409 conflito_persona bem formado', () => {
    const err = new ApiError(409, 'conflict', {
      error: 'conflito_persona',
      reason: 'preco_duplicado',
      servico: 'Luzes',
      trecho: 'Luzes saem por cento e vinte reais',
      mensagem: 'O texto do seu assistente já fala o preço de "Luzes"...',
    });
    expect(isConflitoPersona(err)).toEqual({
      servico: 'Luzes',
      trecho: 'Luzes saem por cento e vinte reais',
      mensagem: 'O texto do seu assistente já fala o preço de "Luzes"...',
    });
  });

  it('null quando o status não é 409', () => {
    const err = new ApiError(503, 'unavailable', {
      error: 'conflito_persona',
      servico: 'Luzes',
      trecho: 'x',
      mensagem: 'y',
    });
    expect(isConflitoPersona(err)).toBeNull();
  });

  it('null quando o error code não é conflito_persona (outro 409 do portal)', () => {
    const err = new ApiError(409, 'conflict', { error: 'agenda_nao_configurada' });
    expect(isConflitoPersona(err)).toBeNull();
  });

  it('null quando o corpo não tem o shape esperado (defesa contra corpo incompleto)', () => {
    expect(
      isConflitoPersona(new ApiError(409, 'conflict', { error: 'conflito_persona' })),
    ).toBeNull();
    expect(isConflitoPersona(new ApiError(409, 'conflict', null))).toBeNull();
  });

  it('null pra erro que não é ApiError', () => {
    expect(isConflitoPersona(new Error('boom'))).toBeNull();
    expect(isConflitoPersona(null)).toBeNull();
    expect(isConflitoPersona(undefined)).toBeNull();
  });
});

describe('isValidacaoIndisponivel (503 do PUT /portal/servicos — ADR 0035 §D2)', () => {
  it('true pro 503 validacao_indisponivel', () => {
    const err = new ApiError(503, 'unavailable', {
      error: 'validacao_indisponivel',
      mensagem: 'Não consegui validar agora. Tente de novo em instantes.',
    });
    expect(isValidacaoIndisponivel(err)).toBe(true);
  });

  it('false pra 409 (nunca confundir com conflito_persona — um é permanente, outro retriable)', () => {
    const err = new ApiError(409, 'conflict', { error: 'conflito_persona' });
    expect(isValidacaoIndisponivel(err)).toBe(false);
  });

  it('false pra outro 503 do portal (error code diferente)', () => {
    const err = new ApiError(503, 'unavailable', { error: 'outra_coisa' });
    expect(isValidacaoIndisponivel(err)).toBe(false);
  });

  it('false pra erro que não é ApiError', () => {
    expect(isValidacaoIndisponivel(new Error('boom'))).toBe(false);
    expect(isValidacaoIndisponivel(null)).toBe(false);
  });
});
