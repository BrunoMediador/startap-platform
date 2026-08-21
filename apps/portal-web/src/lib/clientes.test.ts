import type { ClientePerfil } from './api-types';
import { describe, expect, it } from 'vitest';
import {
  birthdayFromDateInput,
  birthdayLabel,
  birthdayToDateInput,
  buildClientesListSearchParams,
  buildClientePatchBody,
  clampClientesPage,
  clienteDraftChanged,
  clienteDraftFromPerfil,
  clienteDisplayName,
  clientePhoneMasked,
  clientesPageFromOffset,
  clientesTotalPages,
  sanitizeClientesSearch,
} from './clientes';

describe('clientes helpers', () => {
  it('normaliza a busca antes de montar a query string', () => {
    expect(sanitizeClientesSearch('  Maria   Clara  ')).toBe('Maria Clara');
    expect(
      buildClientesListSearchParams({ page: 2, pageSize: 10, search: '  Maria   Clara  ' }),
    ).toBe('limit=10&offset=10&q=Maria+Clara');
  });

  it('defende a paginação contra páginas inválidas', () => {
    expect(clampClientesPage(0)).toBe(1);
    expect(clampClientesPage(-4)).toBe(1);
    expect(clampClientesPage(3.8)).toBe(3);
    expect(clientesPageFromOffset(10, 10)).toBe(2);
    expect(clientesTotalPages(11, 10)).toBe(2);
  });

  it('gera fallback seguro para nome ausente', () => {
    expect(clienteDisplayName(null)).toBe('Cliente sem nome');
    expect(clienteDisplayName('  ')).toBe('Cliente sem nome');
    expect(clienteDisplayName('Joana')).toBe('Joana');
  });

  it('converte aniversário sem ano para o input nativo e de volta', () => {
    expect(birthdayToDateInput('06-18')).toBe('2000-06-18');
    expect(birthdayToDateInput(null)).toBe('');
    expect(birthdayFromDateInput('2000-06-18')).toBe('06-18');
    expect(birthdayFromDateInput('')).toBeNull();
  });

  it('formata o aniversário sem expor o ano fake', () => {
    expect(birthdayLabel('06-18')).toBe('18 de junho');
    expect(birthdayLabel(null)).toBeNull();
  });

  it('mascara o telefone cru da API para a lista', () => {
    expect(clientePhoneMasked('553199998842')).toBe('+55 (31) ••••-8842');
    expect(clientePhoneMasked('1133224455')).toBe('(11) ••••-4455');
  });

  it('normaliza detail+patch do contrato real do backend', () => {
    const perfil: ClientePerfil = {
      id: '11111111-1111-4111-8111-111111111111',
      nome: 'Joao',
      telefone: '553199998842',
      aniversario_mmdd: '08-21',
      cidade: 'Belo Horizonte',
      nota_interna: 'Cliente VIP',
      total_atendimentos: 3,
      ultima_interacao_at: '2026-08-20T10:00:00.000Z',
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-20T10:00:00.000Z',
    };

    const draft = clienteDraftFromPerfil(perfil);
    expect(draft).toEqual({
      aniversario_mmdd: '08-21',
      cidade: 'Belo Horizonte',
      nota_interna: 'Cliente VIP',
    });

    const changedDraft = { ...draft, aniversario_mmdd: '09-15', cidade: 'Contagem', nota_interna: '' };
    expect(clienteDraftChanged(perfil, changedDraft)).toBe(true);
    expect(buildClientePatchBody(changedDraft)).toEqual({
      aniversario_mmdd: '09-15',
      cidade: 'Contagem',
      nota_interna: null,
    });
  });
});
