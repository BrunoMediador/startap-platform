/**
 * Tema claro/escuro (spec 1.C). Escuro "Cadencia Noturna" e o DEFAULT; claro e
 * opcional. NAO segue prefers-color-scheme do SO (decisao do Bruno, 1.C.1) — todo
 * cliente comeca na identidade Noturna ate escolher.
 *
 * Persistencia: localStorage chave `startap-theme` ("dark"|"light"). O boot script
 * (THEME_BOOT_SCRIPT) aplica o atributo no <html> ANTES do paint pra evitar flash
 * (1.C.1). Este modulo so toca o DOM no client.
 */

export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'startap-theme';
export const DEFAULT_THEME: Theme = 'dark';

/**
 * Script sincrono injetado no <head> (antes do CSS pintar) pra setar
 * data-theme em document.documentElement e evitar FOUC (spec 1.C.1).
 * Self-contained — nao depende de nada do bundle. Falha silenciosa cai no escuro.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t!=='light'&&t!=='dark')t='${DEFAULT_THEME}';document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','${DEFAULT_THEME}');}})();`;

/** Le o tema atual do DOM (client). Fallback no default. */
export function readTheme(): Theme {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  const attr = document.documentElement.getAttribute('data-theme');
  return attr === 'light' ? 'light' : 'dark';
}

/**
 * Aplica o tema: seta data-theme no <html>, persiste e dispara a transicao
 * suave de 180ms (spec 1.C.1) — exceto em reduced-motion (instantaneo).
 */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;

  const prefersReduced =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!prefersReduced) {
    root.classList.add('theme-transition');
    window.setTimeout(() => root.classList.remove('theme-transition'), 220);
  }

  root.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // localStorage indisponivel (modo privado): tema vale so na sessao atual.
  }
}
