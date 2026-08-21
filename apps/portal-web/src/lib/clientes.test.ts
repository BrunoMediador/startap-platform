import type {
  ClienteAniversarianteApiItem,
  ClientePerfil,
  ClienteSemRetornoApiItem,
} from './api-types';
import { describe, expect, it } from 'vitest';
import {
  aniversarianteDiasLabel,
  aniversarianteFaixaLabel,
  aniversarianteMatchesSearch,
  aniversarianteOccurrenceLabel,
  birthdayFromDateInput,
  birthdayLabel,
  birthdayToDateInput,
  buildClientesAniversariantesSearchParams,
  buildClientesListSearchParams,
  buildClientesSemRetornoSearchParams,
  buildClientePatchBody,
  clampClientesPage,
  clienteAniversarianteFromApi,
  clienteSemRetornoFromApi,
  currentMonthInTimezone,
  clienteDraftChanged,
  clienteDraftFromPerfil,
  clienteDisplayName,
  clientePhoneMasked,
  clientesPageFromOffset,
  clientesTotalPages,
  monthName,
  semRetornoDiasLabel,
  semRetornoFaixaLabel,
  semRetornoMatchesSearch,
  sanitizeClientesSearch,
} from './clientes';

describe('clientes helpers', () => {
  it('normaliza a busca antes de montar a query string', () => {
    expect(sanitizeClientesSearch('  Maria   Clara  ')).toBe('Maria Clara');
    expect(
      buildClientesListSearchParams({ page: 2, pageSize: 10, search: '  Maria   Clara  ' }),
    ).toBe('limit=10&offset=10&q=Maria+Clara');
    expect(buildClientesSemRetornoSearchParams({ page: 3, pageSize: 5 })).toBe(
      'limit=5&offset=10',
    );
    expect(
      buildClientesAniversariantesSearchParams({
        page: 2,
        pageSize: 5,
        modo: 'proximos',
        dias: 15,
        mes: 8,
      }),
    ).toBe('modo=proximos&limit=5&offset=5&dias=15');
    expect(
      buildClientesAniversariantesSearchParams({
        page: 3,
        pageSize: 5,
        modo: 'mes',
        dias: 15,
        mes: 8,
      }),
    ).toBe('modo=mes&limit=5&offset=10&mes=8');
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

  it('normaliza e filtra a fila sem retorno sem expor telefone cru', () => {
    const apiItem: ClienteSemRetornoApiItem = {
      cliente_id: '11111111-1111-4111-8111-111111111111',
      nome: 'Joao Silva',
      telefone_masked: '+55 31 •••••-••42',
      ultimo_atendimento_at: '2026-07-10T14:00:00.000Z',
      dias_sem_retorno: 42,
      ultimo_profissional_nome: 'Bene',
    };

    const item = clienteSemRetornoFromApi(apiItem);
    expect(item).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      nome: 'Joao Silva',
      telefone_masked: '+55 31 •••••-••42',
      ultimo_atendimento_at: '2026-07-10T14:00:00.000Z',
      dias_sem_retorno: 42,
      ultimo_profissional_nome: 'Bene',
    });
    expect(semRetornoMatchesSearch(item, 'joao')).toBe(true);
    expect(semRetornoMatchesSearch(item, '3142')).toBe(true);
    expect(semRetornoMatchesSearch(item, 'maria')).toBe(false);
  });

  it('resume a faixa temporal do ranking sem retorno', () => {
    expect(semRetornoDiasLabel(0)).toBe('Hoje');
    expect(semRetornoDiasLabel(1)).toBe('1 dia');
    expect(semRetornoDiasLabel(42)).toBe('42 dias');
    expect(semRetornoFaixaLabel(0)).toBe('Atendido hoje');
    expect(semRetornoFaixaLabel(6)).toBe('Até 7 dias');
    expect(semRetornoFaixaLabel(14)).toBe('8 a 14 dias');
    expect(semRetornoFaixaLabel(30)).toBe('15 a 30 dias');
    expect(semRetornoFaixaLabel(42)).toBe('31 a 60 dias');
    expect(semRetornoFaixaLabel(90)).toBe('Mais de 60 dias');
  });

  it('normaliza e descreve aniversariantes read-only', () => {
    const apiItem: ClienteAniversarianteApiItem = {
      id: '33333333-3333-4333-8333-333333333333',
      nome: 'Maria Souza',
      telefone_masked: '+55 31 •••••-••77',
      aniversario_mmdd: '08-25',
      proxima_ocorrencia_local_date: '2026-08-25',
      dias_ate_aniversario: 4,
    };

    const item = clienteAniversarianteFromApi(apiItem);
    expect(item).toEqual({
      id: '33333333-3333-4333-8333-333333333333',
      nome: 'Maria Souza',
      telefone_masked: '+55 31 •••••-••77',
      aniversario_mmdd: '08-25',
      proxima_ocorrencia_local_date: '2026-08-25',
      dias_ate_aniversario: 4,
    });
    expect(aniversarianteMatchesSearch(item, 'maria')).toBe(true);
    expect(aniversarianteMatchesSearch(item, '3177')).toBe(true);
    expect(aniversarianteMatchesSearch(item, 'joao')).toBe(false);
    expect(aniversarianteOccurrenceLabel(item)).toBe('25 de agosto');
  });

  it('resume labels de faixa dos aniversariantes', () => {
    expect(aniversarianteDiasLabel(0)).toBe('Hoje');
    expect(aniversarianteDiasLabel(1)).toBe('Amanhã');
    expect(aniversarianteDiasLabel(4)).toBe('4 dias');
    expect(aniversarianteDiasLabel(null)).toBe('Neste mês');
    expect(aniversarianteFaixaLabel('proximos', 0, 8)).toBe('Próximo aniversário hoje');
    expect(aniversarianteFaixaLabel('proximos', 5, 8)).toBe('Próximos 7 dias');
    expect(aniversarianteFaixaLabel('proximos', 14, 8)).toBe('Próximos 15 dias');
    expect(aniversarianteFaixaLabel('proximos', 30, 8)).toBe('Próximos 30 dias');
    expect(aniversarianteFaixaLabel('mes', null, 8)).toBe('Aniversários de agosto');
    expect(monthName(12)).toBe('dezembro');
  });

  it('resolve o mês atual no timezone do tenant', () => {
    expect(currentMonthInTimezone('America/Sao_Paulo', new Date('2026-08-21T01:00:00.000Z'))).toBe(8);
    expect(currentMonthInTimezone('America/Sao_Paulo', new Date('2026-01-02T03:00:00.000Z'))).toBe(1);
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
