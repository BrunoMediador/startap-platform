import { cn } from '@/lib/cn';
/**
 * Input de texto com label, estados de foco/erro/disabled (spec 6.2).
 * Suporta prefixo/sufixo inline (R$, min) via slots. aria-invalid +
 * aria-describedby quando ha erro.
 */
import { forwardRef, useId } from 'react';

interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  prefix?: string;
  suffix?: string;
  /** Esconde visualmente o label mantendo-o pra leitores de tela. */
  hideLabel?: boolean;
}

export const Input = forwardRef<HTMLInputElement, FieldProps>(function Input(
  { label, error, prefix, suffix, hideLabel, className, id, ...props },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const errId = `${inputId}-err`;

  return (
    <div className="flex w-full flex-col gap-[7px]">
      <label
        htmlFor={inputId}
        className={cn('text-[13px] font-semibold text-ink', hideLabel && 'sr-only')}
      >
        {label}
      </label>
      <div className="relative">
        {prefix && (
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[14px] text-ink-soft">
            {prefix}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errId : undefined}
          className={cn(
            // Escuro (spec 1.A.3): input "afundado" (surface-sunken) + borda visivel,
            // hover realca a borda, foco com ring 3px brand + glow.
            'h-[50px] w-full rounded-field border-[1.5px] border-line-strong bg-surface-sunken px-3.5 text-[15px] text-ink outline-none transition-[border-color,box-shadow] duration-[120ms] placeholder:text-ink-faint',
            'hover:border-[var(--c-input-hover-border)]',
            'focus:border-brand focus:ring-[3px] focus:ring-brand/35 focus:shadow-focus',
            'disabled:cursor-not-allowed disabled:bg-bg disabled:text-ink-faint disabled:border-line',
            prefix && 'pl-[34px]',
            suffix && 'pr-12',
            error && 'border-danger',
            className,
          )}
          {...props}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[13px] text-ink-soft">
            {suffix}
          </span>
        )}
      </div>
      {error && (
        <p id={errId} className="text-[13px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
});
