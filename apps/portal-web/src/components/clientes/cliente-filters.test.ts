import { describe, expect, it } from 'vitest';
import {
  activeClientesFilters,
  clientesFiltersSearchParams,
  initialClientesFilters,
  shouldFetchClienteAvatar,
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

  it('desktop serializa período personalizado com o discriminador exigido pela API', () => {
    expect(
      clientesFiltersSearchParams(
        { ...initialClientesFilters, periodoInicio: '2026-08-01', periodoFim: '2026-08-22' },
        20,
        0,
      ),
    ).toContain('ultimo_atendimento=periodo');
  });

  it('mobile usa a mesma serialização de período e só owner busca avatar privado', () => {
    const params = clientesFiltersSearchParams(
      { ...initialClientesFilters, periodoFim: '2026-08-22' },
      20,
      20,
    );
    expect(params).toContain('ultimo_atendimento=periodo');
    expect(shouldFetchClienteAvatar('owner')).toBe(true);
    expect(shouldFetchClienteAvatar('colaborador')).toBe(false);
  });
});
