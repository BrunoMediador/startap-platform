/**
 * Copy PT-BR das telas de erro de rota do portal (SCRUM-93).
 *
 * Centralizada aqui pra:
 *   - dar superficie testavel no harness pure-fn do portal (sem RTL/jsdom);
 *   - manter UMA fonte de verdade das mensagens (error boundary, 404 e
 *     global-error) — mesma voz de marca nas tres.
 *
 * Tom: dono de PME leigo. Honesto, sem jargao tecnico, sem stack trace, sem
 * "desculpe" repetido. Sempre oferece rota de fuga.
 */

/** Destino do "voltar ao inicio" — a home autenticada do app. */
export const HOME_HREF = '/inicio';

/** error.tsx — crash de render dentro do app autenticado. */
export const ERRO_BOUNDARY = {
  title: 'Algo deu errado por aqui.',
  description:
    'Tivemos um problema ao abrir esta tela. Você pode tentar de novo ou voltar ao início.',
  retry: 'Tentar de novo',
  home: 'Voltar ao início',
} as const;

/** not-found.tsx — URL inexistente (404). */
export const ERRO_NAO_ENCONTRADO = {
  title: 'Página não encontrada.',
  description: 'O link pode estar quebrado ou a página foi movida. Vamos te levar de volta.',
  home: 'Voltar ao início',
} as const;

/** global-error.tsx — falha no layout raiz (auto-contido). */
export const ERRO_GLOBAL = {
  title: 'Algo deu errado por aqui.',
  description: 'O portal encontrou um problema inesperado. Recarregue a página para continuar.',
  reload: 'Recarregar a página',
} as const;
