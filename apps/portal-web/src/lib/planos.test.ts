import { describe, expect, it } from 'vitest';
import {
  PLANOS_MAX,
  type PlanosDraft,
  isPlanosDirty,
  isPlanosValido,
  isPlanosVisivel,
  planosRestante,
  toPlanosDraft,
  toPlanosValue,
} from './planos';

const EMPTY: PlanosDraft = { planos_beneficios: '' };

describe('toPlanosDraft', () => {
  it('campo ausente/null -> ""', () => {
    expect(toPlanosDraft(null)).toEqual(EMPTY);
    expect(toPlanosDraft(undefined)).toEqual(EMPTY);
    expect(toPlanosDraft({})).toEqual(EMPTY);
    expect(toPlanosDraft({ planos_beneficios: null })).toEqual(EMPTY);
  });

  it('preserva o texto (inclusive quebras de linha)', () => {
    const t = 'Plano A — R$99/mês\n- 4 barbas\n- 10% off';
    expect(toPlanosDraft({ planos_beneficios: t }).planos_beneficios).toBe(t);
  });
});

describe('toPlanosValue', () => {
  it('apara só as bordas, preserva quebras internas', () => {
    expect(toPlanosValue({ planos_beneficios: '  Plano A\nPlano B  ' })).toBe('Plano A\nPlano B');
  });

  it('texto vazio/branco -> "" (limpa no backend)', () => {
    expect(toPlanosValue({ planos_beneficios: '   ' })).toBe('');
  });
});

describe('isPlanosValido / planosRestante', () => {
  it('aceita até o limite; rejeita acima', () => {
    expect(isPlanosValido('')).toBe(true);
    expect(isPlanosValido('x'.repeat(PLANOS_MAX))).toBe(true);
    expect(isPlanosValido('x'.repeat(PLANOS_MAX + 1))).toBe(false);
  });

  it('restante = limite - tamanho (negativo quando passa)', () => {
    expect(planosRestante('')).toBe(PLANOS_MAX);
    expect(planosRestante('x'.repeat(10))).toBe(PLANOS_MAX - 10);
    expect(planosRestante('x'.repeat(PLANOS_MAX + 5))).toBe(-5);
  });
});

describe('isPlanosDirty', () => {
  it('ignora diferença só de espaços nas bordas', () => {
    expect(isPlanosDirty({ planos_beneficios: '  Plano  ' }, { planos_beneficios: 'Plano' })).toBe(
      false,
    );
  });

  it('detecta mudança real (inclusive limpar)', () => {
    expect(isPlanosDirty({ planos_beneficios: 'Plano A' }, EMPTY)).toBe(true);
    expect(isPlanosDirty(EMPTY, { planos_beneficios: 'Plano A' })).toBe(true);
  });
});

// Onda 1 (SCRUM-68): a seção Planos passa a aparecer pra TODOS os formatos — não gateia
// mais por modo_atendente. Prova o de-gate no nível da lógica de visibilidade.
describe('isPlanosVisivel (de-gate SCRUM-68)', () => {
  it('visível pra perfil individual+agenda (modo_atendente false)', () => {
    expect(isPlanosVisivel({ modo_atendente: false, planos_beneficios: '' })).toBe(true);
  });

  it('visível também pra modo atendente (superset — byte-seguro pra quem já via)', () => {
    expect(isPlanosVisivel({ modo_atendente: true, planos_beneficios: 'Plano A' })).toBe(true);
  });

  it('não visível enquanto o perfil não carregou (evita flash)', () => {
    expect(isPlanosVisivel(undefined)).toBe(false);
    expect(isPlanosVisivel(null)).toBe(false);
  });
});
