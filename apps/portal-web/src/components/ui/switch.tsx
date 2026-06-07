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
      className="group relative inline-flex h-11 w-11 shrink-0 items-center justify-center outline-none disabled:cursor-not-allowed disabled:opacity-60"
    >
      {/* Escuro (spec 1.A.8): OFF trilho afundado + borda forte + knob ink-soft;
          ON trilho roxo-acao + knob na cor do fundo. Foco visivel no trilho. */}
      <span
        className={cn(
          'relative block h-7 w-[46px] rounded-pill border transition-colors duration-[180ms] ease-[var(--ease-out-soft)] group-focus-visible:ring-2 group-focus-visible:ring-brand group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-bg',
          checked ? 'border-brand bg-brand' : 'border-line-strong bg-surface-sunken',
        )}
      >
        <span
          className={cn(
            'absolute top-[3px] size-[22px] rounded-full transition-[left,background-color] duration-[180ms] ease-[var(--ease-out-soft)]',
            checked ? 'left-[21px] bg-bg' : 'left-[3px] bg-ink-soft',
          )}
        />
      </span>
    </button>
  );
}
