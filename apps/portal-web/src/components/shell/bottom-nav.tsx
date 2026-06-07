'use client';

import { cn } from '@/lib/cn';
/**
 * Bottom nav mobile (<md) — spec 6.13. Sticky bottom, blur, 4 itens, area >=44px,
 * respeita safe-area. Some em >=md (vira sidebar). Item ativo em brand.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_ITEMS } from './nav-items';

export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Navegação principal"
      className="sticky bottom-0 z-30 flex border-t border-line bg-surface/[0.92] px-1.5 pb-[calc(9px+env(safe-area-inset-bottom))] pt-[9px] backdrop-blur-md md:hidden"
    >
      {NAV_ITEMS.map(({ href, label, Icon }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex min-h-11 flex-1 flex-col items-center justify-center gap-1 py-1 text-[10.5px] font-semibold outline-none focus-visible:rounded-card-sm focus-visible:ring-2 focus-visible:ring-brand',
              active ? 'text-brand' : 'text-ink-faint',
            )}
          >
            <Icon size={22} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
