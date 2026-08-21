import { describe, expect, it } from 'vitest';
import {
  birthdayFromDateInput,
  birthdayLabel,
  birthdayToDateInput,
  buildClientesListSearchParams,
  clampClientesPage,
  clienteDisplayName,
  sanitizeClientesSearch,
} from './clientes';

describe('clientes helpers', () => {
  it('normaliza a busca antes de montar a query string', () => {
    expect(sanitizeClientesSearch('  Maria   Clara  ')).toBe('Maria Clara');
    expect(
      buildClientesListSearchParams({ page: 2, pageSize: 10, search: '  Maria   Clara  ' }),
    ).toBe('page=2&per_page=10&q=Maria+Clara');
  });

  it('defende a paginação contra páginas inválidas', () => {
    expect(clampClientesPage(0)).toBe(1);
    expect(clampClientesPage(-4)).toBe(1);
    expect(clampClientesPage(3.8)).toBe(3);
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
});
