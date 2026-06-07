'use client';

import { Brandmark, IconLogout } from '@/components/icons';
import { cn } from '@/lib/cn';
import { initials } from '@/lib/format';
import { useLogout } from '@/lib/use-logout';
/**
 * Sidebar desktop (>=md) — spec 6.13. 240px, brand no topo, 4 itens como linhas,
 * ativo com bg-brand-soft + barra 3px a esquerda. Avatar do negocio + sair no
 * rodape. Escondida em <md (la vale a bottom nav).
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_ITEMS } from './nav-items';

export function Sidebar({ businessName }: { businessName: string }) {
  const pathname = usePathname();
  const { logout, pending } = useLogout();

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface md:flex">
      <div className="flex items-center gap-2.5 px-5 py-5 font-display text-[17px] font-bold tracking-[-0.01em] text-ink">
        <span className="flex size-[26px] items-center justify-center rounded-[8px] bg-brand-fill">
          <Brandmark size={14} color="#fff" />
        </span>
        Startap
      </div>

      <nav aria-label="Navegação principal" className="flex flex-1 flex-col gap-1 px-3 py-2">
        {NAV_ITEMS.map(({ href, label, Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                // Sidebar (spec 1.A.8): ativo = bloco roxo-suave + barra 3px;
                // inativo hover "acende" (surface-hover) e clareia o texto.
                'relative flex items-center gap-3 rounded-card-sm px-3 py-2.5 text-[14px] font-semibold outline-none transition-colors duration-[120ms] focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset',
                active
                  ? 'bg-brand-soft text-brand before:absolute before:left-0 before:top-1/2 before:h-5 before:w-[3px] before:-translate-y-1/2 before:rounded-r before:bg-brand'
                  : 'text-ink-soft hover:bg-surface-hover hover:text-ink',
              )}
            >
              <Icon size={20} />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-line p-3">
        <div className="flex items-center gap-3 px-2 py-2">
          <span className="flex size-9 items-center justify-center rounded-card-sm bg-brand-soft font-display text-[14px] font-bold text-brand">
            {initials(businessName)}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
            {businessName}
          </span>
        </div>
        <button
          type="button"
          onClick={logout}
          disabled={pending}
          className="mt-1 flex w-full items-center gap-2.5 rounded-card-sm px-3 py-2.5 text-[14px] font-semibold text-ink-soft outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60"
        >
          <IconLogout size={20} />
          Sair
        </button>
      </div>
    </aside>
  );
}
