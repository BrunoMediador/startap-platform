import { describe, expect, it } from 'vitest';
import { maskPhoneBR, phoneDigits, validateCadastro } from './cadastro';

describe('phoneDigits', () => {
  it('reduz entrada mascarada a digitos locais', () => {
    expect(phoneDigits('(31) 99999-8842')).toBe('31999998842');
    expect(phoneDigits('(11) 3333-4444')).toBe('1133334444');
  });

  it('paste com DDI +55 remove o DDI (eco do canonicalE164)', () => {
    expect(phoneDigits('+55 31 99999-8842')).toBe('31999998842'); // 13 digitos
    expect(phoneDigits('553133334444')).toBe('3133334444'); // 12 digitos
  });

  it('remove prefixo tronco/operadora "0"', () => {
    expect(phoneDigits('031 99999-8842')).toBe('31999998842');
  });

  it('digitar nunca passa de 11 digitos', () => {
    expect(phoneDigits('319999988421234')).toBe('31999998842');
  });
});

describe('maskPhoneBR', () => {
  it('mascara progressiva ao digitar', () => {
    expect(maskPhoneBR('')).toBe('');
    expect(maskPhoneBR('3')).toBe('(3');
    expect(maskPhoneBR('31')).toBe('(31');
    expect(maskPhoneBR('319')).toBe('(31) 9');
    expect(maskPhoneBR('3199999')).toBe('(31) 9999-9');
    expect(maskPhoneBR('3199998842')).toBe('(31) 9999-8842'); // fixo 10
    expect(maskPhoneBR('31999998842')).toBe('(31) 99999-8842'); // movel 11
  });

  it('normaliza paste sujo direto pra mascara', () => {
    expect(maskPhoneBR('+55 (31) 99999-8842')).toBe('(31) 99999-8842');
  });
});

describe('validateCadastro', () => {
  const ok = { nome: 'Barbearia do João', whatsapp: '(31) 99999-8842', senha: '12345678' };

  it('aceita draft valido e monta payload do signup (digitos locais)', () => {
    const res = validateCadastro(ok);
    expect(res).toEqual({
      ok: true,
      value: { nome_negocio: 'Barbearia do João', whatsapp: '31999998842', senha: '12345678' },
    });
  });

  it('rejeita nome vazio/curto com a microcopy da spec', () => {
    for (const nome of ['', '  ', 'A']) {
      const res = validateCadastro({ ...ok, nome });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.errors.nome).toBe('Conta o nome do seu negócio pra gente');
    }
  });

  it('rejeita telefone incompleto', () => {
    const res = validateCadastro({ ...ok, whatsapp: '(31) 9999' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.whatsapp).toBe('Confere o número? Faltou dígito');
  });

  it('rejeita senha menor que o minimo do backend (8)', () => {
    const res = validateCadastro({ ...ok, senha: '1234567' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.senha).toBe('Use pelo menos 8 caracteres');
  });

  it('rejeita senha acima do teto do bcrypt (72)', () => {
    const res = validateCadastro({ ...ok, senha: 'x'.repeat(73) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.senha).toBe('Use no máximo 72 caracteres');
  });

  it('senha nao sofre trim (espaco e caractere valido)', () => {
    const res = validateCadastro({ ...ok, senha: '  123456  ' });
    expect(res.ok).toBe(true);
  });

  it('acumula erros de todos os campos de uma vez', () => {
    const res = validateCadastro({ nome: '', whatsapp: '123', senha: 'abc' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.nome).toBeTruthy();
      expect(res.errors.whatsapp).toBeTruthy();
      expect(res.errors.senha).toBeTruthy();
    }
  });
});
