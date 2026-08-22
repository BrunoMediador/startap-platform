export type UltimoAtendimentoFilter = 'hoje' | '7d' | '30d' | 'sem_historico' | 'periodo';
export type VisitasFilter = 'todas' | 'uma' | '2_5' | '6_10' | '11_mais';
export type ClientesOrderBy = 'ultimo_atendimento' | 'visitas';
export type SortOrder = 'asc' | 'desc';

export interface ClientesFilters {
  nome: string;
  telefone: string;
  ultimoAtendimento: UltimoAtendimentoFilter | null;
  periodoInicio: string;
  periodoFim: string;
  visitas: VisitasFilter;
  ordenarPor: ClientesOrderBy;
  ordem: SortOrder;
}

export const initialClientesFilters: ClientesFilters = {
  nome: '',
  telefone: '',
  ultimoAtendimento: null,
  periodoInicio: '',
  periodoFim: '',
  visitas: 'todas',
  ordenarPor: 'ultimo_atendimento',
  ordem: 'desc',
};

export function normalizeClientesFilters(filters: ClientesFilters): ClientesFilters {
  return {
    ...filters,
    nome: filters.nome.trim().replace(/\s+/g, ' ').slice(0, 80),
    telefone: filters.telefone.replace(/[^\d+]/g, '').slice(0, 20),
    periodoInicio: filters.periodoInicio,
    periodoFim: filters.periodoFim,
  };
}

export function activeClientesFilters(
  filters: ClientesFilters,
): Array<{ key: string; label: string }> {
  const safe = normalizeClientesFilters(filters);
  const active: Array<{ key: string; label: string }> = [];
  if (safe.nome) active.push({ key: 'nome', label: `Cliente: ${safe.nome}` });
  if (safe.telefone) active.push({ key: 'telefone', label: `WhatsApp: ${safe.telefone}` });
  if (safe.ultimoAtendimento) {
    const labels: Record<UltimoAtendimentoFilter, string> = {
      hoje: 'Hoje',
      '7d': 'Últimos 7 dias',
      '30d': 'Últimos 30 dias',
      sem_historico: 'Sem histórico',
      periodo: 'Período personalizado',
    };
    active.push({ key: 'ultimoAtendimento', label: labels[safe.ultimoAtendimento] });
  }
  if (safe.periodoInicio)
    active.push({ key: 'periodoInicio', label: `A partir de ${safe.periodoInicio}` });
  if (safe.periodoFim) active.push({ key: 'periodoFim', label: `Até ${safe.periodoFim}` });
  if (safe.visitas !== 'todas') {
    const labels: Record<Exclude<VisitasFilter, 'todas'>, string> = {
      uma: '1 visita',
      '2_5': '2–5 visitas',
      '6_10': '6–10 visitas',
      '11_mais': '11+ visitas',
    };
    active.push({ key: 'visitas', label: labels[safe.visitas] });
  }
  return active;
}

export function clientesFiltersSearchParams(
  filters: ClientesFilters,
  limit: number,
  offset: number,
): string {
  const safe = normalizeClientesFilters(filters);
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    visitas: safe.visitas,
    ordenar_por: safe.ordenarPor,
    ordem: safe.ordem,
  });
  if (safe.nome) params.set('nome', safe.nome);
  if (safe.telefone) params.set('telefone', safe.telefone);
  const hasCompleteCustomPeriod = Boolean(safe.periodoInicio && safe.periodoFim);
  if (hasCompleteCustomPeriod) {
    params.set('ultimo_atendimento', 'periodo');
  } else if (safe.ultimoAtendimento) {
    params.set('ultimo_atendimento', safe.ultimoAtendimento);
  }
  if (hasCompleteCustomPeriod) {
    params.set('periodo_inicio', safe.periodoInicio);
    params.set('periodo_fim', safe.periodoFim);
  }
  return params.toString();
}

/** A API só aceita período com as duas pontas; enquanto falta uma, a lista aguarda. */
export function hasIncompleteClientesPeriod(filters: ClientesFilters): boolean {
  const safe = normalizeClientesFilters(filters);
  return Boolean(safe.periodoInicio) !== Boolean(safe.periodoFim);
}

export function shouldFetchClienteAvatar(mode: 'owner' | 'colaborador'): boolean {
  return mode === 'owner';
}

export function clearClientesFilter(filters: ClientesFilters, key: string): ClientesFilters {
  switch (key) {
    case 'nome':
      return { ...filters, nome: '' };
    case 'telefone':
      return { ...filters, telefone: '' };
    case 'ultimoAtendimento':
      return { ...filters, ultimoAtendimento: null };
    case 'periodoInicio':
      return { ...filters, periodoInicio: '' };
    case 'periodoFim':
      return { ...filters, periodoFim: '' };
    case 'visitas':
      return { ...filters, visitas: 'todas' };
    default:
      return filters;
  }
}
