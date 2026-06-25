/**
 * Lógica pura da seção "Google Agenda" do perfil (testável, sem React/DOM).
 *
 * A credencial (e-mail + senha JÁ decriptada server-side) vem do GET
 * /portal/google-conta. O contrato:
 *   200 { google_account_email: string|null, google_account_password: string|null }
 * com header `cache-control: no-store`. A rota é gated por
 * GOOGLE_ACCOUNT_PORTAL_ENABLED (default OFF -> 404). O slot vem da sessão no
 * backend (withTenant) — o front nunca envia slot.
 *
 * Gating em duas camadas (degrada limpo, sem card vermelho):
 *   - feature OFF no backend -> 404 -> isGoogleContaFeatureOff -> some;
 *   - feature ON mas sem credencial cadastrada (campos null) -> hasCredencial=false
 *     -> some (não há o que mostrar).
 *
 * INVARIANTE DE SEGURANÇA: a SENHA do Google nunca pode entrar em log (nem em
 * erro). Nada aqui loga; quem consome (UI/hook) também não deve. As funções abaixo
 * só classificam/derivam estado — nunca imprimem o segredo.
 */
import { ApiError } from './api';
import type { GoogleContaResponse } from './api-types';

/**
 * Feature OFF: o backend devolve 404 no GET /portal/google-conta quando
 * GOOGLE_ACCOUNT_PORTAL_ENABLED está desligado. Isso NÃO é erro do cliente
 * (rede/500) — a seção deve sumir graciosamente em vez de mostrar card vermelho.
 * Mesmo critério de 404 = flag-off usado em lembretes/atendimentos.
 */
export function isGoogleContaFeatureOff(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/** Estado de UI já resolvido da credencial Google (sem nada cru/sensível além do necessário). */
export interface GoogleContaState {
  /** true só quando a feature está ON E há e-mail + senha cadastrados. */
  hasCredencial: boolean;
  email: string;
  password: string;
}

const EMPTY: GoogleContaState = { hasCredencial: false, email: '', password: '' };

/**
 * Resposta crua do backend -> estado de UI. A seção só renderiza a credencial
 * quando AMBOS e-mail e senha vêm não-vazios (feature ON + conta configurada).
 * Campos null/ausentes/em-branco => hasCredencial=false (a seção some).
 */
export function toGoogleContaState(data: GoogleContaResponse | null | undefined): GoogleContaState {
  if (!data) return { ...EMPTY };
  const email = (data.google_account_email ?? '').trim();
  const password = data.google_account_password ?? '';
  return {
    hasCredencial: email.length > 0 && password.length > 0,
    email,
    password,
  };
}

/** Conveniência: a seção deve renderizar a credencial? (feature ON + conta configurada) */
export function hasGoogleConta(data: GoogleContaResponse | null | undefined): boolean {
  return toGoogleContaState(data).hasCredencial;
}

/** Plataforma do guia "Como conectar sua agenda" — o caminho muda entre as duas. */
export type GuiaPlataforma = 'celular' | 'computador';

/**
 * "Nome do prestador de serviço" no perfil. No ESTABELECIMENTO os prestadores são os
 * COLABORADORES (geridos na Equipe), então o campo único não faz sentido e some. No
 * SOLO/individual o campo continua. Esconder no front NÃO altera o submit: o valor
 * atual segue no draft e é enviado normalmente pro backend (sem o input visível).
 */
export function showPrestadorField(productType: string | null | undefined): boolean {
  return productType !== 'estabelecimento';
}
