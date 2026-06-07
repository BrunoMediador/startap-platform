import { cn } from '@/lib/cn';
/**
 * Botao (spec 6.1). Variantes: primary | secondary | destructive | ghost.
 * Estados: hover, active (scale .98), focus (ring), disabled, loading (spinner +
 * aria-busy, mantem largura). Alvo de toque >=44px (h-11 inline ou h-[52px] full).
 */
import { forwardRef } from 'react';

type Variant = 'primary' | 'secondary' | 'destructive' | 'ghost';
type Size = 'full' | 'inline';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  loadingLabel?: string;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-brand text-white hover:bg-brand-700 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:bg-brand/40 disabled:text-white/70',
  secondary:
    'bg-surface text-brand border border-line hover:bg-brand-50 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:text-ink-faint disabled:border-line disabled:opacity-60',
  destructive:
    'bg-surface text-danger border border-danger/30 hover:bg-danger/10 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-2 disabled:opacity-60',
  ghost:
    'bg-transparent text-brand hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:opacity-50',
};

const SIZES: Record<Size, string> = {
  full: 'h-[52px] w-full px-5',
  inline: 'h-11 px-5',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'full',
    loading,
    loadingLabel,
    className,
    children,
    disabled,
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={props.type ?? 'button'}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-btn font-display text-[15px] font-semibold transition-[transform,background-color] duration-[120ms] outline-none disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? (
        <>
          <span
            className="size-[18px] shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin-token"
            aria-hidden
          />
          {loadingLabel ?? 'Salvando…'}
        </>
      ) : (
        children
      )}
    </button>
  );
});
