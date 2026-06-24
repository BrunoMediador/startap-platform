/**
 * Card de superficie generico (spec 1.4/1.5/1.6). Base de status-hero, listas e
 * blocos. `padded` controla p-5 (default). Use `as` pra trocar o elemento raiz.
 */
import { cn } from '@/lib/cn';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  padded?: boolean;
}

export function Card({ className, padded = true, children, ...props }: CardProps) {
  return (
    <div
      className={cn(
        // Elevacao no escuro (tema unico): por tom+borda — shadow-card=none.
        'rounded-card border border-line bg-surface shadow-card',
        padded && 'p-5',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/** Card de metrica (spec 6.3): numero grande + legenda. Vira link se `href`.
 *  `className` permite ajustar o span no grid (ex.: total full-width no mobile). */
export function MetricCard({
  value,
  caption,
  href,
  ariaLabel,
  className,
}: {
  value: React.ReactNode;
  caption: string;
  href?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const inner = (
    <>
      {/* Número grande mas que QUEBRA em telas estreitas em vez de estourar a
          largura do card (valores longos como R$ 1.234,56). */}
      <div className="break-words font-display text-[26px] font-bold tracking-[-0.02em] text-ink">
        {value}
      </div>
      <div className="mt-0.5 text-[12.5px] text-ink-soft">{caption}</div>
    </>
  );
  const cls =
    'block rounded-card-sm border border-line bg-surface shadow-card p-4 transition-colors duration-[120ms]';
  if (href) {
    // Card clicavel (spec 1.A.8): hover "acende" (surface-hover) + borda forte.
    return (
      <a
        href={href}
        aria-label={ariaLabel ?? caption}
        className={cn(
          cls,
          'cursor-pointer hover:bg-surface-hover hover:border-line-strong active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
          className,
        )}
      >
        {inner}
      </a>
    );
  }
  return <div className={cn(cls, className)}>{inner}</div>;
}
