import { describe, expect, it } from 'vitest';
import {
  activeClientesFilters,
  clientesFiltersSearchParams,
  clientesPeriodDraftStatus,
  initialClientesFilters,
  initialClientesPeriodDraft,
  resetClientesFilters,
  shouldFetchClienteAvatar,
  transitionClientesPeriod,
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
      { ...initialClientesFilters, periodoInicio: '2026-08-01', periodoFim: '2026-08-22' },
      20,
      20,
    );
    expect(params).toContain('ultimo_atendimento=periodo');
    expect(shouldFetchClienteAvatar('owner')).toBe(true);
    expect(shouldFetchClienteAvatar('colaborador')).toBe(false);
  });

  it('mantém o aplicado enquanto o rascunho customizado está vazio ou parcial', () => {
    let state = transitionClientesPeriod(
      { ...initialClientesFilters, ultimoAtendimento: '7d' },
      initialClientesPeriodDraft,
      { type: 'selectCustom' },
    );
    expect(clientesPeriodDraftStatus(state.draft)).toBe('pending');
    expect(clientesFiltersSearchParams(state.filters, 20, 0)).toContain('ultimo_atendimento=7d');

    state = transitionClientesPeriod(state.filters, state.draft, {
      type: 'edit',
      field: 'inicio',
      value: '2026-08-01',
    });
    expect(clientesPeriodDraftStatus(state.draft)).toBe('pending');
    expect(state.filters.ultimoAtendimento).toBe('7d');

    state = transitionClientesPeriod(initialClientesFilters, initialClientesPeriodDraft, {
      type: 'selectCustom',
    });
    state = transitionClientesPeriod(state.filters, state.draft, {
      type: 'edit',
      field: 'fim',
      value: '2026-08-22',
    });
    expect(clientesPeriodDraftStatus(state.draft)).toBe('pending');
    expect(clientesFiltersSearchParams(state.filters, 20, 0)).not.toContain('periodo_');
  });

  it('aplica somente intervalo ordenado; período invertido fica local', () => {
    let state = transitionClientesPeriod(initialClientesFilters, initialClientesPeriodDraft, {
      type: 'selectCustom',
    });
    state = transitionClientesPeriod(state.filters, state.draft, {
      type: 'edit',
      field: 'inicio',
      value: '2026-08-22',
    });
    state = transitionClientesPeriod(state.filters, state.draft, {
      type: 'edit',
      field: 'fim',
      value: '2026-08-01',
    });
    expect(clientesPeriodDraftStatus(state.draft)).toBe('invalid');
    expect(state.filters.ultimoAtendimento).toBeNull();

    state = transitionClientesPeriod(state.filters, state.draft, {
      type: 'edit',
      field: 'fim',
      value: '2026-08-22',
    });
    expect(clientesPeriodDraftStatus(state.draft)).toBe('idle');
    expect(clientesFiltersSearchParams(state.filters, 20, 0)).toContain(
      'ultimo_atendimento=periodo',
    );
  });

  it('preset, remover chip período e limpar todos são transições atômicas', () => {
    const preset = transitionClientesPeriod(initialClientesFilters, initialClientesPeriodDraft, {
      type: 'preset',
      value: '30d',
    });
    expect(clientesFiltersSearchParams(preset.filters, 20, 0)).toContain('ultimo_atendimento=30d');
    const cleared = transitionClientesPeriod(
      {
        ...preset.filters,
        ultimoAtendimento: 'periodo',
        periodoInicio: '2026-08-01',
        periodoFim: '2026-08-22',
      },
      initialClientesPeriodDraft,
      { type: 'clear' },
    );
    expect(cleared.filters.ultimoAtendimento).toBeNull();
    expect(cleared.filters.periodoInicio).toBe('');
    expect(cleared.filters.periodoFim).toBe('');
    expect(cleared.draft).toEqual(initialClientesPeriodDraft);
    expect(
      activeClientesFilters({
        ...preset.filters,
        ultimoAtendimento: 'periodo',
        periodoInicio: '2026-08-01',
        periodoFim: '2026-08-22',
      }).map((chip) => chip.key),
    ).toEqual(['periodo']);
    expect(resetClientesFilters()).toEqual({
      filters: initialClientesFilters,
      draft: initialClientesPeriodDraft,
    });
  });
});
