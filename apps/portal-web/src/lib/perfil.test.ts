import { describe, expect, it } from 'vitest';
import {
  type PerfilDraft,
  isDirty,
  normalizeInstagram,
  toPerfilDraft,
  validatePerfil,
} from './perfil';

const EMPTY: PerfilDraft = {
  nome_negocio: '',
  nome_prestador: '',
  telefone_contato: '',
  endereco: '',
  instagram: '',
  formas_pagamento: '',
};

function draft(over: Partial<PerfilDraft>): PerfilDraft {
  return { ...EMPTY, ...over };
}

describe('normalizeInstagram', () => {
  it('aceita com e sem @ e devolve o handle limpo', () => {
    expect(normalizeInstagram('@barbearia.do.ze')).toBe('barbearia.do.ze');
    expect(normalizeInstagram('barbearia.do.ze')).toBe('barbearia.do.ze');
    expect(normalizeInstagram('  @ze_corte  ')).toBe('ze_corte');
  });

  it('extrai o handle de uma URL colada', () => {
    expect(normalizeInstagram('https://www.instagram.com/barbearia.do.ze')).toBe('barbearia.do.ze');
    expect(normalizeInstagram('instagram.com/ze_corte/')).toBe('ze_corte');
    expect(normalizeInstagram('https://instagram.com/ze?hl=pt-br')).toBe('ze');
  });

  it('mantém vazio quando vazio', () => {
    expect(normalizeInstagram('')).toBe('');
    expect(normalizeInstagram('   ')).toBe('');
  });
});

describe('validatePerfil', () => {
  it('aceita perfil totalmente vazio (todos os campos opcionais)', () => {
    const res = validatePerfil(EMPTY);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual(EMPTY);
  });

  it('trima os campos e normaliza o Instagram no payload', () => {
    const res = validatePerfil(
      draft({
        nome_negocio: '  Barbearia do Zé  ',
        instagram: ' @barbearia.do.ze ',
        formas_pagamento: 'Pix, dinheiro, cartão ',
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.nome_negocio).toBe('Barbearia do Zé');
      expect(res.value.instagram).toBe('barbearia.do.ze');
      expect(res.value.formas_pagamento).toBe('Pix, dinheiro, cartão');
    }
  });

  it('rejeita Instagram com caracteres inválidos (espaço)', () => {
    const res = validatePerfil(draft({ instagram: 'meu perfil' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.instagram).toBeDefined();
  });

  it('rejeita campo longo demais', () => {
    const res = validatePerfil(draft({ nome_negocio: 'x'.repeat(200) }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.nome_negocio).toBeDefined();
  });
});

describe('toPerfilDraft', () => {
  it('converte campos ausentes em string vazia', () => {
    expect(toPerfilDraft(null)).toEqual(EMPTY);
    expect(toPerfilDraft({ nome_negocio: 'X' })).toEqual(draft({ nome_negocio: 'X' }));
  });
});

describe('isDirty', () => {
  it('ignora diferença só de espaços em branco nas bordas', () => {
    expect(isDirty(draft({ nome_negocio: ' Zé ' }), draft({ nome_negocio: 'Zé' }))).toBe(false);
  });

  it('detecta mudança real', () => {
    expect(isDirty(draft({ telefone_contato: '11999' }), EMPTY)).toBe(true);
  });
});
