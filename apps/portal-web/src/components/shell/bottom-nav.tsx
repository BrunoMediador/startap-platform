'use client';

import { cn } from '@/lib/cn';
/**
 * Bottom nav mobile (<md) — spec 6.13. Sticky bottom, blur, itens em flex-1 (NAV_ITEMS),
 * area >=44px, respeita safe-area. Some em >=md (vira sidebar). Item ativo em brand.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useConexaoNav } from './use-conexao-nav';

export function BottomNav() {
  const pathname = usePathname();
  const { visibleItems, showDot } = useConexaoNav();
  return (
    <nav
      aria-label="Navegação principal"
      className="sticky bottom-0 z-30 flex border-t border-line bg-surface/[0.92] px-1.5 pb-[calc(9px+env(safe-area-inset-bottom))] pt-[9px] backdrop-blur-md md:hidden"
    >
      {visibleItems.map((item) => {
        const { href, label, Icon } = item;
        const active = pathname === href;
        const dot = showDot(item);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              // Bottom nav (spec 1.A.8): ativo = roxo + bloco brand-soft atras do
              // icone; inativo "acende" no toque (active:bg-surface-hover).
              'group flex min-h-11 flex-1 flex-col items-center justify-center gap-1 py-1 text-[10.5px] font-semibold outline-none transition-colors focus-visible:rounded-card-sm focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset',
              active ? 'text-brand' : 'text-ink-faint active:text-ink-soft',
            )}
          >
            <span
              className={cn(
                'relative flex items-center justify-center rounded-[10px] px-3 py-0.5 transition-colors',
                active ? 'bg-brand-soft' : 'group-active:bg-surface-hover',
              )}
            >
              <Icon size={22} />
              {/* Badge-dot vermelho: WhatsApp desconectado (status != WORKING). */}
              {dot && (
                <>
                  <span
                    aria-hidden
                    className="absolute right-1.5 top-0 size-2.5 rounded-full border-2 border-surface bg-danger"
                  />
                  <span className="sr-only">(desconectado)</span>
                </>
              )}
            </span>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
