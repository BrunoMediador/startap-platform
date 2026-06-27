'use client';

/**
 * Shell do painel READ-ONLY do colaborador (SCRUM-32). Bem mais enxuto que o shell
 * do dono: NÃO tem sidebar, bottom-nav do dono, nem ações de gestão — só a marca, o
 * nome do colaborador + selo "Somente leitura", o botão Sair e duas abas
 * (Agenda / Faturamento). Mobile-first; no desktop centraliza num container estreito.
 */
import { Brandmark, IconCalendar, IconLogout, IconWallet } from '@/components/icons';
import { cn } from '@/lib/cn';
import { COLABORADOR_NAV } from '@/lib/colaborador';
import { useLogout } from '@/lib/use-logout';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_ICON: Record<string, React.ReactNode> = {
  '/colaborador/agenda': <IconCalendar size={17} />,
  '/colaborador/comissao': <IconWallet size={17} />,
};

export function ColaboradorShell({
  displayName,
  children,
}: {
  displayName: string;
  children: React.ReactNode;
}) {
  const { logout, pending } = useLogout();
  const pathname = usePathname();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 border-b border-line bg-surface px-5 pb-0 pt-[calc(14px+env(safe-area-inset-top))]">
        <div className="mx-auto flex w-full max-w-[720px] items-center justify-between gap-3">
          <div className="inline-flex items-center gap-2 font-display text-[17px] font-bold tracking-[-0.01em] text-ink">
            <Brandmark size={28} />
            <span>
              Start<span className="text-brand">ap</span>
            </span>
          </div>

          <div className="flex items-center gap-2.5">
            <div className="hidden min-w-0 flex-col items-end sm:flex">
              <span className="max-w-[180px] truncate text-[13px] font-semibold text-ink">
                {displayName}
              </span>
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                Somente leitura
              </span>
            </div>
            <button
              type="button"
              onClick={logout}
              disabled={pending}
              aria-label="Sair"
              className="flex h-9 items-center gap-1.5 rounded-pill border border-line-strong bg-surface px-3 font-display text-[13px] font-semibold text-ink-soft outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:opacity-60"
            >
              <IconLogout size={17} />
              <span className="hidden sm:inline">Sair</span>
            </button>
          </div>
        </div>

        {/* Abas read-only (Agenda / Faturamento). */}
        <nav
          aria-label="Seções do colaborador"
          className="mx-auto flex w-full max-w-[720px] gap-1 pt-2"
        >
          {COLABORADOR_NAV.map((item) => {
            const ativo = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={ativo ? 'page' : undefined}
                className={cn(
                  'inline-flex items-center gap-1.5 border-b-2 px-3.5 pb-2.5 pt-1 font-display text-[14px] font-semibold outline-none transition-colors focus-visible:rounded-t-[8px] focus-visible:ring-2 focus-visible:ring-brand',
                  ativo
                    ? 'border-brand text-ink'
                    : 'border-transparent text-ink-soft hover:text-ink',
                )}
              >
                {NAV_ICON[item.href]}
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>

      <main className="mx-auto w-full max-w-[720px] flex-1 px-5 pb-[calc(28px+env(safe-area-inset-bottom))] pt-[18px]">
        {children}
      </main>
    </div>
  );
}
