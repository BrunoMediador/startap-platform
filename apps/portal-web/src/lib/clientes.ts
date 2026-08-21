import type { ClientePerfil, SaveClienteBody } from './api-types';
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

export function clampClientesLimit(limit: number): number {
  if (!Number.isFinite(limit)) return CLIENTES_PAGE_SIZE;
  return Math.max(1, Math.min(100, Math.trunc(limit)));
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
