'use client';

import { cn } from '@/lib/cn';
/**
 * Bottom nav mobile (<md) — spec 6.13. Sticky bottom, blur, area >=44px, respeita
 * safe-area. Some em >=md (vira sidebar). Item ativo em brand.
 *
 * Largura adaptativa por nº de itens (mobile-first): até 5 itens cabem confortáveis
 * em flex-1 (distribuição uniforme, sem scroll). A partir de 6 (estabelecimento +
 * Billing chegam a 9 itens) a barra vira ROLAGEM HORIZONTAL com itens de largura
 * fixa (min-w ~62px) — cada item segue tappable (>=44px) e o rótulo ("Meu negócio",
 * "Mensalidade") deixa de espremer/quebrar. snap pra parar alinhado em cada item.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useConexaoNav } from './use-conexao-nav';

export function BottomNav() {
  const pathname = usePathname();
  const { visibleItems, showDot } = useConexaoNav();
  // >5 itens não cabem confortáveis no viewport mais estreito (~360px): rola.
  const rola = visibleItems.length > 5;
  return (
    <nav
      aria-label="Navegação principal"
      className={cn(
        'sticky bottom-0 z-30 flex border-t border-line bg-surface/[0.92] px-1.5 pb-[calc(9px+env(safe-area-inset-bottom))] pt-[9px] backdrop-blur-md md:hidden',
        // Poucos itens: distribui no full-width. Muitos: rola na horizontal com snap,
        // escondendo a barra de rolagem (scrollbar-none).
        rola &&
          'snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
      )}
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
              'group flex min-h-11 flex-col items-center justify-center gap-1 py-1 text-[10.5px] font-semibold outline-none transition-colors focus-visible:rounded-card-sm focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset',
              // Poucos itens -> flex-1 (uniforme). Muitos -> largura fixa + snap pra rolar.
              rola ? 'w-[62px] shrink-0 snap-start px-0.5' : 'flex-1',
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
            {/* Rótulo numa linha só: trunca em vez de quebrar e desalinhar a altura
                dos itens (ex.: "Meu negócio"/"Mensalidade" no estabelecimento). */}
            <span className="max-w-full truncate px-0.5 leading-none">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
