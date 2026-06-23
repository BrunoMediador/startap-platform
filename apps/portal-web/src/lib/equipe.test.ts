import { describe, expect, it } from 'vitest';
import type { Colaborador } from './api-types';
import {
  comissaoToText,
  parseComissao,
  parseServicos,
  servicosToText,
  toDraft,
  validate,
} from './equipe';

describe('parseServicos', () => {
  it('faz trim, descarta vazios e dedup case-insensitive', () => {
    expect(parseServicos('Corte, Barba ,corte')).toEqual(['Corte', 'Barba']);
  });

  it('texto vazio / só vírgulas -> []', () => {
    expect(parseServicos('')).toEqual([]);
    expect(parseServicos('  ,  , ')).toEqual([]);
  });

  it('limita cada item a 80 chars e o array a 50 itens', () => {
    const longName = 'a'.repeat(100);
    expect(parseServicos(longName)[0]).toHaveLength(80);

    const many = Array.from({ length: 60 }, (_, i) => `s${i}`).join(',');
    expect(parseServicos(many)).toHaveLength(50);
  });
});

describe('servicosToText / toDraft', () => {
  it('servicosToText junta com ", "', () => {
    expect(servicosToText(['Corte', 'Barba'])).toBe('Corte, Barba');
  });

  it('toDraft converte um colaborador da API em draft de form', () => {
    const c: Colaborador = {
      id: 1,
      nome: 'Ana',
      gcal_calendar_id: null,
      gcal_status: 'pending',
      servicos: ['Corte', 'Barba'],
      ativo: false,
      ordem: 0,
      comissao_pct: 30,
      created_at: '2026-06-15T00:00:00Z',
      updated_at: '2026-06-15T00:00:00Z',
    };
    expect(toDraft(c)).toEqual({
      nome: 'Ana',
      servicos: 'Corte, Barba',
      ativo: false,
      comissao: '30',
    });
  });
});

describe('parseComissao / comissaoToText', () => {
  it('aceita inteiro, decimal com vírgula/ponto e "%"', () => {
    expect(parseComissao('30')).toBe(30);
    expect(parseComissao('12,5')).toBe(12.5);
    expect(parseComissao('12.5')).toBe(12.5);
    expect(parseComissao('40%')).toBe(40);
  });

  it('"" vira 0', () => {
    expect(parseComissao('')).toBe(0);
    expect(parseComissao('   ')).toBe(0);
  });

  it('rejeita fora de 0..100 e não-número', () => {
    expect(parseComissao('-1')).toBeNull();
    expect(parseComissao('101')).toBeNull();
    expect(parseComissao('abc')).toBeNull();
  });

  it('comissaoToText esconde o 0', () => {
    expect(comissaoToText(0)).toBe('');
    expect(comissaoToText(25)).toBe('25');
  });
});

describe('validate (draft de colaborador)', () => {
  it('aceita draft válido e normaliza os serviços + comissão', () => {
    const res = validate({
      nome: '  Ana  ',
      servicos: 'Corte, corte, Barba',
      ativo: true,
      comissao: '30',
    });
    expect(res).toEqual({
      ok: true,
      value: { nome: 'Ana', servicos: ['Corte', 'Barba'], ativo: true, comissao_pct: 30 },
    });
  });

  it('aceita sem serviços (atende todos) -> array vazio + comissão 0', () => {
    const res = validate({ nome: 'Ana', servicos: '', ativo: true, comissao: '' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.servicos).toEqual([]);
      expect(res.value.comissao_pct).toBe(0);
    }
  });

  it('rejeita nome vazio', () => {
    const res = validate({ nome: '   ', servicos: '', ativo: true, comissao: '' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.nome).toBeTruthy();
  });

  it('rejeita nome acima de 160 chars (espelha o backend)', () => {
    const res = validate({ nome: 'a'.repeat(161), servicos: '', ativo: true, comissao: '' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.nome).toBeTruthy();
  });

  it('rejeita comissão fora de 0..100', () => {
    const res = validate({ nome: 'Ana', servicos: '', ativo: true, comissao: '150' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.comissao).toBeTruthy();
  });
});
