/**
 * Lógica pura do colaborador (SCRUM-32). Vive fora do React pra ser testável sem
 * jsdom (convenção do portal). O ponto crítico aqui é o ROTEAMENTO pós-login:
 * owner e colaborador NÃO podem cair na área um do outro.
 */
import type { LoginRole } from './api-types';

/** Home read-only do colaborador (a agenda dele). */
export const COLABORADOR_HOME = '/colaborador/agenda';

/** Home do dono (fluxo de hoje). */
export const OWNER_HOME = '/inicio';

/**
 * Para onde redirecionar após um login bem-sucedido, a partir do `role` que o
 * portal-api devolve. Apenas o role EXPLÍCITO 'colaborador' leva à área read-only;
 * QUALQUER outra coisa (ausente, 'owner', valor inesperado) cai no fluxo do dono.
 * Assim, owners legados pré-#394 (sem campo `role`) seguem indo pra /inicio, e um
 * valor inesperado nunca "vaza" o dono pra dentro do painel do colaborador.
 */
export function loginRedirectPath(role: LoginRole | string | undefined | null): string {
  return role === 'colaborador' ? COLABORADOR_HOME : OWNER_HOME;
}

/** Itens de navegação do shell read-only do colaborador (sem ações do dono). */
export function getColaboradorNav(crmClientesEnabled: boolean) {
  return [
    { href: '/colaborador/agenda', label: 'Agenda' },
    ...(crmClientesEnabled
      ? ([{ href: '/colaborador/clientes', label: 'Clientes' }] as const)
      : []),
    { href: '/colaborador/comissao', label: 'Faturamento' },
  ] as const;
}

export const COLABORADOR_NAV = getColaboradorNav(false);
