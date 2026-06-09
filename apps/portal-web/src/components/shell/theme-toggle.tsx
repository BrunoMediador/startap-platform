'use client';

import { IconMoon, IconSun } from '@/components/icons';
import { cn } from '@/lib/cn';
import { type Theme, applyTheme, readTheme } from '@/lib/theme';
/**
 * Toggle de tema claro/escuro (spec 1.C.2/1.C.3).
 *  - Desktop: rodape da sidebar (variant="sidebar").
 *  - Mobile: linha dentro do sheet de conta (variant="sheet").
 * Convencao (1.C.3): mostra o icone do tema-DESTINO + label explicito.
 *   escuro ativo -> sol + "Tema claro"; claro ativo -> lua + "Tema escuro".
 * A11y: role="switch" aria-checked (checked = escuro, default/identidade),
 * aria-label dinamico, foco visivel, alvo >=44px.
 */
import { useEffect, useState } from 'react';

export function ThemeToggle({ variant }: { variant: 'sidebar' | 'sheet' }) {
  // Sincroniza com o tema ja aplicado pelo boot script (evita mismatch SSR).
  const [theme, setTheme] = useState<Theme>('dark');
  useEffect(() => {
    setTheme(readTheme());
  }, []);

  const isDark = theme === 'dark';
  const next: Theme = isDark ? 'light' : 'dark';
  const label = isDark ? 'Tema claro' : 'Tema escuro';
  const ariaLabel = isDark ? 'Mudar para tema claro' : 'Mudar para tema escuro';

  function toggle() {
    applyTheme(next);
    setTheme(next);
  }

  if (variant === 'sheet') {
    // Linha no sheet de conta (mobile) — alvo cheio, estado atual a direita.
    return (
      <button
        type="button"
        role="switch"
        aria-checked={isDark}
        aria-label={ariaLabel}
        onClick={toggle}
        className="flex min-h-12 w-full items-center gap-3.5 px-4 py-3 text-left outline-none transition-colors hover:bg-surface-elev-hover focus-visible:bg-surface-elev-hover focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[11px] bg-brand-soft text-brand">
          {isDark ? <IconSun size={18} /> : <IconMoon size={18} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-display text-[14.5px] font-semibold text-ink">Aparência</span>
          <span className="block text-[12.5px] text-ink-soft">
            {isDark ? 'Escuro (Cadência Noturna)' : 'Claro'}
          </span>
        </span>
        <span className="shrink-0 text-[13px] font-semibold text-brand">{label}</span>
      </button>
    );
  }

  // Rodape da sidebar (desktop) — botao linha com icone + label.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={ariaLabel}
      onClick={toggle}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-card-sm px-3 py-2.5 text-[14px] font-semibold text-ink-soft outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand',
      )}
    >
      {isDark ? <IconSun size={20} /> : <IconMoon size={20} />}
      {label}
    </button>
  );
}
