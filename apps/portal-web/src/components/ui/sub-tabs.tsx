'use client';

/**
 * Barra de sub-abas de "Meu negócio"/"Meu atendente" (SCRUM-157). Navegação
 * entre ROTAS REAIS (cada aba é uma URL própria) — por isso é `<nav>` + `<Link>`
 * + `aria-current="page"`, NUNCA `role="tablist"`: tablist diria pro leitor de
 * tela que isto é um conjunto de painéis que trocam de conteúdo sem navegar,
 * o que seria falso aqui (são páginas). `components/atendimentos/billing-tabs.tsx`
 * usa tablist e está CERTO lá — ali é um segmented control que troca o estado de
 * UM componente, não navega. Reaproveitamos só o VISUAL do estado ativo daquele
 * padrão, nunca a semântica de aba.
 *
 * Visual: mesmas classes de chip do `PerfilMiniNav` (perfil/page.tsx), sticky
 * logo abaixo da topbar mobile / no topo no desktop, scroll horizontal sem
 * barra de rolagem visível. Zero token novo.
 *
 * Aba única visível = a barra não renderiza (navegação de 1 item é ruído).
 */
import { cn } from '@/lib/cn';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface SubTabItem {
  href: string;
  label: string;
}

export function SubTabs({ items }: { items: SubTabItem[] }) {
  const pathname = usePathname();

  if (items.length <= 1) return null;

  return (
    <nav
      aria-label="Sub-navegação desta tela"
      className="sticky top-[var(--topbar-h)] z-10 -mx-5 mb-5 border-b border-line bg-bg/95 px-5 py-2.5 backdrop-blur-sm md:top-0"
    >
      <ul className="flex gap-2 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item) => {
          const active = pathname === item.href;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex h-9 items-center whitespace-nowrap rounded-full border px-3.5 font-display text-[13px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                  active
                    ? 'border-brand bg-brand text-bg'
                    : 'border-line-strong bg-surface text-ink-soft hover:bg-surface-hover hover:text-ink',
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
