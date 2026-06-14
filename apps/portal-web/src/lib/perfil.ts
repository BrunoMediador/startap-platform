/**
 * Validacao + normalizacao client-side do perfil do negocio (tela Meu negocio).
 *
 * Espelha o contrato do portal-api (GET/PUT /portal/perfil): seis campos string,
 * TODOS opcionais (podem vir/ir vazios — o cliente preenche aos poucos). O slot
 * NUNCA viaja no body — vem da sessao no backend (withTenant).
 *
 * Regras (suaves de proposito — perfil nao bloqueia o robo):
 *  - todos os campos sao trimados;
 *  - limites de tamanho generosos pra evitar abuso/payload gigante;
 *  - Instagram: aceita com ou sem "@" e tambem URL colada; guardamos o handle
 *    sem "@" (o backend faz o mesmo). So validamos o formato do handle, nao se
 *    a conta existe.
 * Erro inline aqui evita bater na API pra tomar 400.
 */
import type { PerfilNegocio } from './api-types';

export interface PerfilDraft {
  nome_negocio: string;
  nome_prestador: string;
  telefone_contato: string;
  endereco: string;
  instagram: string;
  formas_pagamento: string;
}

export type PerfilField = keyof PerfilDraft;
export type PerfilErrors = Partial<Record<PerfilField, string>>;

/** Campos do perfil na ordem em que aparecem no form. */
export const PERFIL_FIELDS: PerfilField[] = [
  'nome_negocio',
  'nome_prestador',
  'telefone_contato',
  'endereco',
  'instagram',
  'formas_pagamento',
];

const MAX = {
  nome_negocio: 120,
  nome_prestador: 120,
  telefone_contato: 40,
  endereco: 240,
  instagram: 80,
  formas_pagamento: 240,
} as const satisfies Record<PerfilField, number>;

const LABEL: Record<PerfilField, string> = {
  nome_negocio: 'Nome do negócio',
  nome_prestador: 'Nome do prestador de serviço',
  telefone_contato: 'Telefone',
  endereco: 'Endereço',
  instagram: 'Instagram',
  formas_pagamento: 'Formas de pagamento',
};

const EMPTY: PerfilDraft = {
  nome_negocio: '',
  nome_prestador: '',
  telefone_contato: '',
  endereco: '',
  instagram: '',
  formas_pagamento: '',
};

/** Converte a resposta da API em draft de edicao (campos ausentes -> ''). */
export function toPerfilDraft(p: Partial<PerfilNegocio> | undefined | null): PerfilDraft {
  if (!p) return { ...EMPTY };
  return {
    nome_negocio: p.nome_negocio ?? '',
    nome_prestador: p.nome_prestador ?? '',
    telefone_contato: p.telefone_contato ?? '',
    endereco: p.endereco ?? '',
    instagram: p.instagram ?? '',
    formas_pagamento: p.formas_pagamento ?? '',
  };
}

/**
 * Normaliza o handle do Instagram: tira espacos, "@" inicial e o prefixo de URL
 * (instagram.com/...). Devolve so o handle (ex.: "barbearia.do.ze"). String vazia
 * permanece vazia.
 */
export function normalizeInstagram(raw: string): string {
  let v = raw.trim();
  if (v.length === 0) return '';
  // remove protocolo + dominio se colaram a URL do perfil
  v = v.replace(/^https?:\/\//i, '').replace(/^(www\.)?instagram\.com\//i, '');
  // remove query/fragment e barra final
  v = v.split(/[?#/]/)[0];
  // remove "@" inicial (aceitamos com ou sem)
  v = v.replace(/^@+/, '');
  return v;
}

const INSTAGRAM_HANDLE = /^[A-Za-z0-9._]+$/;

/**
 * Valida + normaliza o draft inteiro. Em sucesso devolve o payload pronto pro PUT
 * (mesmo shape do GET). Em falha, erros por campo.
 */
export function validatePerfil(
  d: PerfilDraft,
): { ok: true; value: PerfilNegocio } | { ok: false; errors: PerfilErrors } {
  const errors: PerfilErrors = {};
  const out: PerfilDraft = { ...EMPTY };

  for (const f of PERFIL_FIELDS) {
    const trimmed = d[f].trim();
    if (trimmed.length > MAX[f]) {
      errors[f] = `${LABEL[f]} é muito longo (máx. ${MAX[f]} caracteres)`;
    }
    out[f] = trimmed;
  }

  // Instagram tem normalizacao + checagem de formato do handle.
  const handle = normalizeInstagram(d.instagram);
  out.instagram = handle;
  if (handle.length > 0) {
    if (handle.length > MAX.instagram) {
      errors.instagram = `${LABEL.instagram} é muito longo (máx. ${MAX.instagram} caracteres)`;
    } else if (!INSTAGRAM_HANDLE.test(handle)) {
      errors.instagram = 'Use só o nome do perfil (ex.: barbearia.do.ze), sem espaços';
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: out };
}

/** True quando o draft difere do salvo (libera o botao Salvar). */
export function isDirty(draft: PerfilDraft, saved: PerfilDraft): boolean {
  return PERFIL_FIELDS.some((f) => draft[f].trim() !== saved[f].trim());
}
