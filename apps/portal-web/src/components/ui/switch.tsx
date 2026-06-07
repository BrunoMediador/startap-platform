'use client';

/**
 * Switch (spec 6.11). role=switch + aria-checked. Trilho 46x28, knob 22.
 * Grade usa cor brand (D4: acao do usuario, nao status de sistema). Off = line.
 * Area de toque >=44px via padding invisivel no wrapper.
 */
import { cn } from '@/lib/cn';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-11 w-11 shrink-0 items-center justify-center outline-none disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span
        className={cn(
          'relative block h-7 w-[46px] rounded-pill transition-colors duration-[180ms] ease-[var(--ease-out-soft)]',
          checked ? 'bg-brand' : 'bg-line',
        )}
      >
        <span
          className={cn(
            'absolute top-[3px] size-[22px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.2)] transition-[left] duration-[180ms] ease-[var(--ease-out-soft)]',
            checked ? 'left-[21px]' : 'left-[3px]',
          )}
        />
      </span>
    </button>
  );
}
