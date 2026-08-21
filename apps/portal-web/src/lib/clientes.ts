import { formatDueDate } from './format';

export const CLIENTES_PAGE_SIZE = 10;

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
  const params = new URLSearchParams({
    page: String(clampClientesPage(page)),
    per_page: String(pageSize),
  });
  const q = sanitizeClientesSearch(search);
  if (q) params.set('q', q);
  return params.toString();
}

export function clienteDisplayName(nome: string | null): string {
  const clean = nome?.trim();
  return clean ? clean : 'Cliente sem nome';
}

export function birthdayToDateInput(aniversario: string | null): string {
  if (!aniversario) return '';
  return /^\d{2}-\d{2}$/.test(aniversario) ? `2000-${aniversario}` : '';
}

export function birthdayFromDateInput(value: string): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return `${match[2]}-${match[3]}`;
}

export function birthdayLabel(aniversario: string | null): string | null {
  if (!aniversario) return null;
  return formatDueDate(`2000-${aniversario}`);
}
