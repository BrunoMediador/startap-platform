import type {
  ClienteAniversarianteApiItem,
  ClientePerfil,
  ClientesAniversariantesModo,
  ClienteSemRetornoApiItem,
  SaveClienteBody,
} from './api-types';
import { formatDueDate } from './format';

export const CLIENTES_PAGE_SIZE = 10;
export const CLIENTES_SEM_RETORNO_PAGE_SIZE = 5;
export const CLIENTES_ANIVERSARIANTES_PAGE_SIZE = 5;

const MESES = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
] as const;

export function sanitizeClientesSearch(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, 80);
}

export function clampClientesPage(page: number): number {
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

export function buildClientesListSearchParams({
  page,
  pageSize,
  search,
}: {
  page: number;
  pageSize: number;
  search: string;
}): string {
  const safePage = clampClientesPage(page);
  const limit = clampClientesLimit(pageSize);
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(clientesOffsetFromPage(safePage, limit)),
  });
  const q = sanitizeClientesSearch(search);
  if (q) params.set('q', q);
  return params.toString();
}

export function buildClientesSemRetornoSearchParams({
  page,
  pageSize,
}: {
  page: number;
  pageSize: number;
}): string {
  const safePage = clampClientesPage(page);
  const limit = clampClientesSemRetornoLimit(pageSize);
  return new URLSearchParams({
    limit: String(limit),
    offset: String(clientesOffsetFromPage(safePage, limit)),
  }).toString();
}

export function buildClientesAniversariantesSearchParams({
  page,
  pageSize,
  modo,
  dias,
  mes,
}: {
  page: number;
  pageSize: number;
  modo: ClientesAniversariantesModo;
  dias: number;
  mes: number;
}): string {
  const safePage = clampClientesPage(page);
  const limit = clampClientesAniversariantesLimit(pageSize);
  const params = new URLSearchParams({
    modo,
    limit: String(limit),
    offset: String(clientesOffsetFromPage(safePage, limit)),
  });
  if (modo === 'mes') params.set('mes', String(clampMonthNumber(mes)));
  if (modo === 'proximos') params.set('dias', String(clampBirthdayWindowDays(dias)));
  return params.toString();
}

export function clampClientesLimit(limit: number): number {
  if (!Number.isFinite(limit)) return CLIENTES_PAGE_SIZE;
  return Math.max(1, Math.min(100, Math.trunc(limit)));
}

export function clampClientesSemRetornoLimit(limit: number): number {
  if (!Number.isFinite(limit)) return CLIENTES_SEM_RETORNO_PAGE_SIZE;
  return Math.max(1, Math.min(50, Math.trunc(limit)));
}

export function clampClientesAniversariantesLimit(limit: number): number {
  if (!Number.isFinite(limit)) return CLIENTES_ANIVERSARIANTES_PAGE_SIZE;
  return Math.max(1, Math.min(50, Math.trunc(limit)));
}

export function clientesOffsetFromPage(page: number, pageSize: number): number {
  return (clampClientesPage(page) - 1) * clampClientesLimit(pageSize);
}

export function clientesPageFromOffset(offset: number, pageSize: number): number {
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
  return Math.floor(safeOffset / clampClientesLimit(pageSize)) + 1;
}

export function clientesTotalPages(total: number, pageSize: number): number {
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
  return Math.max(1, Math.ceil(safeTotal / clampClientesLimit(pageSize)));
}

export function clienteDisplayName(nome: string | null): string {
  const clean = nome?.trim();
  return clean ? clean : 'Cliente sem nome';
}

export function clientePhoneMasked(raw: string | null): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (!digits) return 'Telefone protegido';
  const hasDdi = digits.length > 11 && digits.startsWith('55');
  const local = hasDdi ? digits.slice(2) : digits;
  if (local.length === 11) {
    return `${hasDdi ? '+55 ' : ''}(${local.slice(0, 2)}) ${local[2]}••••-${local.slice(7)}`;
  }
  if (local.length === 10) {
    return `${hasDdi ? '+55 ' : ''}(${local.slice(0, 2)}) ••••-${local.slice(6)}`;
  }
  return `••••${digits.slice(-4)}`;
}

export interface ClienteSemRetornoItem {
  id: string;
  nome: string | null;
  telefone_masked: string;
  ultimo_atendimento_at: string | null;
  dias_sem_retorno: number;
  ultimo_profissional_nome: string | null;
}

export function clienteSemRetornoFromApi(
  item: ClienteSemRetornoApiItem,
): ClienteSemRetornoItem {
  return {
    id: item.cliente_id,
    nome: item.nome,
    telefone_masked: item.telefone_masked,
    ultimo_atendimento_at: item.ultimo_atendimento_at,
    dias_sem_retorno: item.dias_sem_retorno,
    ultimo_profissional_nome: item.ultimo_profissional_nome,
  };
}

export function semRetornoMatchesSearch(
  item: ClienteSemRetornoItem,
  search: string,
): boolean {
  const token = sanitizeClientesSearch(search).toLowerCase();
  if (!token) return true;
  const tokenDigits = token.replace(/\D/g, '');
  const nome = (item.nome ?? '').toLowerCase();
  const telefone = item.telefone_masked.toLowerCase();
  const telefoneDigits = telefone.replace(/\D/g, '');
  return (
    nome.includes(token) ||
    telefone.includes(token) ||
    (tokenDigits.length > 0 && telefoneDigits.includes(tokenDigits))
  );
}

export function semRetornoDiasLabel(dias: number): string {
  if (dias <= 0) return 'Hoje';
  if (dias === 1) return '1 dia';
  return `${dias} dias`;
}

export function semRetornoFaixaLabel(dias: number): string {
  if (dias <= 0) return 'Atendido hoje';
  if (dias <= 6) return 'Até 7 dias';
  if (dias <= 14) return '8 a 14 dias';
  if (dias <= 30) return '15 a 30 dias';
  if (dias <= 60) return '31 a 60 dias';
  return 'Mais de 60 dias';
}

export interface ClienteAniversarianteItem {
  id: string;
  nome: string | null;
  telefone_masked: string;
  aniversario_mmdd: string;
  proxima_ocorrencia_local_date: string | null;
  dias_ate_aniversario: number | null;
}

export function clienteAniversarianteFromApi(
  item: ClienteAniversarianteApiItem,
): ClienteAniversarianteItem {
  return {
    id: item.id,
    nome: item.nome,
    telefone_masked: item.telefone_masked,
    aniversario_mmdd: item.aniversario_mmdd,
    proxima_ocorrencia_local_date: item.proxima_ocorrencia_local_date ?? null,
    dias_ate_aniversario: item.dias_ate_aniversario ?? null,
  };
}

export function aniversarianteMatchesSearch(
  item: ClienteAniversarianteItem,
  search: string,
): boolean {
  const token = sanitizeClientesSearch(search).toLowerCase();
  if (!token) return true;
  const tokenDigits = token.replace(/\D/g, '');
  const nome = (item.nome ?? '').toLowerCase();
  const telefone = item.telefone_masked.toLowerCase();
  const telefoneDigits = telefone.replace(/\D/g, '');
  return (
    nome.includes(token) ||
    telefone.includes(token) ||
    (tokenDigits.length > 0 && telefoneDigits.includes(tokenDigits))
  );
}

export function clampBirthdayWindowDays(days: number): number {
  if (!Number.isFinite(days)) return 30;
  return Math.max(1, Math.min(31, Math.trunc(days)));
}

export function clampMonthNumber(month: number): number {
  if (!Number.isFinite(month)) return 1;
  return Math.max(1, Math.min(12, Math.trunc(month)));
}

export function monthName(month: number): string {
  return MESES[clampMonthNumber(month) - 1];
}

export function currentMonthInTimezone(timezone: string, now = new Date()): number {
  const month = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'numeric',
  }).format(now);
  return clampMonthNumber(Number(month));
}

export function aniversarianteDiasLabel(dias: number | null): string {
  if (dias == null) return 'Neste mês';
  if (dias <= 0) return 'Hoje';
  if (dias === 1) return 'Amanhã';
  return `${dias} dias`;
}

export function aniversarianteFaixaLabel(
  modo: ClientesAniversariantesModo,
  dias: number | null,
  mes: number,
): string {
  if (modo === 'mes') return `Aniversários de ${monthName(mes)}`;
  if (dias == null || dias <= 0) return 'Próximo aniversário hoje';
  if (dias <= 7) return 'Próximos 7 dias';
  if (dias <= 15) return 'Próximos 15 dias';
  return 'Próximos 30 dias';
}

export function aniversarianteOccurrenceLabel(item: ClienteAniversarianteItem): string {
  return formatDueDate(item.proxima_ocorrencia_local_date) ?? birthdayLabel(item.aniversario_mmdd) ?? 'Data inválida';
}

export function birthdayToDateInput(aniversarioMmdd: string | null): string {
  if (!aniversarioMmdd) return '';
  return /^\d{2}-\d{2}$/.test(aniversarioMmdd) ? `2000-${aniversarioMmdd}` : '';
}

export function birthdayFromDateInput(value: string): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return `${match[2]}-${match[3]}`;
}

export function birthdayLabel(aniversarioMmdd: string | null): string | null {
  if (!aniversarioMmdd) return null;
  return formatDueDate(`2000-${aniversarioMmdd}`);
}

export interface ClienteDraft {
  aniversario_mmdd: string | null;
  cidade: string;
  nota_interna: string;
}

export function clienteDraftFromPerfil(cliente: ClientePerfil): ClienteDraft {
  return {
    aniversario_mmdd: cliente.aniversario_mmdd,
    cidade: cliente.cidade ?? '',
    nota_interna: cliente.nota_interna ?? '',
  };
}

export function buildClientePatchBody(draft: ClienteDraft): SaveClienteBody {
  return {
    aniversario_mmdd: draft.aniversario_mmdd,
    cidade: draft.cidade.trim() || null,
    nota_interna: draft.nota_interna.trim() || null,
  };
}

export function clienteDraftChanged(cliente: ClientePerfil, draft: ClienteDraft): boolean {
  const current = clienteDraftFromPerfil(cliente);
  return (
    current.aniversario_mmdd !== draft.aniversario_mmdd ||
    current.cidade !== draft.cidade ||
    current.nota_interna !== draft.nota_interna
  );
}
