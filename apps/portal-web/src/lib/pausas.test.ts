import { describe, expect, it } from 'vitest';
import { formatPhoneDisplay, normalizePhone } from './format';
import { pausaMatchesBusca } from './pausas';

// Telefone cru como /portal/pausas guarda (COM o 9), exibido como "(35) 99115-3270".
const TEL = '5535991153270';

describe('pausaMatchesBusca — busca por NÚMERO casa o número ORIGINAL (regressão do 9º dígito)', () => {
  it('o dono vê exatamente "(35) 99115-3270"', () => {
    // garante que o "99115" do teste é a região do 99 duplo que ele VÊ na tela
    expect(formatPhoneDisplay(TEL)).toBe('+55 (35) 99115-3270');
  });

  it('digitar "99115" (a região do 99 duplo) ACHA o pausado — era o bug', () => {
    expect(pausaMatchesBusca(TEL, null, '99115')).toBe(true);
  });

  it('NÃO-VÁCUO: a chave de join (de-9\'d) NÃO contém "99115" — se a busca usasse ela, falharia', () => {
    // prova que o teste acima só passa por usar os dígitos crus, não normalizePhone
    expect(normalizePhone(TEL)).toBe('3591153270');
    expect(normalizePhone(TEL).includes('99115')).toBe(false);
  });

  it('casa por DDD+trecho e por número completo com máscara digitada', () => {
    expect(pausaMatchesBusca(TEL, null, '3599115')).toBe(true);
    expect(pausaMatchesBusca(TEL, null, '(35) 99115-3270')).toBe(true);
  });

  it('não casa número de outro contato', () => {
    expect(pausaMatchesBusca(TEL, null, '88888')).toBe(false);
  });
});

describe('pausaMatchesBusca — busca por NOME usa o nome resolvido pelo join', () => {
  it('casa por trecho do nome, sem case', () => {
    expect(pausaMatchesBusca(TEL, 'João da Silva', 'joão')).toBe(true);
    expect(pausaMatchesBusca(TEL, 'João da Silva', 'silva')).toBe(true);
  });

  it('nome desconhecido (null) só casa por número', () => {
    expect(pausaMatchesBusca(TEL, null, 'joão')).toBe(false);
    expect(pausaMatchesBusca(TEL, null, '99115')).toBe(true);
  });

  it('busca vazia inclui tudo (lista inteira)', () => {
    expect(pausaMatchesBusca(TEL, null, '')).toBe(true);
    expect(pausaMatchesBusca(TEL, null, '   ')).toBe(true);
  });
});
