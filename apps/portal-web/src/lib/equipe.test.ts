import { describe, expect, it } from 'vitest';
import type { Colaborador } from './api-types';
import {
  comissaoToText,
  isServicoMarcado,
  mapColaboradorRow,
  normalizeServicos,
  parseComissao,
  servicosOrfaos,
  toDraft,
  toggleServico,
  validate,
} from './equipe';

describe('normalizeServicos', () => {
  it('faz trim, descarta vazios e dedup case-insensitive', () => {
    expect(normalizeServicos(['Corte', ' Barba ', 'corte'])).toEqual(['Corte', 'Barba']);
  });

  it('array vazio / só espaços -> []', () => {
    expect(normalizeServicos([])).toEqual([]);
    expect(normalizeServicos(['  ', '', ' '])).toEqual([]);
  });

  it('limita cada item a 80 chars e o array a 50 itens', () => {
    const longName = 'a'.repeat(100);
    expect(normalizeServicos([longName])[0]).toHaveLength(80);

    const many = Array.from({ length: 60 }, (_, i) => `s${i}`);
    expect(normalizeServicos(many)).toHaveLength(50);
  });
});

describe('toggleServico', () => {
  it('marca um serviço novo (preserva ordem)', () => {
    expect(toggleServico(['Corte'], 'Barba')).toEqual(['Corte', 'Barba']);
  });

  it('desmarca um serviço já marcado (case-insensitive)', () => {
    expect(toggleServico(['Corte', 'Barba'], 'corte')).toEqual(['Barba']);
  });

  it('ignora nome vazio', () => {
    expect(toggleServico(['Corte'], '   ')).toEqual(['Corte']);
  });

  it('não passa do teto de 50 itens ao marcar', () => {
    const cheio = Array.from({ length: 50 }, (_, i) => `s${i}`);
    expect(toggleServico(cheio, 'novo')).toHaveLength(50);
    // mas desmarcar um existente continua funcionando no teto
    expect(toggleServico(cheio, 's0')).toHaveLength(49);
  });
});

describe('isServicoMarcado', () => {
  it('detecta marcado case-insensitive', () => {
    expect(isServicoMarcado(['Corte', 'Barba'], 'corte')).toBe(true);
    expect(isServicoMarcado(['Corte'], 'Barba')).toBe(false);
  });
});

describe('servicosOrfaos', () => {
  it('retorna os selecionados que não existem mais no catálogo (case-insensitive)', () => {
    expect(servicosOrfaos(['Corte', 'Sobrancelha'], ['Corte', 'Barba'])).toEqual(['Sobrancelha']);
  });

  it('catálogo cobre tudo -> sem órfãos', () => {
    expect(servicosOrfaos(['corte'], ['Corte', 'Barba'])).toEqual([]);
  });
});

describe('toDraft', () => {
  it('toDraft converte um colaborador da API em draft de form (servicos como array)', () => {
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
      servicos: ['Corte', 'Barba'],
      ativo: false,
      comissao: '30',
    });
  });
});

describe('mapColaboradorRow', () => {
  // O driver pg serializa BIGSERIAL (id) e NUMERIC (comissao_pct) como STRING na
  // rede. O map precisa devolver number — senão o id string quebra o gate de save
  // (editar não dispara PATCH) e o POST de atendimento manda string -> 400.
  it('converte id e comissao_pct vindos como string pra number', () => {
    const row = {
      id: '4',
      nome: 'Eduardo',
      gcal_calendar_id: 'cal@group.calendar.google.com',
      gcal_status: 'active',
      servicos: ['Corte'],
      ativo: true,
      ordem: 1,
      comissao_pct: '30',
      created_at: '2026-06-23T00:00:00Z',
      updated_at: '2026-06-23T00:00:00Z',
    } as unknown as Colaborador;
    const out = mapColaboradorRow(row);
    expect(out.id).toBe(4);
    expect(typeof out.id).toBe('number');
    expect(out.comissao_pct).toBe(30);
    expect(typeof out.comissao_pct).toBe('number');
  });

  it('é idempotente quando os campos já vêm como number', () => {
    const c: Colaborador = {
      id: 7,
      nome: 'Maria',
      gcal_calendar_id: null,
      gcal_status: 'pending',
      servicos: [],
      ativo: false,
      ordem: 0,
      comissao_pct: 0,
      created_at: '2026-06-23T00:00:00Z',
      updated_at: '2026-06-23T00:00:00Z',
    };
    const out = mapColaboradorRow(c);
    expect(out.id).toBe(7);
    expect(out.comissao_pct).toBe(0);
    expect(out.nome).toBe('Maria');
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
  it('aceita draft válido: serviços marcados viram o payload (normalizados)', () => {
    const res = validate({
      nome: '  Ana  ',
      servicos: ['Corte', 'corte', 'Barba'],
      ativo: true,
      comissao: '30',
    });
    expect(res).toEqual({
      ok: true,
      value: { nome: 'Ana', servicos: ['Corte', 'Barba'], ativo: true, comissao_pct: 30 },
    });
  });

  it('aceita sem serviços marcados (atende todos) -> array vazio + comissão 0', () => {
    const res = validate({ nome: 'Ana', servicos: [], ativo: true, comissao: '' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.servicos).toEqual([]);
      expect(res.value.comissao_pct).toBe(0);
    }
  });

  it('rejeita nome vazio', () => {
    const res = validate({ nome: '   ', servicos: [], ativo: true, comissao: '' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.nome).toBeTruthy();
  });

  it('rejeita nome acima de 160 chars (espelha o backend)', () => {
    const res = validate({ nome: 'a'.repeat(161), servicos: [], ativo: true, comissao: '' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.nome).toBeTruthy();
  });

  it('rejeita comissão fora de 0..100', () => {
    const res = validate({ nome: 'Ana', servicos: [], ativo: true, comissao: '150' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.comissao).toBeTruthy();
  });
});
