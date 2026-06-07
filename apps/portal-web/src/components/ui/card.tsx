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

/** Card de metrica (spec 6.3): numero grande + legenda. Vira link se `href`. */
export function MetricCard({
  value,
  caption,
  href,
  ariaLabel,
}: {
  value: React.ReactNode;
  caption: string;
  href?: string;
  ariaLabel?: string;
}) {
  const inner = (
    <>
      <div className="font-display text-[26px] font-bold tracking-[-0.02em] text-ink">{value}</div>
      <div className="mt-0.5 text-[12.5px] text-ink-soft">{caption}</div>
    </>
  );
  const cls =
    'block rounded-card-sm border border-line bg-surface p-4 transition-colors duration-[120ms]';
  if (href) {
    return (
      <a
        href={href}
        aria-label={ariaLabel ?? caption}
        className={cn(
          cls,
          'hover:bg-brand-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2',
        )}
      >
        {inner}
      </a>
    );
  }
  return <div className={cls}>{inner}</div>;
}
