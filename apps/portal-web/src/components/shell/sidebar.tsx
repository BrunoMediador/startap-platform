'use client';

import { Brandmark, IconLogout } from '@/components/icons';
import { cn } from '@/lib/cn';
import { initials } from '@/lib/format';
import { useLogout } from '@/lib/use-logout';
/**
 * Sidebar desktop (>=md) — spec 6.13 + polish 1.D.7.
 *
 * BLOCO A (fix): a sidebar agora e `sticky top-0 h-dvh` (antes esticava com o
 * conteudo e empurrava o rodape "Sair" pro fim do scroll). O <nav> rola
 * internamente (`overflow-y-auto`); o rodape (avatar + nome + sair) fica SEMPRE
 * visivel, independente do tamanho da lista. Sidebar e a coluna de conteudo sao
 * irmaos num flex row (ver layout do grupo (app)).
 *
 * 1.D.7: brandmark com glow, item ativo com barra 3px. Rodape SEM rotulo de
 * plano (decisao Bruno — nao ha planos ainda) e SEM toggle de tema (o app e
 * sempre escuro): so avatar + nome + sair.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_ITEMS } from './nav-items';

export function Sidebar({ businessName }: { businessName: string }) {
  const pathname = usePathname();
  const { logout, pending } = useLogout();

  return (
    <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line bg-surface md:flex">
      {/* Brandmark com glow (1.D.7) — eco do dot do login. */}
      <div className="flex items-center gap-2.5 border-b border-line-soft px-5 py-5 font-display text-[17px] font-bold tracking-[-0.01em] text-ink">
        <span className="login-dot-glow flex size-[30px] items-center justify-center rounded-[9px] bg-brand-fill">
          <Brandmark size={15} color="#fff" />
        </span>
        <span>
          Start<span className="text-brand">ap</span>
        </span>
      </div>

      {/* nav rola internamente se a lista crescer — rodape nunca some (BLOCO A). */}
      <nav
        aria-label="Navegação principal"
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 py-3"
      >
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
                'relative flex items-center gap-3 rounded-card-sm px-3 py-2.5 font-display text-[14px] font-semibold outline-none transition-colors duration-[120ms] focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset',
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

      <div className="shrink-0 border-t border-line-soft p-3">
        {/* Rodape: avatar + nome do negocio (sem rotulo de plano — decisao Bruno). */}
        <div className="flex items-center gap-3 px-2 py-2">
          <span className="flex size-9 items-center justify-center rounded-card-sm border border-line-strong bg-brand-soft font-display text-[14px] font-bold text-brand">
            {initials(businessName)}
          </span>
          <span className="min-w-0 flex-1 truncate font-display text-[13.5px] font-semibold text-ink">
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
