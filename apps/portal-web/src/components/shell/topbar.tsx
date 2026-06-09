'use client';

import { Brandmark, IconLogout } from '@/components/icons';
import { initials } from '@/lib/format';
import { useLogout } from '@/lib/use-logout';
/**
 * Topbar (spec 2). Mobile: brand a esquerda + avatar a direita (abre o sheet de
 * conta: toggle de tema + sair). Desktop (>=md): so o nome do negocio (marca,
 * toggle e sair ficam na sidebar). Bottom nav fica intocada (spec 1.C.2).
 */
import { useState } from 'react';
import { ThemeToggle } from './theme-toggle';

export function Topbar({ businessName }: { businessName: string }) {
  const { logout, pending } = useLogout();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-surface px-5 py-4 md:hidden">
      <div className="inline-flex items-center gap-2.5 font-display text-[17px] font-bold tracking-[-0.01em] text-ink">
        <span className="login-dot-glow flex size-[30px] items-center justify-center rounded-[9px] bg-brand-fill">
          <Brandmark size={15} color="#fff" />
        </span>
        <span>
          Start<span className="text-brand">ap</span>
        </span>
      </div>

      <div className="relative">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Menu da conta"
          onClick={() => setMenuOpen((v) => !v)}
          className="flex size-[38px] items-center justify-center rounded-[11px] border border-line-strong bg-brand-soft font-display text-[15px] font-bold text-brand outline-none transition-colors hover:bg-brand-soft-hover focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          {initials(businessName)}
        </button>
        {menuOpen && (
          <>
            {/* clique-fora fecha */}
            <button
              type="button"
              aria-hidden
              tabIndex={-1}
              className="fixed inset-0 z-20 cursor-default"
              onClick={() => setMenuOpen(false)}
            />
            <div
              role="menu"
              className="absolute right-0 top-[46px] z-30 w-60 overflow-hidden rounded-card-sm border border-line-strong bg-surface-elev shadow-elev"
            >
              <ThemeToggle variant="sheet" />
              <div className="h-px bg-line-soft" aria-hidden />
              <button
                type="button"
                role="menuitem"
                onClick={logout}
                disabled={pending}
                className="flex w-full items-center gap-2.5 px-4 py-3 text-[14px] font-semibold text-ink-soft outline-none transition-colors hover:bg-surface-elev-hover hover:text-ink focus-visible:bg-surface-elev-hover disabled:opacity-60"
              >
                <IconLogout size={18} />
                Sair
              </button>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
