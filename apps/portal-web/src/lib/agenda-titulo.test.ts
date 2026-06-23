import { describe, expect, it } from 'vitest';
import { inicialDoTitulo, parseTitulo } from './agenda-titulo';

describe('parseTitulo', () => {
  it('padrão completo: nome - serviço | WhatsApp: tel', () => {
    const t = parseTitulo('João da Silva - Corte de cabelo | WhatsApp: 5511999990000');
    expect(t.nome).toBe('João da Silva');
    expect(t.servico).toBe('Corte de cabelo');
    expect(t.telefone).toBe('5511999990000');
    expect(t.raw).toBe('João da Silva - Corte de cabelo | WhatsApp: 5511999990000');
  });

  it('sem telefone: nome - serviço', () => {
    const t = parseTitulo('Maria Souza - Manicure');
    expect(t.nome).toBe('Maria Souza');
    expect(t.servico).toBe('Manicure');
    expect(t.telefone).toBe('');
  });

  it('sem serviço (sem " - "): tudo vira nome', () => {
    const t = parseTitulo('Reunião interna');
    expect(t.nome).toBe('Reunião interna');
    expect(t.servico).toBe('');
    expect(t.telefone).toBe('');
  });

  it('título livre só com WhatsApp: nome = resto, serviço vazio', () => {
    const t = parseTitulo('Cliente novo | WhatsApp: 5535988887777');
    expect(t.nome).toBe('Cliente novo');
    expect(t.servico).toBe('');
    expect(t.telefone).toBe('5535988887777');
  });

  it('" - " extra fica no serviço (só o primeiro separa)', () => {
    const t = parseTitulo('Pedro - Corte - degradê na régua');
    expect(t.nome).toBe('Pedro');
    expect(t.servico).toBe('Corte - degradê na régua');
  });

  it('WhatsApp case-insensitive e com espaços tolerados', () => {
    const t = parseTitulo('Ana - Sobrancelha |  whatsapp:  55 11 98888-1234');
    expect(t.nome).toBe('Ana');
    expect(t.servico).toBe('Sobrancelha');
    expect(t.telefone).toBe('5511988881234'); // só dígitos
  });

  it('telefone sem dígitos vira "" (não quebra)', () => {
    const t = parseTitulo('Bia - Corte | WhatsApp: ');
    expect(t.servico).toBe('Corte');
    expect(t.telefone).toBe('');
  });

  it('null / vazio / só espaços -> fallback seguro', () => {
    expect(parseTitulo(null).nome).toBe('Sem nome');
    expect(parseTitulo('').nome).toBe('Sem nome');
    expect(parseTitulo('   ').nome).toBe('Sem nome');
    expect(parseTitulo(undefined).servico).toBe('');
  });

  it('faz trim do nome e do serviço', () => {
    const t = parseTitulo('  Lucas  -  Barba completa  ');
    expect(t.nome).toBe('Lucas');
    expect(t.servico).toBe('Barba completa');
  });

  it('raw preserva o título original intacto (tooltip)', () => {
    const raw = 'X - Y | WhatsApp: 5511000000000';
    expect(parseTitulo(raw).raw).toBe(raw);
  });
});

describe('inicialDoTitulo', () => {
  it('usa o NOME, não o serviço/telefone', () => {
    expect(inicialDoTitulo('João Silva - Corte | WhatsApp: 5511999990000')).toBe('JS');
  });
  it('nome único -> 2 primeiras letras', () => {
    expect(inicialDoTitulo('Madonna - Show')).toBe('MA');
  });
  it('fallback "?" pra vazio', () => {
    expect(inicialDoTitulo('')).toBe('?');
    expect(inicialDoTitulo(null)).toBe('?');
  });
});
