import { describe, expect, it } from 'vitest';
import {
  isArea,
  maskPhoneBR,
  phoneDigits,
  signupCardFromError,
  validateCadastro,
} from './cadastro';

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
  const ok = {
    nome: 'Barbearia do João',
    area: 'barbearia' as const,
    whatsapp: '(31) 99999-8842',
    senha: '12345678',
    timezone: 'America/Sao_Paulo',
    aceite: true,
  };

  it('aceita draft valido e monta payload do signup (digitos locais + area + aceite + fuso)', () => {
    const res = validateCadastro(ok);
    expect(res).toEqual({
      ok: true,
      value: {
        nome_negocio: 'Barbearia do João',
        area: 'barbearia',
        whatsapp: '31999998842',
        senha: '12345678',
        timezone: 'America/Sao_Paulo',
        aceite_termos: true,
      },
    });
  });

  it('fuso vazio no draft cai no default São Paulo', () => {
    const res = validateCadastro({ ...ok, timezone: '' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.timezone).toBe('America/Sao_Paulo');
  });

  it('rejeita quando o aceite dos termos não foi marcado (checkbox obrigatório)', () => {
    const res = validateCadastro({ ...ok, aceite: false });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.aceite).toBe(
        'Pra continuar, aceite os Termos de Uso e a Política de Privacidade',
      );
    }
  });

  it('rejeita quando nenhuma area foi escolhida (null)', () => {
    const res = validateCadastro({ ...ok, area: null });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.area).toBe('Escolha o tipo do seu negócio');
  });

  it('aceita os 5 slugs de area do contrato', () => {
    for (const area of ['barbearia', 'cabeleireiro', 'manicure', 'estetica', 'outro'] as const) {
      const res = validateCadastro({ ...ok, area });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.area).toBe(area);
    }
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
    const res = validateCadastro({
      nome: '',
      area: null,
      whatsapp: '123',
      timezone: 'America/Sao_Paulo',
      senha: 'abc',
      aceite: false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.nome).toBeTruthy();
      expect(res.errors.area).toBeTruthy();
      expect(res.errors.whatsapp).toBeTruthy();
      expect(res.errors.senha).toBeTruthy();
      expect(res.errors.aceite).toBeTruthy();
    }
  });
});

describe('isArea', () => {
  it('aceita só os 5 slugs do contrato', () => {
    for (const a of ['barbearia', 'cabeleireiro', 'manicure', 'estetica', 'outro']) {
      expect(isArea(a)).toBe(true);
    }
  });

  it('rejeita slug fora do enum, null e não-string', () => {
    expect(isArea('salao')).toBe(false);
    expect(isArea(null)).toBe(false);
    expect(isArea(undefined)).toBe(false);
    expect(isArea(42)).toBe(false);
  });
});

describe('signupCardFromError', () => {
  it('409 trial_ja_usado -> card do portao 1 (soft check)', () => {
    expect(signupCardFromError(409, 'trial_ja_usado')).toBe('trial-usado');
  });

  it('409 sem/com outro codigo -> card "ja tem conta"', () => {
    expect(signupCardFromError(409, 'conta_ja_existe')).toBe('conta-existe');
    expect(signupCardFromError(409, null)).toBe('conta-existe');
  });

  it('404/403 (flag PORTAL_SIGNUP OFF) -> card indisponivel', () => {
    expect(signupCardFromError(404, null)).toBe('indisponivel');
    expect(signupCardFromError(403, null)).toBe('indisponivel');
  });

  it('503 trial_lotado (teto TRIAL_MAX_ATIVOS) -> card lotado', () => {
    expect(signupCardFromError(503, 'trial_lotado')).toBe('lotado');
  });

  it('503 generico SEM trial_lotado NAO vira card (fica no banner)', () => {
    expect(signupCardFromError(503, null)).toBeNull();
    expect(signupCardFromError(503, 'outro_erro')).toBeNull();
  });

  it('400/500/rede ficam no tratamento inline/banner do form', () => {
    expect(signupCardFromError(400, 'telefone_invalido')).toBeNull();
    expect(signupCardFromError(500, null)).toBeNull();
    expect(signupCardFromError(0, null)).toBeNull();
  });
});
