import { describe, expect, it } from 'vitest';
import {
  activeClientesFilters,
  clientesFiltersSearchParams,
  initialClientesFilters,
} from './cliente-filters';

describe('cliente filters', () => {
  it('serializa somente filtros server-side ativos com paginação', () => {
    const filters = {
      ...initialClientesFilters,
      nome: '  Maria   Silva ',
      telefone: '(18) 9 1234-5678',
      ultimoAtendimento: '7d' as const,
      visitas: '2_5' as const,
    };

    expect(clientesFiltersSearchParams(filters, 20, 40)).toBe(
      'limit=20&offset=40&visitas=2_5&ordenar_por=ultimo_atendimento&ordem=desc&nome=Maria+Silva&telefone=18912345678&ultimo_atendimento=7d',
    );
    expect(activeClientesFilters(filters)).toHaveLength(4);
  });
});
