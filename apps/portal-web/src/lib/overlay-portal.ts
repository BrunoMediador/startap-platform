/**
 * Alvo do portal do Overlay.
 *
 * O Overlay usa `position: fixed inset-0` e PRECISA ancorar na viewport. Se renderizar
 * inline, qualquer ancestral com `transform` (ex.: o wrapper `.stagger` da Início, que
 * retém `translateY(0)` por `animation-fill-mode: forwards`) vira containing block do
 * fixed e CORTA o sheet quando a página está rolada. Teleportar pro <body> tira o
 * overlay de qualquer pai transformado.
 *
 * Esta função isola a decisão "para onde portalar" para que seja testável sem DOM real:
 * - no client (com document) → document.body;
 * - sem document (SSR / ambiente node) → null (componente não portala, retorna null).
 */
export function getOverlayPortalTarget(doc: Document | undefined): HTMLElement | null {
  if (!doc?.body) return null;
  return doc.body;
}
